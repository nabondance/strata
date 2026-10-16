import { type ComparedRevision, type Comparison, compareRevisions } from "./compare.js";
import { geminiSettingsPath } from "./gemini-settings.js";
import { git, listTree } from "./git.js";
import { byPath, measureBlobs, summarize, type TrackedFile, toComponent, trackedFile } from "./inventory.js";
import { createMeasurer, type Measurement, type MeasurementMode } from "./measurement.js";
import {
  type CountedProvider,
  type ProviderCountPlan,
  type ProviderMeasurementMetadata,
  textRecipients,
} from "./provider-count.js";
import { countProviderBlobs, geminiSettings, providerName } from "./provider-counting.js";
import { providerReads } from "./provider-view.js";

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

export interface ProviderTotalDelta {
  provider: CountedProvider;
  beforeTokens: number;
  afterTokens: number;
  deltaTokens: number;
}

export interface PullRequestDelta {
  schemaVersion: 5;
  base: string;
  head: string;
  measurement: Measurement;
  comparison: Comparison;
  /** With `--precise`: how each provider was counted, and its totals at both commits. */
  providerMeasurements?: ProviderMeasurementMetadata[];
  providerTotals?: ProviderTotalDelta[];
}

export interface CompareOptions {
  mode?: MeasurementMode;
  model?: string | null;
}

function readCommits(repo: string, base: string, head: string, options: CompareOptions) {
  const measurer = createMeasurer(options.mode ?? "estimate", options.model ?? null);
  git(repo, ["rev-parse", "--git-dir"]);
  const ids = [commitId(repo, base), commitId(repo, head)] as const;
  const files = ids.map((id) => trackedFiles(repo, id));
  const measured = measureBlobs(repo, files.flat(), measurer);
  const [before, after] = files.map((snapshot): ComparedRevision => {
    const components = snapshot.map((file) => toComponent(file, measured.get(file.blob)!)).sort(byPath);
    return { components, estimatedTokens: summarize(components).estimatedTokens };
  });
  const delta: PullRequestDelta = {
    schemaVersion: 5,
    base: ids[0],
    head: ids[1],
    measurement: measurer.measurement,
    comparison: compareRevisions(before!, after!),
  };
  return { delta, files, measured };
}

/** Compare two Git commits without checking them out or writing into the target repository. */
export function compareGitCommits(
  repo: string,
  base: string,
  head: string,
  options: CompareOptions = {},
): PullRequestDelta {
  return readCommits(repo, base, head, options).delta;
}

/**
 * Compare two commits and add each provider's precise totals at both. A provider reads a file at a
 * commit by `providerReads`, with that commit's Gemini settings; the counts never mix providers.
 */
export async function compareGitCommitsPrecise(
  repo: string,
  base: string,
  head: string,
  options: CompareOptions & { providerPlan: ProviderCountPlan; onNotice?: (line: string) => void },
): Promise<PullRequestDelta> {
  const { delta, files, measured } = readCommits(repo, base, head, options);
  const all = files.flat();
  const configured = geminiSettings(repo, all, measured);
  const snapshots = files.map((snapshot) => {
    const settings = snapshot.find((file) => file.path === geminiSettingsPath);
    const names = settings ? (configured.get(settings.blob) ?? null) : null;
    return { snapshot, names };
  });
  const geminiBlobs = new Set(
    snapshots.flatMap(({ snapshot, names }) =>
      snapshot.filter((file) => providerReads(file.classification, "gemini", names)).map((file) => file.blob),
    ),
  );
  const { counts, metadata } = await countProviderBlobs(
    repo,
    all,
    measured,
    options.providerPlan,
    geminiBlobs,
    options.onNotice,
  );
  if (options.providerPlan.dryRun) return delta;
  const total = (index: number, provider: CountedProvider) => {
    const { snapshot, names } = snapshots[index]!;
    return snapshot.reduce(
      (sum, file) =>
        sum +
        (providerReads(file.classification, provider, names)
          ? (counts.get(`${provider}\0${file.blob}`)?.tokens ?? 0)
          : 0),
      0,
    );
  };
  return {
    ...delta,
    providerMeasurements: metadata,
    providerTotals: metadata.map(({ provider }) => {
      const beforeTokens = total(0, provider);
      const afterTokens = total(1, provider);
      return { provider, beforeTokens, afterTokens, deltaTokens: afterTokens - beforeTokens };
    }),
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

/** The precise-count table: each provider's totals under the method it was counted with. */
function providerLines(delta: PullRequestDelta): string[] {
  if (!delta.providerTotals?.length) return [];
  const signed = (value: number) => (value > 0 ? `+${value}` : String(value));
  const lines = ["| Provider | Counted with | Before | After | Δ tokens |", "| --- | --- | ---: | ---: | ---: |"];
  for (const totals of delta.providerTotals) {
    const measured = delta.providerMeasurements?.find(({ provider }) => provider === totals.provider);
    const how = !measured
      ? ""
      : measured.accuracy === "estimate"
        ? "byte estimate"
        : `${measured.accuracy}, ${measured.model}${measured.recipient ? ` via ${measured.recipient}` : ", local"}${measured.wrapperTokens ? `, less a ${measured.wrapperTokens}-token message wrapper per file` : ""}`;
    lines.push(
      `| ${providerName[totals.provider]} | ${cell(how)} | ${totals.beforeTokens} | ${totals.afterTokens} | ${signed(totals.deltaTokens)} |`,
    );
  }
  const sent = [...new Set((delta.providerMeasurements ?? []).flatMap(textRecipients))];
  lines.push(
    "",
    sent.length
      ? `Provider counts are separate and not added together. Instruction text was sent for counting to ${sent.map(cell).join(" and ")}.`
      : "Provider counts are separate and not added together. No instruction text was sent.",
    "",
  );
  return lines;
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
    ...providerLines(delta),
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
