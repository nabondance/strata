import type { ContextFile } from "./adapters.js";
import { type ContentUse, utf8Text } from "./content-pass.js";
import { geminiContextFiles, geminiSettingsPath } from "./gemini-settings.js";
import { readBlobs } from "./git.js";
import type { BlobMeasurement, TrackedFile } from "./inventory.js";
import { createMeasurer, type Measurer } from "./measurement.js";
import {
  type CountedProvider,
  type CountMethod,
  cacheableModel,
  cacheFamily,
  countRemoteText,
  describeMethod,
  localEncoding,
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
const noBlobs = new Set<string>();

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

/** Resolves each distinct root Gemini settings blob to the context files it configures, as the shared content pass reads it. */
export class GeminiSettings implements ContentUse {
  readonly configured = new Map<string, ContextFile[] | null>();
  private readonly decoder = new TextDecoder();

  wants(file: TrackedFile): boolean {
    return file.path === geminiSettingsPath;
  }

  read(blob: string, body: Buffer): void {
    this.configured.set(blob, geminiContextFiles(this.decoder.decode(body)));
  }
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** The one-letter text whose count, less its one token, measures a count endpoint's message wrapper. */
const wrapperProbe = "a";

interface MethodCounts {
  counts: Map<string, ProviderTextCount>;
  /** The method label, which names the wrapper once one is subtracted. */
  method: string;
  wrapperTokens?: number;
  /** False when every file was blank, so no endpoint counted anything, in this run or a cached one. */
  counted: boolean;
}

/** Whether a plan counts Codex on this machine, so its counts can be taken during the shared content pass. */
export function countsLocally(plan: ProviderCountPlan): boolean {
  const codex = plan.methods.codex;
  return Array.isArray(codex) && codex.some((method) => method.kind === "local");
}

/**
 * Which instruction blobs are blank (nothing to count) or not valid UTF-8 (not text to count),
 * found as the shared content pass reads them, so before anything is sent a file that is not UTF-8
 * text sends nothing and blank files never reach an endpoint. With `countLocally`, it also counts
 * the blobs Codex reads with the local encoding, so they are not read again.
 */
export class TextCheck implements ContentUse {
  readonly blank = new Set<string>();
  readonly invalid = new Set<string>();
  /** Local Codex counts by blob, for the blobs this pass read for a file Codex reads. */
  readonly localCounts = new Map<string, number>();
  private readonly checked = new Set<string>();
  private readonly local: Measurer | null;

  constructor(countLocally = false) {
    this.local = countLocally ? createMeasurer("openai-o200k_base") : null;
  }

  wants(file: TrackedFile): boolean {
    return Boolean(file.classification.instructionalText && !this.checked.has(file.blob));
  }

  read(blob: string, body: Buffer, files: TrackedFile[]): void {
    this.checked.add(blob);
    const text = utf8Text(body);
    if (text === null) {
      this.invalid.add(blob);
      return;
    }
    if (!text.trim()) this.blank.add(blob);
    if (this.local && files.some((file) => countedProviders(file, ["codex"], noBlobs).length)) {
      this.localCounts.set(blob, this.local.count(body));
    }
  }
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
  text: TextCheck,
  plan: ProviderCountPlan,
  onNotice: ((line: string) => void) | undefined,
): Promise<MethodCounts> {
  const { blank } = text;
  const local = method.kind === "local" ? createMeasurer("openai-o200k_base") : null;
  const labels = describeMethod(method);
  const counts = new Map<string, ProviderTextCount>();
  let methodText = labels.method;
  if (method.kind === "estimate") {
    for (const blob of wanted.keys()) counts.set(blob, count(Math.ceil(measured.get(blob)!.bytes / 4)));
    return { counts, method: methodText, counted: true };
  }
  const remote = method.kind === "local" ? null : method;
  const cache = remote && cacheableModel(remote.model) ? plan.cache : undefined;
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
    const cachedRaw = (key: string) => cache?.get(cacheKey + key);
    toRead.length = 0;
    let blankCount = 0;
    for (const blob of wanted.keys()) {
      // Blank files have nothing to count or send: zero, without a request or a notice.
      if (blank.has(blob)) blankCount += 1;
      else if (cachedRaw(blob) === undefined) toRead.push(blob);
    }
    const cachedCount = wanted.size - toRead.length - blankCount;
    if (!toRead.length && !cachedCount) {
      onNotice?.(`${name} instruction files are all empty; no instruction text sent.`);
      for (const blob of wanted.keys()) counts.set(blob, count(0));
      return { counts, method: methodText, counted: false };
    }
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
        cache?.set(`${cacheKey}wrapper`, raw);
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
      const raw = blank.has(blob) ? 0 : cachedRaw(blob);
      if (raw !== undefined) counts.set(blob, count(Math.max(0, raw - (wrapperTokens ?? 0))));
    }
    await requestAll(remote, remoteOptions);
  } else {
    // Most blobs were counted during the shared content pass; only the rest are read here.
    const unread = toRead.filter((blob) => {
      const tokens = text.localCounts.get(blob);
      if (tokens !== undefined) counts.set(blob, count(tokens));
      return tokens === undefined;
    });
    for (const [blob, body] of readBlobs(root, unread, (id) => measured.get(id)?.bytes ?? 0)) {
      try {
        counts.set(blob, count(local!.count(body)));
      } catch (error) {
        throw failure(blob, error);
      }
    }
  }
  return { counts, method: methodText, counted: true, ...(wrapperTokens !== undefined ? { wrapperTokens } : {}) };

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
              cache?.set(cacheKey + blob, raw);
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
  blank: Set<string>,
  plan: ProviderCountPlan,
): string {
  const name = providerName[provider];
  const files = plural(wanted.size, "instruction file version");
  if (method.kind === "estimate") return `${name}: would use the byte estimate for ${files}; nothing sent.`;
  if (method.kind === "local") {
    return `${name}: would count ${files} locally with ${localEncoding}; nothing sent.`;
  }
  const labels = describeMethod(method);
  const cache = cacheableModel(method.model) ? plan.cache : undefined;
  const cacheKey = `${cacheFamily(method)}\0${method.model}\0`;
  const texts = [...wanted.keys()].filter((blob) => !blank.has(blob));
  const cached = texts.filter((blob) => cache?.get(cacheKey + blob) !== undefined).length;
  const sending = texts.length - cached;
  if (!texts.length) return `${name}: instruction files are all empty; nothing would be sent.`;
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
  text: TextCheck,
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
  const { blank, invalid } = text;
  for (const provider of counted) {
    const blobs = wanted.get(provider)!;
    // A provider with no instructions anywhere in the history needs no credential and gets no column.
    if (!blobs.size) continue;
    const planned = plan.methods[provider]!;
    let methods = typeof planned === "function" ? planned() : planned;
    // Text that is not UTF-8 has no text count; one provider's counts never mix methods, so its
    // byte estimate is used for every file, and nothing is sent first.
    const notText = [...blobs.keys()].filter((blob) => invalid.has(blob)).length;
    if (notText) {
      const reason = `${plural(notText, "instruction file version")} ${notText === 1 ? "is" : "are"} not valid UTF-8 text, so none were counted as text or sent`;
      // A plan without the estimate has nothing to fall back to.
      if (!methods.some((method) => method.kind === "estimate")) {
        throw new Error(`Could not count ${provider} instructions: ${reason}`);
      }
      methods = [
        ...methods.filter((method) => method.kind === "unavailable"),
        { kind: "unavailable", reason },
        ...methods.filter((method) => method.kind === "estimate"),
      ];
    }
    if (plan.dryRun) {
      const chosen = methods.find(
        (method): method is Exclude<CountMethod, { kind: "unavailable" }> => method.kind !== "unavailable",
      );
      if (chosen) {
        const skipped = methods
          .slice(0, methods.indexOf(chosen))
          .flatMap((method) => (method.kind === "unavailable" ? [method.reason] : []));
        onNotice?.(previewMethod(provider, chosen, blobs, blank, plan));
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
      const labels = describeMethod(method);
      try {
        const result = await countWithMethod(root, provider, method, blobs, measured, text, plan, onNotice);
        for (const [blob, count] of result.counts) counts.set(`${provider}\0${blob}`, count);
        alsoSentTo.delete(labels.recipient ?? "");
        const { recipient, ...rest } = labels;
        metadata.push({
          provider,
          ...rest,
          ...(recipient && result.counted ? { recipient } : {}),
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
