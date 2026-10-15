import { type ComparedRevision, type Comparison, compareRevisions } from "./compare.js";
import { git, listTree } from "./git.js";
import { byPath, measureBlobs, summarize, type TrackedFile, toComponent, trackedFile } from "./inventory.js";
import { createMeasurer, type Measurement, type MeasurementMode } from "./measurement.js";

function commitId(repo: string, id: string): string {
  if (!/^[0-9a-f]{40,64}$/i.test(id)) throw new Error("Base and head must be full Git commit IDs");
  try {
    return git(repo, ["rev-parse", "--verify", "--quiet", `${id}^{commit}`])
      .toString("utf8")
      .trim();
  } catch {
    throw new Error(`Commit ${id} is unavailable; fetch full base and head history first`);
  }
}

function trackedFiles(repo: string, id: string): TrackedFile[] {
  return listTree(repo, id).flatMap(({ mode, blob, path }) => trackedFile(mode, blob, path) ?? []);
}

export interface PullRequestDelta {
  schemaVersion: 4;
  base: string;
  head: string;
  measurement: Measurement;
  comparison: Comparison;
}

export interface CompareOptions {
  mode?: MeasurementMode;
  model?: string | null;
}

/** Compare two Git commits without checking them out or writing into the target repository. */
export function compareGitCommits(
  repo: string,
  base: string,
  head: string,
  options: CompareOptions = {},
): PullRequestDelta {
  const measurer = createMeasurer(options.mode ?? "estimate", options.model ?? null);
  git(repo, ["rev-parse", "--git-dir"]);
  const ids = [commitId(repo, base), commitId(repo, head)] as const;
  const files = ids.map((id) => trackedFiles(repo, id));
  const measured = measureBlobs(repo, files.flat(), measurer);
  const [before, after] = files.map((snapshot): ComparedRevision => {
    const components = snapshot.map((file) => toComponent(file, measured.get(file.blob)!)).sort(byPath);
    return { components, estimatedTokens: summarize(components).estimatedTokens };
  });
  return {
    schemaVersion: 4,
    base: ids[0],
    head: ids[1],
    measurement: measurer.measurement,
    comparison: compareRevisions(before!, after!),
  };
}

function cell(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\r\n\t]/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/([`*_[\]])/g, "\\$1");
}

export function renderPullRequestDelta(delta: PullRequestDelta): string {
  const comparison = delta.comparison;
  const signed = (value: number) => (value > 0 ? `+${value}` : String(value));
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
    ...comparison.byCategory
      .filter((group) => group.deltaFiles || group.deltaTokens)
      .map((group) => `| ${cell(group.key)} | ${signed(group.deltaFiles)} | ${signed(group.deltaTokens)} |`),
    "",
    "| File | Change | Δ tokens |",
    "| --- | --- | ---: |",
    ...comparison.components
      .slice(0, 25)
      .map((component) => `| ${cell(component.path)} | ${component.kind} | ${signed(component.deltaTokens)} |`),
  ];
  if (comparison.components.length > 25)
    lines.push("", `${comparison.components.length - 25} more changed components omitted from this summary.`);
  lines.push(
    "",
    "Source text is not included. File paths and commit IDs are visible in this summary; a path move may appear as removal and addition.",
    "",
  );
  return lines.join("\n");
}
