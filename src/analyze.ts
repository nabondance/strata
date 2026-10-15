import { basename, resolve } from "node:path";
import type { ContextFile } from "./adapters.js";
import { classify } from "./adapters.js";
import { geminiContextFiles, geminiSettingsPath } from "./gemini-settings.js";
import { git, gitText, gitTokens, readBlobs } from "./git.js";
import {
  type BlobMeasurement,
  byPath,
  measureBlobs,
  summarize,
  type TrackedFile,
  toComponent,
  trackedFile,
} from "./inventory.js";
import { createMeasurer, type MeasurementMode, modeForModel } from "./measurement.js";
import type { Change, Component, CountedProvider, Report, Revision } from "./model.js";
import {
  type CountMethod,
  countRemoteText,
  describeMethod,
  type ProviderCountOptions,
  type ProviderCountPlan,
  type ProviderMeasurementMetadata,
  type ProviderTextCount,
  providerApiPlan,
  type RemoteProvider,
} from "./provider-count.js";
import { providerReads } from "./provider-view.js";

export { categories } from "./adapters.js";
export type { Change, Component, Report, Revision, RevisionSnapshot, SkillGroup } from "./model.js";

export interface AnalysisProgress {
  completed: number;
  total: number;
}

export interface AnalysisOptions {
  onProgress?: (progress: AnalysisProgress) => void;
  mode?: MeasurementMode;
  model?: string | null;
  /** `--provider-api`: explicit models and API keys, failing rather than falling back. */
  providerCounts?: ProviderCountOptions;
  /** `--precise`: each provider's counting methods, most precise first. */
  providerPlan?: ProviderCountPlan;
  /** Called with a line for a person, such as which host is about to receive instruction text. */
  onNotice?: (line: string) => void;
}

/** What one commit changed, relative to its first parent, among recognized paths. */
interface CommitDelta {
  id: string;
  date: string;
  firstParent: string | null;
  removed: string[];
  written: TrackedFile[];
  renames: Map<string, string>;
}

const providerRequestConcurrency = 8;

/**
 * Read the whole first-parent history in one streamed Git process. Each commit's raw diff against
 * its first parent is reduced to the recognized paths it removed, wrote, or renamed.
 */
async function readHistory(root: string, onCommit: (count: number) => void): Promise<CommitDelta[]> {
  const deltas: CommitDelta[] = [];
  let current: CommitDelta | undefined;
  let status = "";
  let mode = "";
  let blob = "";
  let expected = 0;
  let paths: string[] = [];
  const tokens = gitTokens(root, [
    "log",
    "--first-parent",
    "--reverse",
    "--diff-merges=first-parent",
    "--root",
    "--raw",
    "-z",
    "--no-abbrev",
    "-M",
    "--no-ext-diff",
    "--no-color",
    "--no-show-signature",
    "--format=%x01%H%x09%aI%x09%P",
    "HEAD",
  ]);
  for await (const batch of tokens) {
    for (let token of batch) {
      if (expected > 0) {
        paths.push(token);
        expected -= 1;
        if (expected > 0) continue;
        if (!current) throw new Error("Malformed git log output");
        const path = paths.at(-1)!;
        const source = paths[0]!;
        if (status === "D" || status[0] === "R") {
          if (classify(source)) current.removed.push(source);
        }
        if (status !== "D") {
          const file = trackedFile(mode, blob, path);
          if (file) current.written.push(file);
          else if (classify(path)) current.removed.push(path);
          if (file && status[0] === "R" && classify(source)) current.renames.set(source, path);
        }
        continue;
      }
      if (token[0] === "\n") token = token.slice(1);
      if (!token) continue;
      if (token[0] === "\x01") {
        const [id, date, parents] = token.slice(1).split("\t");
        if (!id || !date) throw new Error("Malformed git log output");
        current = {
          id,
          date,
          firstParent: parents?.split(" ")[0] || null,
          removed: [],
          written: [],
          renames: new Map(),
        };
        deltas.push(current);
        onCommit(deltas.length);
      } else if (token[0] === ":") {
        const fields = token.split(" ");
        mode = fields[1] ?? "";
        blob = fields[3] ?? "";
        status = fields[4] ?? "";
        if (!status) throw new Error("Malformed git log output");
        expected = status[0] === "R" || status[0] === "C" ? 2 : 1;
        paths = [];
      } else {
        throw new Error("Malformed git log output");
      }
    }
  }
  return deltas;
}

