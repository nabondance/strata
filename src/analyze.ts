import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { ContextFile } from "./adapters.js";
import { classify, conditionalReaders, withoutReader } from "./adapters.js";
import { addImportedFiles, type SymlinkEvent } from "./claude-imports.js";
import { ContentPass } from "./content-pass.js";
import { compactRevisions } from "./expand.js";
import { geminiSettingsPath } from "./gemini-settings.js";
import { blobSizes, git, gitText, gitTokens } from "./git.js";
import {
  byPath,
  distinctBlobs,
  measureBlobs,
  summarize,
  TokenCounts,
  type TrackedFile,
  toComponent,
  trackedFile,
  versionKey,
} from "./inventory.js";
import { McpServerLists } from "./mcp-servers.js";
import { createMeasurer } from "./measurement.js";
import type { Change, Component, CountedProvider, FilledRevision, Report } from "./model.js";
import type { ProviderCountPlan, ProviderTextCount } from "./provider-count.js";
import { countedProviders, countProviderBlobs, countsLocally, GeminiSettings, TextCheck } from "./provider-counting.js";
import { providerReads } from "./provider-view.js";
import { RuleLoading } from "./rule-loading.js";
import { SkillListings } from "./skill-listing.js";
import { inspectSubmodules } from "./submodules.js";
import { LineAges, LineCounter, lineAgeMethod } from "./survival.js";

export { categories } from "./adapters.js";
export type { Change, Component, Report, Revision, RevisionSnapshot, SkillGroup } from "./model.js";

export interface AnalysisProgress {
  completed: number;
  total: number;
}

export interface AnalysisOptions {
  onProgress?: (progress: AnalysisProgress) => void;
  /** Each counted provider's methods, most precise first: `localPlan()` by default in the CLI, or `--precise`. */
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
  /** Recognized paths that became, stayed, or stopped being a symlink, for following Claude imports. */
  links?: SymlinkEvent[];
}

/** Git's mode for a symlink, whose blob holds the path it points to. */
const symlinkMode = "120000";

/** Git's mode for a submodule entry: a commit in another repository, with no files in this one. */
const gitlinkMode = "160000";

/**
 * Read the whole first-parent history in one streamed Git process. Each commit's raw diff against
 * its first parent is reduced to the recognized paths it removed, wrote, or renamed. The submodules
 * present at the last commit are collected into `submodules`, each with the commit it records.
 */
