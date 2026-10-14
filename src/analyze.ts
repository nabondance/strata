import { basename, resolve } from "node:path";
import { classify } from "./adapters.js";
import { geminiReadsAgentsMd, geminiSettingsPath } from "./gemini-settings.js";
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
import {
  createMeasurer,
  type MeasurementMode,
  type Measurer,
  modeForModel,
  tiktokenImplementation,
} from "./measurement.js";
import type { Change, Component, CountedProvider, Report, Revision } from "./model.js";
import {
  countProviderText,
  type ProviderCountOptions,
  type ProviderTextCount,
  providerMeasurementMetadata,
} from "./provider-count.js";

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
  providerCounts?: ProviderCountOptions;
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

function isAgentsMd(path: string): boolean {
  return path === "AGENTS.md" || path.endsWith("/AGENTS.md");
}

/**
 * The providers to count a file under: its own provider, or a shared file's readers. Gemini reads
 * a shared `AGENTS.md` only in revisions whose settings name it, so it is counted for Gemini only
 * when some revision does.
 */
function countedProviders(file: TrackedFile, codex: boolean, geminiAgentsMd: boolean): CountedProvider[] {
  const { provider, instructionalText, readers = [] } = file.classification;
  if (!instructionalText) return [];
  const read = new Set(provider === "shared" ? readers : [provider]);
  if (provider === "shared" && geminiAgentsMd && isAgentsMd(file.path)) read.add("gemini");
  return countedOrder.filter((counted) => read.has(counted) && (counted !== "codex" || codex));
}

/** Whether a component counts toward a provider's total in a revision. */
function readIn(component: Component, provider: CountedProvider, geminiAgentsMd: boolean): boolean {
  if (component.provider !== "shared") return component.provider === provider;
  if (component.readers?.includes(provider)) return true;
  return provider === "gemini" && geminiAgentsMd && isAgentsMd(component.path);
}

/** Resolve each distinct root Gemini settings blob to whether it makes Gemini read `AGENTS.md`. */
function geminiSettings(root: string, files: TrackedFile[], measured: Map<string, BlobMeasurement>) {
  const blobs = [...new Set(files.filter((file) => file.path === geminiSettingsPath).map((file) => file.blob))];
  const decoder = new TextDecoder();
  const reads = new Map<string, boolean>();
  for (const [blob, body] of readBlobs(root, blobs, (id) => measured.get(id)?.bytes ?? 0)) {
    reads.set(blob, geminiReadsAgentsMd(decoder.decode(body)));
  }
  return reads;
}

/** Count each distinct provider/blob pair once across the history, with bounded request concurrency. */
async function countProviderBlobs(
  root: string,
  files: TrackedFile[],
  measured: Map<string, BlobMeasurement>,
  options: ProviderCountOptions,
  codexMeasurer: Measurer | null,
  geminiAgentsMd: boolean,
): Promise<Map<string, ProviderTextCount>> {
  const wanted = new Map<string, { path: string; providers: Set<CountedProvider> }>();
  for (const file of files) {
    const providers = countedProviders(file, codexMeasurer !== null, geminiAgentsMd);
    if (!providers.length) continue;
    let entry = wanted.get(file.blob);
    if (!entry) {
      entry = { path: file.path, providers: new Set() };
      wanted.set(file.blob, entry);
    }
    for (const provider of providers) entry.providers.add(provider);
  }

  const counts = new Map<string, ProviderTextCount>();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const running = new Set<Promise<void>>();
  let failure: Error | undefined;
  for (const [blob, body] of readBlobs(root, [...wanted.keys()], (id) => measured.get(id)?.bytes ?? 0)) {
    const { path, providers } = wanted.get(blob)!;
    for (const provider of providers) {
      const fail = (error: unknown) => {
        failure ??= new Error(
          `Could not count ${provider} instructions at ${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      };
      try {
        if (provider === "codex") {
          const model = options.codexModel!;
          counts.set(`${provider}\0${blob}`, {
            tokens: codexMeasurer!.count(body),
            provider,
            model,
            method: `${tiktokenImplementation}: ${model} → ${codexMeasurer!.measurement.encoding}, counted per instructional file`,
            version: tiktokenImplementation,
            accuracy: "encoding-exact",
          });
          continue;
        }
        const model = provider === "claude" ? options.claudeModel : options.geminiModel;
        const task: Promise<void> = countProviderText(provider, model, decoder.decode(body), options)
          .then((count) => {
            counts.set(`${provider}\0${blob}`, count);
          }, fail)
          .finally(() => running.delete(task));
        running.add(task);
      } catch (error) {
        fail(error);
      }
      if (running.size >= providerRequestConcurrency) await Promise.race(running);
      if (failure) break;
    }
    if (failure) break;
  }
  await Promise.all(running);
  if (failure) throw failure;
  return counts;
}

export async function analyzeRepository(repoPath: string, options: AnalysisOptions = {}): Promise<Report> {
  const { onProgress, mode = "estimate", model = null, providerCounts } = options;
  if (providerCounts && mode !== "estimate") {
    throw new Error("Provider API counts accompany the default estimate; do not combine them with another tokenizer");
  }
  const measurer = createMeasurer(mode, model);
  const codexMeasurer = providerCounts?.codexModel
    ? createMeasurer(modeForModel(providerCounts.codexModel), providerCounts.codexModel)
    : null;
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
  const settingsReadAgentsMd = geminiSettings(root, written, measured);
  const geminiEverReadsAgentsMd = [...settingsReadAgentsMd.values()].includes(true);
  const providerBlobCounts = providerCounts
    ? await countProviderBlobs(root, written, measured, providerCounts, codexMeasurer, geminiEverReadsAgentsMd)
    : null;

  // Each distinct file version is stored once; revisions refer to it by index.
  const table: Component[] = [];
  const tableIndex = new Map<string, number>();
  const intern = (file: TrackedFile): number => {
    const key = `${file.path}\0${file.blob}`;
    let index = tableIndex.get(key);
    if (index === undefined) {
      const providerTokenCounts: NonNullable<Component["providerTokenCounts"]> = {};
      if (providerBlobCounts) {
        for (const provider of countedProviders(file, codexMeasurer !== null, geminiEverReadsAgentsMd)) {
          providerTokenCounts[provider] = providerBlobCounts.get(`${provider}\0${file.blob}`)!;
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
    const geminiAgentsMd = settings !== undefined && settingsReadAgentsMd.get(table[settings]!.blob) === true;
    const providerTokenTotals: NonNullable<Revision["providerTokenTotals"]> = {};
    for (const component of components) {
      for (const [provider, count] of Object.entries(component.providerTokenCounts ?? {}) as Array<
        [CountedProvider, ProviderTextCount]
      >) {
        if (!readIn(component, provider, geminiAgentsMd)) continue;
        providerTokenTotals[provider] = (providerTokenTotals[provider] ?? 0) + count.tokens;
      }
    }
    revisions.push({
      id,
      date,
      firstParent,
      ...summarize(components),
      changes,
      ...(providerCounts ? { providerTokenTotals } : {}),
      ...(geminiAgentsMd ? { geminiReadsAgentsMd: true as const } : {}),
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
    schemaVersion: 10,
    repository: basename(root),
    branch,
    shallow,
    privacy: { mode: "local" },
    measurement: measurer.measurement,
    ...(providerCounts ? { providerMeasurements: providerMeasurementMetadata(providerCounts) } : {}),
    components: order.map((index) => table[index]!),
    revisions,
  };
}
