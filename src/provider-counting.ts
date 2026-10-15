import type { ContextFile } from "./adapters.js";
import { geminiContextFiles, geminiSettingsPath } from "./gemini-settings.js";
import { readBlobs } from "./git.js";
import type { BlobMeasurement, TrackedFile } from "./inventory.js";
import { createMeasurer, modeForModel } from "./measurement.js";
import {
  type CountedProvider,
  type CountMethod,
  cacheFamily,
  countRemoteText,
  describeMethod,
  type ProviderCountPlan,
  type ProviderMeasurementMetadata,
  type ProviderTextCount,
  type RemoteMethod,
  type RemoteProvider,
} from "./provider-count.js";

export const countedOrder = ["claude", "gemini", "codex"] as const satisfies readonly CountedProvider[];

export const providerName: Record<CountedProvider, string> = { claude: "Claude", gemini: "Gemini", codex: "Codex" };

const providerRequestConcurrency = 8;

/**
 * The providers to count a file under: its own provider, or a shared file's readers. A Gemini
 * context file is counted for Gemini only when its blob is present in some revision whose settings
 * make Gemini read it, so versions Gemini never reads are not sent to its API.
 */
export function countedProviders(
  file: TrackedFile,
  counted: readonly CountedProvider[],
  geminiBlobs: Set<string>,
): CountedProvider[] {
  const { provider, instructionalText, readers = [], contextFile } = file.classification;
  if (!instructionalText) return [];
  const read = new Set(provider === "shared" ? readers : [provider]);
  if (contextFile) {
    if (geminiBlobs.has(file.blob)) read.add("gemini");
    else read.delete("gemini");
  }
  return counted.filter((provider) => read.has(provider));
}

/** Resolve each distinct root Gemini settings blob to the context files it configures. */
export function geminiSettings(
  root: string,
  files: TrackedFile[],
  measured: Map<string, BlobMeasurement>,
): Map<string, ContextFile[] | null> {
  const blobs = [...new Set(files.filter((file) => file.path === geminiSettingsPath).map((file) => file.blob))];
  const decoder = new TextDecoder();
  const configured = new Map<string, ContextFile[] | null>();
  for (const [blob, body] of readBlobs(root, blobs, (id) => measured.get(id)?.bytes ?? 0)) {
    configured.set(blob, geminiContextFiles(decoder.decode(body)));
  }
  return configured;
}