/**
 * Describe what a commit did to the inventory. `before` holds the earlier entry of every path the
 * commit touched; `inventory` is the state after it. Entries are indexes into `table`.
 */
function buildChanges(
  before: Map<string, number | undefined>,
  inventory: Map<string, number>,
  renames: Map<string, string>,
  table: Component[],
): Change[] {
  const tokens = (index: number | undefined) => (index === undefined ? null : table[index]!.estimatedTokens);
  const renamedFrom = new Set<string>();
  const renamedTo = new Set<string>();
  const changes: Change[] = [];

  for (const [oldPath, newPath] of renames) {
    const oldIndex = before.get(oldPath);
    const newIndex = inventory.get(newPath);
    if (oldIndex === undefined || newIndex === undefined) continue;
    if (inventory.has(oldPath) || before.get(newPath) !== undefined) continue;
    changes.push({
      kind: "renamed",
      path: newPath,
      previousPath: oldPath,
      previousTokens: tokens(oldIndex),
      estimatedTokens: tokens(newIndex),
      deltaTokens: (tokens(newIndex) ?? 0) - (tokens(oldIndex) ?? 0),
      component: newIndex,
    });
    renamedFrom.add(oldPath);
    renamedTo.add(newPath);
  }

  for (const [path, oldIndex] of before) {
    const newIndex = inventory.get(path);
    if (newIndex === oldIndex || renamedTo.has(path) || renamedFrom.has(path)) continue;
    changes.push({
      kind: newIndex === undefined ? "removed" : oldIndex === undefined ? "added" : "modified",
      path,
      previousTokens: tokens(oldIndex),
      estimatedTokens: tokens(newIndex),
      deltaTokens: (tokens(newIndex) ?? 0) - (tokens(oldIndex) ?? 0),
      component: newIndex ?? null,
    });
  }
  return changes.sort(byPath);
}

const countedOrder = ["claude", "gemini", "codex"] as const satisfies readonly CountedProvider[];

/**
 * The providers to count a file under: its own provider, or a shared file's readers. A Gemini
 * context file is counted for Gemini only when its blob is present in some revision whose settings
 * make Gemini read it, so versions Gemini never reads are not sent to its API.
 */