async function readHistory(
  root: string,
  submodules: Map<string, string>,
  onCommit: (count: number) => void,
): Promise<CommitDelta[]> {
  const deltas: CommitDelta[] = [];
  let current: CommitDelta | undefined;
  let status = "";
  let mode = "";
  let blob = "";
  let expected = 0;
  let paths: string[] = [];
  // Recognized paths that are symlinks after the commit read so far.
  const links = new Set<string>();
  const linkEvent = (delta: CommitDelta, path: string, link: string | null) => {
    if (delta.links) delta.links.push({ path, link });
    else delta.links = [{ path, link }];
  };
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
    // Configuration such as diff.ignoreSubmodules would otherwise hide submodule entries.
    "--ignore-submodules=none",
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
          submodules.delete(source);
          if (links.delete(source)) linkEvent(current, source, null);
        }
        if (status !== "D") {
          if (mode === gitlinkMode) submodules.set(path, blob);
          else submodules.delete(path);
          const file = trackedFile(mode, blob, path);
          if (file) current.written.push(file);
          else if (classify(path)) current.removed.push(path);
          if (file && status[0] === "R" && classify(source)) current.renames.set(source, path);
          // An import may name a recognized path that is a symlink; only links are kept.
          if (mode === symlinkMode && classify(path)) {
            links.add(path);
            linkEvent(current, path, blob);
          } else if (links.delete(path)) linkEvent(current, path, null);
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

export async function analyzeRepository(repoPath: string, options: AnalysisOptions = {}): Promise<Report> {
  const { onProgress, onNotice } = options;
  const plan = options.providerPlan;
  const measurer = createMeasurer("estimate");
  const root = gitText(resolve(repoPath), ["rev-parse", "--show-toplevel"]);
  const branch = gitText(root, ["branch", "--show-current"]) || "detached HEAD";
  const shallowRepository = gitText(root, ["rev-parse", "--is-shallow-repository"]) === "true";
  try {
    git(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  } catch {
    throw new Error("The repository has no commits to analyze");
  }

  const total = Number(gitText(root, ["rev-list", "--count", "--first-parent", "HEAD"]));
  onProgress?.({ completed: 0, total });
  const submodules = new Map<string, string>();
  const deltas = await readHistory(root, submodules, (completed) =>
    onProgress?.({ completed, total: Math.max(total, completed) }),
  );
  if (!deltas.length) throw new Error("The repository has no commits to analyze");
  // One shared pass reads each blob whose content any step needs, once. Claude import parsing
  // reads the import roots first and hands them to the pass, so the pass does not read them again.
  const tokens = new TokenCounts(measurer);
  const lineCounter = new LineCounter();
  const gemini = new GeminiSettings();
  const skills = new SkillListings(measurer);
  const ruleLoading = new RuleLoading();
  const mcpLists = new McpServerLists();
  const text = plan ? new TextCheck(countsLocally(plan)) : null;
  const pass = new ContentPass([tokens, lineCounter, gemini, skills, ruleLoading, mcpLists, ...(text ? [text] : [])]);
  for (const delta of deltas) pass.add(delta.written);
  // Files Claude imports join the deltas here, so every later step treats them as components.
  const imports = await addImportedFiles(root, deltas, (blob, body) => pass.offer(blob, body));

  const written = deltas.flatMap((delta) => delta.written);
  for (const reader of conditionalReaders) {
    if (written.some((file) => file.classification.provider === reader)) continue;
    for (const file of written) withoutReader(file.classification, reader);
  }
  pass.add(written);
  const sizes = blobSizes(root, distinctBlobs(written));
  pass.run(root, sizes);
  const measured = measureBlobs(written, sizes, measurer, tokens);
  const configured = gemini.configured;
  const listings = skills.listings;
  const rules = ruleLoading.upFront;
  const mcp = mcpLists.lists;
  const counted = lineCounter.done();
  const ages = new LineAges(counted.lines, counted.weights);
  const geminiBlobs = plan ? geminiReadBlobs(deltas, configured) : new Set<string>();
  const provided = plan ? await countProviderBlobs(root, written, measured, plan, geminiBlobs, text!, onNotice) : null;
  const countedByPlan = provided ? provided.metadata.map(({ provider }) => provider) : [];
  // A provider with no instructions in the history gets no count, so a report with none has no provider fields.
  const hasProviderCounts = countedByPlan.length > 0;

  // Each distinct file version is stored once; revisions refer to it by index.
  const table: Component[] = [];
  const tableIndex = new Map<string, number>();
  const intern = (file: TrackedFile): number => {
    const key = versionKey(file.path, file.blob);
    let index = tableIndex.get(key);
    if (index === undefined) {
      const providerTokenCounts: NonNullable<Component["providerTokenCounts"]> = {};
      if (provided) {
        for (const provider of countedProviders(file, countedByPlan, geminiBlobs)) {
          providerTokenCounts[provider] = provided.counts.get(`${provider}\0${file.blob}`)!;
        }
      }
      index =
        table.push(
          toComponent(
            file,
            measured.get(file.blob)!,
            providerTokenCounts,
            listings.get(key),
            imports.get(key),
            rules.get(key),
            mcp.get(key),
          ),
        ) - 1;
      tableIndex.set(key, index);
    }
    return index;
  };

  const inventory = new Map<string, number>();
  const revisions: FilledRevision[] = [];
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
      const { lineAge: _unchanged, ...totals } = previous;
      revisions.push({ ...totals, id, date, firstParent, changes });
      continue;
    }
    const instructional = (index: number | undefined) =>
      index !== undefined && table[index]!.estimatedTokens !== null ? [table[index]!.blob] : [];
    const lineAge = ages.apply(
      revisions.length,
      [...before.values()].flatMap(instructional),
      [...before.keys()].flatMap((path) => instructional(inventory.get(path))),
    );
    const components = [...inventory.values()].map((index) => table[index]!);
    const settings = inventory.get(geminiSettingsPath);
    const names = settings === undefined ? null : (configured.get(table[settings]!.blob) ?? null);
    // Unchanged settings keep the previous revision's array, so views can compare by identity.
    const geminiContext =
      names && previous?.geminiContextFiles?.join() === names.join() ? previous.geminiContextFiles : names;
    const providerTokenTotals: NonNullable<FilledRevision["providerTokenTotals"]> = {};
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
      ...(hasProviderCounts ? { providerTokenTotals } : {}),
      ...(geminiContext ? { geminiContextFiles: geminiContext } : {}),
      ...(lineAge ? { lineAge } : {}),
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

  const shallow = shallowRepository && startsAtShallowBoundary(root, revisions[0]?.id);
  return {
    schemaVersion: 21,
    repository: basename(root),
    branch,
    shallow,
    ...(submodules.size ? { submodules: inspectSubmodules(root, submodules) } : {}),
    privacy: { mode: "local" },
    measurement: measurer.measurement,
    ...(hasProviderCounts ? { providerMeasurements: provided!.metadata } : {}),
    lineAgeMethod,
    components: order.map((index) => table[index]!),
    revisions: compactRevisions(revisions),
  };
}

/**
 * Whether the history starts where a shallow fetch cut it: the oldest first-parent commit is a
 * shallow boundary and has a parent that was not fetched. A repository can be shallow only on a
 * side branch or another ref, with this history complete, and Git also lists a root commit that
 * sat at the depth limit, though nothing before it is missing.
 */
function startsAtShallowBoundary(root: string, first: string | undefined): boolean {
  if (!first) return false;
  try {
    const listed = readFileSync(resolve(root, gitText(root, ["rev-parse", "--git-path", "shallow"])), "utf8");
    if (!listed.split("\n").includes(first)) return false;
  } catch {
    return true;
  }
  // The raw commit still names its parents; a shallow boundary only hides them from history walks.
  return /^parent /m.test(git(root, ["cat-file", "commit", first]).toString("utf8").split("\n\n")[0]!);
}