function encodingFor(model: string): string {
  return modeForModel(model).replace("openai-", "");
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** The one-letter text whose count, less its one token, measures a count endpoint's message wrapper. */
const wrapperProbe = "a";

interface MethodCounts {
  counts: Map<string, ProviderTextCount>;
  /** The method label, which names the wrapper once one is subtracted. */
  method: string;
  wrapperTokens?: number;
}

/** A method's failure, with whether it had already sent instruction text, so a report can still disclose it. */
type CountFailure = Error & { reason?: string; sentText?: boolean };

/** Git object IDs in an error would survive `--shareable`, so recorded reasons leave them out. */
const withoutObjectIds = (reason: string) => reason.replace(/\b[0-9a-f]{40}(?:[0-9a-f]{24})?\b/g, "<object>");

/**
 * Count one provider's distinct blobs with one method. Remote counts come from the cache when it has
 * them; the rest are requested with bounded concurrency and added to the cache as they arrive.
 */
async function countWithMethod(
  root: string,
  provider: CountedProvider,
  method: Exclude<CountMethod, { kind: "unavailable" }>,
  wanted: Map<string, string>,
  measured: Map<string, BlobMeasurement>,
  plan: ProviderCountPlan,
  onNotice: ((line: string) => void) | undefined,
): Promise<MethodCounts> {
  const local = method.kind === "local" ? createMeasurer(modeForModel(method.model), method.model) : null;
  const labels = describeMethod(method, local?.measurement.encoding ?? undefined);
  const counts = new Map<string, ProviderTextCount>();
  let methodText = labels.method;
  if (method.kind === "estimate") {
    for (const blob of wanted.keys()) counts.set(blob, count(Math.ceil(measured.get(blob)!.bytes / 4)));
    return { counts, method: methodText };
  }
  const remote = method.kind === "local" ? null : method;
  const cacheKey = remote ? `${cacheFamily(remote)}\0${remote.model}\0` : "";
  let wrapperTokens: number | undefined;
  const toRead = [...wanted.keys()];
  if (remote) {
    const name = providerName[provider];
    let retried = false;
    const remoteOptions = {
      ...(plan.fetchImpl ? { fetchImpl: plan.fetchImpl } : {}),
      ...(plan.sleep ? { sleep: plan.sleep } : {}),
      onRetry: (status: number | "connection", wait: number) => {
        if (retried) return;
        retried = true;
        onNotice?.(
          `${name} count endpoint ${status === "connection" ? "could not be reached" : `returned HTTP ${status}`}; retrying with backoff (first wait ${Math.ceil(wait / 1000)} s).`,
        );
      },
    };
    const cachedRaw = (key: string) => plan.cache?.get(cacheKey + key);
    toRead.length = 0;
    for (const blob of wanted.keys()) {
      const raw = cachedRaw(blob);
      if (raw === undefined) toRead.push(blob);
    }
    const cachedCount = wanted.size - toRead.length;
    // The probe carries only the letter "a", so it may precede the notice about instruction text.
    if (plan.subtractWrapper) {
      let raw = cachedRaw("wrapper");
      if (raw === undefined) {
        try {
          raw = await countRemoteText(provider as RemoteProvider, remote, wrapperProbe, remoteOptions);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw Object.assign(new Error(`Could not measure the ${name} message wrapper: ${reason}`), { reason });
        }
        plan.cache?.set(`${cacheKey}wrapper`, raw);
      }
      wrapperTokens = Math.max(0, raw - 1);
      if (wrapperTokens) methodText += `, less the ${wrapperTokens}-token message wrapper measured by counting "a"`;
    }
    onNotice?.(
      toRead.length
        ? `Sending ${plural(toRead.length, `${name} instruction file version`)} to ${labels.recipient} to count with ${labels.model}, using ${labels.credential}${cachedCount ? `; ${cachedCount} more counted before, from the local cache` : ""}.`
        : `Using cached ${name} counts for all ${plural(cachedCount, "instruction file version")}; no instruction text sent.`,
    );
    for (const blob of wanted.keys()) {
      const raw = cachedRaw(blob);
      if (raw !== undefined) counts.set(blob, count(Math.max(0, raw - (wrapperTokens ?? 0))));
    }
    await requestAll(remote, remoteOptions);
  } else {
    for (const [blob, body] of readBlobs(root, toRead, (id) => measured.get(id)?.bytes ?? 0)) {
      try {
        counts.set(blob, count(local!.count(body)));
      } catch (error) {
        throw failure(blob, error);
      }
    }
  }
  return { counts, method: methodText, ...(wrapperTokens !== undefined ? { wrapperTokens } : {}) };

  function count(tokens: number): ProviderTextCount {
    return {
      tokens,
      provider,
      model: labels.model,
      method: methodText,
      version: labels.version,
      accuracy: labels.accuracy,
    };
  }

  function failure(blob: string, error: unknown): CountFailure {
    const reason = error instanceof Error ? error.message : String(error);
    return Object.assign(new Error(`Could not count ${provider} instructions at ${wanted.get(blob)}: ${reason}`), {
      reason,
    });
  }

  async function requestAll(remote: RemoteMethod, remoteOptions: Parameters<typeof countRemoteText>[3]) {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const running = new Set<Promise<void>>();
    let failed: CountFailure | undefined;
    let sentText = false;
    let current = "";
    try {
      for (const [blob, body] of readBlobs(root, toRead, (id) => measured.get(id)?.bytes ?? 0)) {
        current = blob;
        const text = decoder.decode(body);
        // Count endpoints reject blank text, and it has nothing to count: zero, without a request.
        if (!text.trim()) {
          counts.set(blob, count(0));
          continue;
        }
        sentText = true;
        const task: Promise<void> = countRemoteText(provider as RemoteProvider, remote, text, remoteOptions)
          .then(
            (raw) => {
              plan.cache?.set(cacheKey + blob, raw);
              counts.set(blob, count(Math.max(0, raw - (wrapperTokens ?? 0))));
            },
            (error) => {
              failed ??= failure(blob, error);
            },
          )
          .finally(() => running.delete(task));
        running.add(task);
        if (running.size >= providerRequestConcurrency) await Promise.race(running);
        if (failed) break;
      }
    } catch (error) {
      failed ??= failure(current, error);
    } finally {
      // Requests already in flight finish before the next method starts.
      await Promise.allSettled(running);
    }
    if (failed) throw Object.assign(failed, { sentText });
  }
}

/** What a dry run reports for one provider: the method it would use and what would leave the machine. */
function previewMethod(
  provider: CountedProvider,
  method: Exclude<CountMethod, { kind: "unavailable" }>,
  wanted: Map<string, string>,
  plan: ProviderCountPlan,
): string {
  const name = providerName[provider];
  const files = plural(wanted.size, "instruction file version");
  if (method.kind === "estimate") return `${name}: would use the byte estimate for ${files}; nothing sent.`;
  if (method.kind === "local") {
    return `${name}: would count ${files} locally with ${method.model} (${encodingFor(method.model)}); nothing sent.`;
  }
  const labels = describeMethod(method);
  const cacheKey = `${cacheFamily(method)}\0${method.model}\0`;
  const cached = [...wanted.keys()].filter((blob) => plan.cache?.get(cacheKey + blob) !== undefined).length;
  const sending = wanted.size - cached;
  return `${name}: would send ${plural(sending, "instruction file version")} to ${labels.recipient} to count with ${labels.model}, using ${labels.credential}${cached ? `; ${cached} cached` : ""}.`;
}

/**
 * Count each provider's distinct blobs once across the given files. A provider's methods are tried
 * in order; if one fails, its partial counts are discarded and the next is tried, so one provider's
 * counts never mix methods. The last method's failure is fatal. A provider with no instructions
 * among the files is skipped without looking up its credentials.
 */
export async function countProviderBlobs(
  root: string,
  files: TrackedFile[],
  measured: Map<string, BlobMeasurement>,
  plan: ProviderCountPlan,
  geminiBlobs: Set<string>,
  onNotice: ((line: string) => void) | undefined,
): Promise<{ counts: Map<string, ProviderTextCount>; metadata: ProviderMeasurementMetadata[] }> {
  const counted = countedOrder.filter((provider) => plan.methods[provider]);
  const wanted = new Map<CountedProvider, Map<string, string>>(counted.map((provider) => [provider, new Map()]));
  for (const file of files) {
    for (const provider of countedProviders(file, counted, geminiBlobs)) {
      const blobs = wanted.get(provider)!;
      if (!blobs.has(file.blob)) blobs.set(file.blob, file.path);
    }
  }

  const counts = new Map<string, ProviderTextCount>();
  const metadata: ProviderMeasurementMetadata[] = [];
  for (const provider of counted) {
    const blobs = wanted.get(provider)!;
    // A provider with no instructions anywhere in the history needs no credential and gets no column.
    if (!blobs.size) continue;
    const planned = plan.methods[provider]!;
    const methods = typeof planned === "function" ? planned() : planned;
    if (plan.dryRun) {
      const chosen = methods.find(
        (method): method is Exclude<CountMethod, { kind: "unavailable" }> => method.kind !== "unavailable",
      );
      if (chosen) {
        const skipped = methods
          .slice(0, methods.indexOf(chosen))
          .flatMap((method) => (method.kind === "unavailable" ? [method.reason] : []));
        onNotice?.(previewMethod(provider, chosen, blobs, plan));
        for (const reason of skipped) onNotice?.(`  Skipped: ${reason}.`);
      }
      continue;
    }
    const fallbacks: string[] = [];
    // Hosts that received instruction text from a method that then failed: still disclosed.
    const alsoSentTo = new Set<string>();
    let last: Error | undefined;
    for (const method of methods) {
      if (method.kind === "unavailable") {
        fallbacks.push(method.reason);
        continue;
      }
      const labels = describeMethod(method, method.kind === "local" ? encodingFor(method.model) : undefined);
      try {
        const result = await countWithMethod(root, provider, method, blobs, measured, plan, onNotice);
        for (const [blob, count] of result.counts) counts.set(`${provider}\0${blob}`, count);
        alsoSentTo.delete(labels.recipient ?? "");
        metadata.push({
          provider,
          ...labels,
          method: result.method,
          ...(result.wrapperTokens !== undefined ? { wrapperTokens: result.wrapperTokens } : {}),
          ...(alsoSentTo.size ? { alsoSentTo: [...alsoSentTo] } : {}),
          ...(fallbacks.length ? { fallbacks } : {}),
        });
        last = undefined;
        break;
      } catch (error) {
        last = error instanceof Error ? error : new Error(String(error));
        if ((last as CountFailure).sentText && labels.recipient) alsoSentTo.add(labels.recipient);
        // The reason omits the path and object IDs, so a shareable report's fallbacks reveal neither.
        const reason = withoutObjectIds((last as CountFailure).reason ?? last.message);
        fallbacks.push(`${labels.credential ?? labels.method} failed: ${reason}`);
        if (method !== methods.at(-1)) onNotice?.(`${last.message}; trying the next method.`);
      }
    }
    if (last) throw last;
  }
  return { counts, metadata };
}