function countedProviders(
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
function geminiSettings(root: string, files: TrackedFile[], measured: Map<string, BlobMeasurement>) {
  const blobs = [...new Set(files.filter((file) => file.path === geminiSettingsPath).map((file) => file.blob))];
  const decoder = new TextDecoder();
  const configured = new Map<string, ContextFile[] | null>();
  for (const [blob, body] of readBlobs(root, blobs, (id) => measured.get(id)?.bytes ?? 0)) {
    configured.set(blob, geminiContextFiles(decoder.decode(body)));
  }
  return configured;
}

/** Replay only settings and context files to find the context-file blobs Gemini reads somewhere. */
function geminiReadBlobs(deltas: CommitDelta[], configured: Map<string, ContextFile[] | null>): Set<string> {
  const contextFiles = new Map<string, TrackedFile>();
  let settings: string | undefined;
  const read = new Set<string>();
  for (const delta of deltas) {
    let touched = false;
    for (const path of delta.removed) {
      touched = contextFiles.delete(path) || path === geminiSettingsPath || touched;
      if (path === geminiSettingsPath) settings = undefined;
    }
    for (const file of delta.written) {
      if (file.path === geminiSettingsPath) {
        settings = file.blob;
        touched = true;
      } else if (file.classification.contextFile && file.classification.instructionalText) {
        contextFiles.set(file.path, file);
        touched = true;
      }
    }
    if (!touched) continue;
    const names = settings === undefined ? null : configured.get(settings);
    for (const file of contextFiles.values()) {
      if (providerReads(file.classification, "gemini", names)) read.add(file.blob);
    }
  }
  return read;
}

/** Count one provider's distinct blobs with one method, with bounded request concurrency. */
async function countWithMethod(
  root: string,
  provider: CountedProvider,
  method: Exclude<CountMethod, { kind: "unavailable" }>,
  wanted: Map<string, string>,
  measured: Map<string, BlobMeasurement>,
  fetchImpl: typeof fetch | undefined,
): Promise<Map<string, ProviderTextCount>> {
  const local = method.kind === "local" ? createMeasurer(modeForModel(method.model), method.model) : null;
  const labels = describeMethod(method, local?.measurement.encoding ?? undefined);
  const count = (tokens: number): ProviderTextCount => ({
    tokens,
    provider,
    model: labels.model,
    method: labels.method,
    version: labels.version,
    accuracy: labels.accuracy,
  });
  const counts = new Map<string, ProviderTextCount>();
  if (method.kind === "estimate") {
    for (const blob of wanted.keys()) counts.set(blob, count(Math.ceil(measured.get(blob)!.bytes / 4)));
    return counts;
  }
  const remote = method.kind === "local" ? null : method;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const running = new Set<Promise<void>>();
  let failure: Error | undefined;
  for (const [blob, body] of readBlobs(root, [...wanted.keys()], (id) => measured.get(id)?.bytes ?? 0)) {
    const fail = (error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      failure ??= Object.assign(
        new Error(`Could not count ${provider} instructions at ${wanted.get(blob)}: ${reason}`),
        {
          reason,
        },
      );
    };
    try {
      if (!remote) {
        counts.set(blob, count(local!.count(body)));
        continue;
      }
      const task: Promise<void> = countRemoteText(provider as RemoteProvider, remote, decoder.decode(body), fetchImpl)
        .then((tokens) => {
          counts.set(blob, count(tokens));
        }, fail)
        .finally(() => running.delete(task));
      running.add(task);
    } catch (error) {
      fail(error);
    }
    if (running.size >= providerRequestConcurrency) await Promise.race(running);
    if (failure) break;
  }
  await Promise.all(running);
  if (failure) throw failure;
  return counts;
}

/**
 * Count each provider's distinct blobs once across the history. A provider's methods are tried in
 * order; if one fails, its partial counts are discarded and the next is tried, so one provider's
 * counts never mix methods. The last method's failure is fatal.
 */
async function countProviderBlobs(
  root: string,
  files: TrackedFile[],
  measured: Map<string, BlobMeasurement>,
  plan: ProviderCountPlan,
  geminiBlobs: Set<string>,
  onNotice: ((line: string) => void) | undefined,
): Promise<{ counts: Map<string, ProviderTextCount>; metadata: ProviderMeasurementMetadata[] }> {
  const counted = countedOrder.filter((provider) => plan.methods[provider]?.length);
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
    const methods = plan.methods[provider]!;
    const fallbacks: string[] = [];
    let last: Error | undefined;
    for (const method of methods) {
      if (method.kind === "unavailable") {
        fallbacks.push(method.reason);
        continue;
      }
      const labels = describeMethod(method, method.kind === "local" ? encodingFor(method.model) : undefined);
      if (labels.recipient && blobs.size) {
        onNotice?.(
          `Sending ${blobs.size} ${providerName[provider]} instruction file version${blobs.size === 1 ? "" : "s"} to ${labels.recipient} to count with ${labels.model}, using ${labels.credential}.`,
        );
      }
      try {
        for (const [blob, count] of await countWithMethod(root, provider, method, blobs, measured, plan.fetchImpl)) {
          counts.set(`${provider}\0${blob}`, count);
        }
        metadata.push({ provider, ...labels, ...(fallbacks.length ? { fallbacks } : {}) });
        last = undefined;
        break;
      } catch (error) {
        last = error instanceof Error ? error : new Error(String(error));
        // The reason omits the path, so a shareable report's fallbacks do not reveal one.
        const reason = (last as Error & { reason?: string }).reason ?? last.message;
        fallbacks.push(`${labels.credential ?? labels.method} failed: ${reason}`);
        if (method !== methods.at(-1)) onNotice?.(`${last.message}; trying the next method.`);
      }
    }
    if (last) throw last;
  }
  return { counts, metadata };
}

const providerName: Record<CountedProvider, string> = { claude: "Claude", gemini: "Gemini", codex: "Codex" };

function encodingFor(model: string): string {
  return modeForModel(model).replace("openai-", "");
}

