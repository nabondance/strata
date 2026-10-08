import { execFileSync } from "node:child_process";
import { categories, classify } from "./adapters.js";
import type { Component, Report, Revision } from "./analyze.js";
import { compareRevisions, type Comparison } from "./compare.js";
import { createMeasurer, type MeasurementMode } from "./measurement.js";

function git(repo: string, args: string[]): Buffer {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
}

function commitId(repo: string, id: string): string {
  if (!/^[0-9a-f]{40,64}$/i.test(id)) throw new Error("Base and head must be full Git commit IDs");
  try {
    return git(repo, ["rev-parse", "--verify", `${id}^{commit}`]).toString("utf8").trim();
  } catch {
    throw new Error(`Commit ${id} is unavailable; fetch full base and head history first`);
  }
}

function snapshot(repo: string, id: string, count: (blob: Buffer) => number): Revision {
  const tree = git(repo, ["ls-tree", "-r", "-z", "--full-tree", id]);
  const components: Component[] = [];
  const cache = new Map<string, { bytes: number; tokens: number | null }>();
  for (let start = 0; start < tree.length; ) {
    const end = tree.indexOf(0, start);
    if (end < 0) throw new Error("Malformed git ls-tree output");
    const entry = tree.toString("utf8", start, end);
    const tab = entry.indexOf("\t");
    if (tab < 0) throw new Error("Malformed git ls-tree entry");
    const [mode, , blob] = entry.slice(0, tab).split(" ");
    const path = entry.slice(tab + 1);
    const classification = classify(path);
    if ((mode === "100644" || mode === "100755") && blob && classification) {
      let measured = cache.get(blob);
      if (!measured || (classification.instructionalText && measured.tokens === null)) {
        const body = git(repo, ["cat-file", "blob", blob]);
        try {
          measured = { bytes: body.length, tokens: classification.instructionalText ? count(body) : null };
        } catch (error) {
          throw new Error(`Could not count instructional blob ${blob} at ${path}: ${error instanceof Error ? error.message : String(error)}`);
        }
        cache.set(blob, measured);
      }
      components.push({ path, blob, provider: classification.provider, category: classification.category,
        bytes: measured.bytes, estimatedTokens: classification.instructionalText ? measured.tokens : null,
        ...(classification.skillRoot && classification.skillRole
          ? { skill: { root: classification.skillRoot, role: classification.skillRole } }
          : {}),
      });
    }
    start = end + 1;
  }
  components.sort((a, b) => a.path.localeCompare(b.path));
  const categoryTotals = Object.fromEntries(categories.map((category) => [category, {
    count: 0, bytes: 0, estimatedTokens: 0, sourceOnlyCount: 0,
  }])) as Revision["categoryTotals"];
  for (const component of components) {
    const total = categoryTotals[component.category];
    total.count += 1;
    total.bytes += component.bytes;
    total.estimatedTokens += component.estimatedTokens ?? 0;
    if (component.estimatedTokens === null) total.sourceOnlyCount += 1;
  }
  return { id, date: "", firstParent: null, components, skillGroups: [], categoryTotals,
    estimatedTokens: categories.reduce((sum, category) => sum + categoryTotals[category].estimatedTokens, 0), changes: [] };
}

export interface PullRequestDelta {
  schemaVersion: 2;
  base: string;
  head: string;
  measurement: Report["measurement"];
  comparison: Comparison;
}

/** Compare two Git commits without checking them out or writing into the target repository. */
export function compareGitCommits(repo: string, base: string, head: string, mode: MeasurementMode = "estimate", model: string | null = null): PullRequestDelta {
  const measurer = createMeasurer(mode, model);
  const baseId = commitId(repo, base);
  const headId = commitId(repo, head);
  const before = snapshot(repo, baseId, measurer.count);
  const after = snapshot(repo, headId, measurer.count);
  return { schemaVersion: 2, base: baseId, head: headId, measurement: measurer.measurement,
    comparison: compareRevisions(before, after) };
}

function cell(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/[\r\n\t]/g, " ").replace(/\\/g, "\\\\").replace(/\|/g, "\\|")
    .replace(/([`*_\[\]])/g, "\\$1");
}

export function renderPullRequestDelta(delta: PullRequestDelta): string {
  const comparison = delta.comparison;
  const signed = (value: number) => value > 0 ? `+${value}` : String(value);
  const lines = [
    "## Strata configuration delta",
    "",
    `Base \`${delta.base.slice(0, 12)}\` → head \`${delta.head.slice(0, 12)}\``,
    "",
    `Stored instructional text: **${signed(comparison.deltaTokens)}** tokens (${comparison.beforeTokens} → ${comparison.afterTokens}); tracked files: **${signed(comparison.deltaFiles)}** (${comparison.beforeFiles} → ${comparison.afterFiles}).`,
    "",
    `Method: ${cell(delta.measurement.method)}. ${cell(delta.measurement.limitations)}`,
    "",
    "| Category | Δ files | Δ tokens |",
    "| --- | ---: | ---: |",
    ...comparison.byCategory.filter((group) => group.deltaFiles || group.deltaTokens)
      .map((group) => `| ${cell(group.key)} | ${signed(group.deltaFiles)} | ${signed(group.deltaTokens)} |`),
    "",
    "| File | Change | Δ tokens |",
    "| --- | --- | ---: |",
    ...comparison.components.slice(0, 25).map((component) =>
      `| ${cell(component.path)} | ${component.kind} | ${signed(component.deltaTokens)} |`),
  ];
  if (comparison.components.length > 25) lines.push("", `${comparison.components.length - 25} more changed components omitted from this summary.`);
  lines.push("", "Source text is not included. File paths and commit IDs are visible in this summary; a path move may appear as removal and addition.", "");
  return lines.join("\n");
}
