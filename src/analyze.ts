import { execFileSync } from "node:child_process";
import { basename, resolve } from "node:path";

export const categories = [
  "instructions",
  "skills",
  "agents",
  "rules",
  "commands",
  "memory",
  "settings",
  "tools",
] as const;

export type Category = (typeof categories)[number];

export interface Component {
  path: string;
  provider: "claude" | "shared";
  category: Category;
  blob: string;
  bytes: number;
  estimatedTokens: number | null;
}

export interface Change {
  kind: "added" | "removed" | "modified" | "renamed";
  path: string;
  previousPath?: string;
  previousTokens: number | null;
  estimatedTokens: number | null;
  deltaTokens: number;
}

export interface Revision {
  id: string;
  date: string;
  firstParent: string | null;
  components: Component[];
  categoryTotals: Record<Category, { count: number; bytes: number; estimatedTokens: number }>;
  estimatedTokens: number;
  changes: Change[];
}

export interface Report {
  schemaVersion: 1;
  repository: string;
  branch: string;
  shallow: boolean;
  measurement: {
    label: string;
    method: string;
    limitations: string;
  };
  revisions: Revision[];
}

interface TreeEntry {
  path: string;
  blob: string;
}

function git(repo: string, args: string[]): Buffer {
  try {
    return execFileSync("git", ["-C", repo, ...args], {
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Git failed (${args[0]}): ${detail}`);
  }
}

function gitText(repo: string, args: string[]): string {
  return git(repo, args).toString("utf8").trim();
}

function classify(path: string): Pick<Component, "category" | "provider"> | null {
  const parts = path.split("/");
  const filename = parts.at(-1);
  if (filename === "CLAUDE.md") return { category: "instructions", provider: "claude" };
  if (filename === "AGENTS.md") return { category: "instructions", provider: "shared" };
  if (path === ".mcp.json") return { category: "tools", provider: "claude" };

  const claudeIndex = parts.indexOf(".claude");
  if (claudeIndex < 0) return null;
  const within = parts.slice(claudeIndex + 1);
  if (within.length === 1 && /^settings(?:\.local)?\.json$/.test(within[0] ?? "")) {
    return { category: "settings", provider: "claude" };
  }
  if (within[0] === "skills" && within.length === 3 && filename === "SKILL.md") {
    return { category: "skills", provider: "claude" };
  }
  if (within.length >= 2 && filename?.endsWith(".md")) {
    if (within[0] === "agents") return { category: "agents", provider: "claude" };
    if (within[0] === "rules") return { category: "rules", provider: "claude" };
    if (within[0] === "commands") return { category: "commands", provider: "claude" };
    if (within[0] === "agent-memory" && within.length >= 3) {
      return { category: "memory", provider: "claude" };
    }
  }
  return null;
}

function treeEntries(repo: string, revision: string): TreeEntry[] {
  const output = git(repo, ["ls-tree", "-r", "-z", "--full-tree", revision]);
  const entries: TreeEntry[] = [];
  for (let start = 0; start < output.length; ) {
    const end = output.indexOf(0, start);
    if (end < 0) throw new Error("Malformed git ls-tree output");
    const entry = output.toString("utf8", start, end);
    const tab = entry.indexOf("\t");
    const header = entry.slice(0, tab).split(" ");
    const path = entry.slice(tab + 1);
    if (tab > 0 && (header[0] === "100644" || header[0] === "100755")) {
      const blob = header[2];
      if (blob && classify(path)) entries.push({ path, blob });
    }
    start = end + 1;
  }
  return entries;
}

function renamePairs(repo: string, previous: string, current: string): Map<string, string> {
  const output = git(repo, ["diff", "--no-ext-diff", "--no-textconv", "--name-status", "-z", "-M", previous, current]);
  const fields = output.toString("utf8").split("\0");
  const renamed = new Map<string, string>();
  for (let index = 0; index < fields.length - 1; ) {
    const status = fields[index++] ?? "";
    if (status.startsWith("R") || status.startsWith("C")) {
      const oldPath = fields[index++];
      const newPath = fields[index++];
      if (status.startsWith("R") && oldPath && newPath) renamed.set(oldPath, newPath);
    } else {
      index += 1;
    }
  }
  return renamed;
}

function buildChanges(
  previous: Revision | undefined,
  components: Component[],
  renames: Map<string, string>,
): Change[] {
  const before = new Map(previous?.components.map((component) => [component.path, component]));
  const after = new Map(components.map((component) => [component.path, component]));
  const consumedBefore = new Set<string>();
  const consumedAfter = new Set<string>();
  const changes: Change[] = [];

  for (const [oldPath, newPath] of renames) {
    const oldComponent = before.get(oldPath);
    const newComponent = after.get(newPath);
    if (!oldComponent || !newComponent || after.has(oldPath) || before.has(newPath)) continue;
    changes.push({
      kind: "renamed",
      path: newPath,
      previousPath: oldPath,
      previousTokens: oldComponent.estimatedTokens,
      estimatedTokens: newComponent.estimatedTokens,
      deltaTokens: (newComponent.estimatedTokens ?? 0) - (oldComponent.estimatedTokens ?? 0),
    });
    consumedBefore.add(oldPath);
    consumedAfter.add(newPath);
  }

  for (const component of components) {
    if (consumedAfter.has(component.path)) continue;
    const oldComponent = before.get(component.path);
    if (oldComponent?.blob === component.blob) continue;
    changes.push({
      kind: oldComponent ? "modified" : "added",
      path: component.path,
      previousTokens: oldComponent?.estimatedTokens ?? null,
      estimatedTokens: component.estimatedTokens,
      deltaTokens: (component.estimatedTokens ?? 0) - (oldComponent?.estimatedTokens ?? 0),
    });
  }
  for (const component of previous?.components ?? []) {
    if (after.has(component.path) || consumedBefore.has(component.path)) continue;
    changes.push({
      kind: "removed",
      path: component.path,
      previousTokens: component.estimatedTokens,
      estimatedTokens: null,
      deltaTokens: -(component.estimatedTokens ?? 0),
    });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

export function analyzeRepository(repoPath: string): Report {
  const repo = resolve(repoPath);
  const root = gitText(repo, ["rev-parse", "--show-toplevel"]);
  const branch = gitText(root, ["branch", "--show-current"]) || "detached HEAD";
  const shallow = gitText(root, ["rev-parse", "--is-shallow-repository"]) === "true";
  const log = gitText(root, ["log", "--first-parent", "--reverse", "--format=%H%x09%aI%x09%P", "HEAD"]);
  if (!log) throw new Error("The repository has no commits to analyze");

  const blobMeasurements = new Map<string, { bytes: number; estimatedTokens: number }>();
  const revisions: Revision[] = [];
  for (const line of log.split("\n")) {
    const [id, date, parents] = line.split("\t");
    if (!id || !date) throw new Error("Malformed git log output");
    const components = treeEntries(root, id).map(({ path, blob }) => {
      const classification = classify(path);
      if (!classification) throw new Error(`Unexpected unclassified path: ${path}`);
      let measured = blobMeasurements.get(blob);
      if (!measured) {
        const bytes = git(root, ["cat-file", "blob", blob]).length;
        measured = { bytes, estimatedTokens: Math.ceil(bytes / 4) };
        blobMeasurements.set(blob, measured);
      }
      return {
        path,
        blob,
        ...classification,
        bytes: measured.bytes,
        estimatedTokens: classification.category === "settings" || classification.category === "tools"
          ? null
          : measured.estimatedTokens,
      } satisfies Component;
    });
    components.sort((a, b) => a.path.localeCompare(b.path));

    const categoryTotals = Object.fromEntries(
      categories.map((category) => [category, { count: 0, bytes: 0, estimatedTokens: 0 }]),
    ) as Revision["categoryTotals"];
    for (const component of components) {
      const total = categoryTotals[component.category];
      total.count += 1;
      total.bytes += component.bytes;
      total.estimatedTokens += component.estimatedTokens ?? 0;
    }
    const previous = revisions.at(-1);
    const changes = buildChanges(
      previous,
      components,
      previous ? renamePairs(root, previous.id, id) : new Map(),
    );
    revisions.push({
      id,
      date,
      firstParent: parents?.split(" ")[0] || null,
      components,
      categoryTotals,
      estimatedTokens: categories.reduce((sum, category) => sum + categoryTotals[category].estimatedTokens, 0),
      changes,
    });
  }

  return {
    schemaVersion: 1,
    repository: basename(root),
    branch,
    shallow,
    measurement: {
      label: "Estimated stored-text tokens",
      method: "UTF-8 bytes / 4, rounded up per instructional file",
      limitations: "Comparison estimate only. This is not a Claude tokenizer or measured session context. Settings and MCP files are counted in bytes, not prompt tokens.",
    },
    revisions,
  };
}