export async function analyzeRepository(repoPath: string, options: AnalysisOptions = {}): Promise<Report> {
  const { onProgress, onNotice, mode = "estimate", model = null } = options;
  const plan = options.providerPlan ?? (options.providerCounts ? providerApiPlan(options.providerCounts) : undefined);
  if (plan && mode !== "estimate") {
    throw new Error("Provider counts accompany the default estimate; do not combine them with another tokenizer");
  }
  const measurer = createMeasurer(mode, model);
  const root = gitText(resolve(repoPath), ["rev-parse", "--show-toplevel"]);
  const branch = gitText(root, ["branch", "--show-current"]) || "detached HEAD";
  const shallow = gitText(root, ["rev-parse", "--is-shallow-repository"]) === "true";
  try {
    git(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  } catch {
    throw new Error("The repository has no commits to analyze");
  }

  const total = Number(gitText(root, ["rev-list", "--count", "--first-parent", "HEAD"]));
  onProgress?.({ completed: 0, total });
  const deltas = await readHistory(root, (completed) => onProgress?.({ completed, total: Math.max(total, completed) }));
  if (!deltas.length) throw new Error("The repository has no commits to analyze");

  const written = deltas.flatMap((delta) => delta.written);
  const measured = measureBlobs(root, written, measurer);
  const configured = geminiSettings(root, written, measured);
  const geminiBlobs = plan ? geminiReadBlobs(deltas, configured) : new Set<string>();
  const provided = plan ? await countProviderBlobs(root, written, measured, plan, geminiBlobs, onNotice) : null;
  const countedByPlan = provided ? provided.metadata.map(({ provider }) => provider) : [];

  // Each distinct file version is stored once; revisions refer to it by index.
  const table: Component[] = [];
  const tableIndex = new Map<string, number>();
  const intern = (file: TrackedFile): number => {
    const key = `${file.path}\0${file.blob}`;
    let index = tableIndex.get(key);
    if (index === undefined) {
      const providerTokenCounts: NonNullable<Component["providerTokenCounts"]> = {};
      if (provided) {
        for (const provider of countedProviders(file, countedByPlan, geminiBlobs)) {
          providerTokenCounts[provider] = provided.counts.get(`${provider}\0${file.blob}`)!;
        }
      }
      index = table.push(toComponent(file, measured.get(file.blob)!, providerTokenCounts)) - 1;
      tableIndex.set(key, index);
    }
    return index;
  };

  const inventory = new Map<string, number>();
  const revisions: Revision[] = [];
  for (const delta of deltas) {
    const previous = revisions.at(-1);
    const { id, date, firstParent } = delta;
    const before = new Map<string, number | undefined>();
    for (const path of delta.removed) before.set(path, inventory.get(path));
    for (const { path } of delta.written) before.set(path, inventory.get(path));
    for (const path of delta.removed) inventory.delete(path);
    for (const file of delta.written) inventory.set(file.path, intern(file));
    const changes = buildChanges(before, inventory, delta.renames, table);
    // A revision that changes no recognized file keeps the previous revision's totals.
    if (previous && !changes.length) {
      revisions.push({ ...previous, id, date, firstParent, changes });
      continue;
    }
    const components = [...inventory.values()].map((index) => table[index]!);
    const settings = inventory.get(geminiSettingsPath);
    const names = settings === undefined ? null : (configured.get(table[settings]!.blob) ?? null);
    // Unchanged settings keep the previous revision's array, so views can compare by identity.
    const geminiContext =
      names && previous?.geminiContextFiles?.join() === names.join() ? previous.geminiContextFiles : names;
    const providerTokenTotals: NonNullable<Revision["providerTokenTotals"]> = {};
    for (const component of components) {
      for (const [provider, count] of Object.entries(component.providerTokenCounts ?? {}) as Array<
        [CountedProvider, ProviderTextCount]
      >) {
        if (!providerReads(component, provider, geminiContext)) continue;
        providerTokenTotals[provider] = (providerTokenTotals[provider] ?? 0) + count.tokens;
      }
    }
    revisions.push({
      id,
      date,
      firstParent,
      ...summarize(components),
      changes,
      ...(plan ? { providerTokenTotals } : {}),
      ...(geminiContext ? { geminiContextFiles: geminiContext } : {}),
    });
  }

  // Order the table by path, so that sorting indexes sorts an inventory, and renumber the changes.
  const order = table.map((_, index) => index).sort((a, b) => byPath(table[a]!, table[b]!));
  const renumbered = new Array<number>(table.length);
  for (const [position, index] of order.entries()) renumbered[index] = position;
  for (const revision of revisions) {
    for (const change of revision.changes) {
      if (change.component !== null) change.component = renumbered[change.component]!;
    }
  }

  return {
    schemaVersion: 11,
    repository: basename(root),
    branch,
    shallow,
    privacy: { mode: "local" },
    measurement: measurer.measurement,
    ...(provided ? { providerMeasurements: provided.metadata } : {}),
    components: order.map((index) => table[index]!),
    revisions,
  };
}
