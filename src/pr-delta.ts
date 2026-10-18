import { treeImports } from "./claude-imports.js";
import { type ComparedRevision, type Comparison, type ComponentDelta, compareRevisions } from "./compare.js";
import { geminiSettingsPath } from "./gemini-settings.js";
import { git, listTree } from "./git.js";
import {
  byPath,
  measureBlobs,
  summarize,
  type TrackedFile,
  toComponent,
  trackedFile,
  versionKey,
} from "./inventory.js";
import { createMeasurer, type Measurement, type MeasurementMode } from "./measurement.js";
import type { ClaudeImport } from "./model.js";
import {
  type CountedProvider,
  type ProviderCountPlan,
  type ProviderMeasurementMetadata,
  textRecipients,
} from "./provider-count.js";
import { countProviderBlobs, geminiSettings, providerName } from "./provider-counting.js";
import { providerReads } from "./provider-view.js";
import { rulesUpFront } from "./rule-loading.js";
import { type SkillListing, skillListings } from "./skill-listing.js";
import {
  hasUpFront,
  type SessionProvider,
  sessionProviderNames,
  sessionProviders,
  type UpFrontTotals,
  upFrontContext,
  upFrontTotals,
} from "./up-front.js";

type ComparedListing = NonNullable<ComponentDelta["listing"]>;

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

/** The recognized files in a commit's tree, followed by the files Claude imports there that no path rule recognizes. */
function trackedFiles(repo: string, id: string, imports: Map<string, ClaudeImport[]>): TrackedFile[] {
  const tree = listTree(repo, id);
  const recognized = tree.flatMap(({ mode, blob, path }) => trackedFile(mode, blob, path) ?? []);
  return [...recognized, ...treeImports(repo, tree, recognized, imports)];
}

export interface ProviderTotalDelta {
  provider: CountedProvider;
  beforeTokens: number;
  afterTokens: number;
  deltaTokens: number;
}

/** A provider's stored text listed up front at both commits, apart from what it reads on demand. */
export interface UpFrontDelta {
  provider: SessionProvider;
  before: UpFrontTotals;
  after: UpFrontTotals;
  deltaTokens: number;
  deltaOnDemandTokens: number;
}

export interface PullRequestDelta {
  schemaVersion: 10;
  base: string;
  head: string;
  measurement: Measurement;
  comparison: Comparison;
  /** Per provider that reads stored text at either commit, for a session started at the repository root. */
  upFront: UpFrontDelta[];
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
  const imports = new Map<string, ClaudeImport[]>();
  const files = ids.map((id) => trackedFiles(repo, id, imports));
  const measured = measureBlobs(repo, files.flat(), measurer);
  const listings = skillListings(repo, files.flat(), measured, measurer);
  const rules = rulesUpFront(repo, files.flat(), measured);
  const configured = geminiSettings(repo, files.flat(), measured);
  const snapshots = files.map((snapshot) => {
    const settings = snapshot.find((file) => file.path === geminiSettingsPath);
    return { snapshot, names: settings ? (configured.get(settings.blob) ?? null) : null };
  });
  const [before, after] = files.map((snapshot): ComparedRevision => {
    const components = snapshot
      .map((file) => {
        const key = versionKey(file.path, file.blob);
        return toComponent(
          file,
          measured.get(file.blob)!,
          undefined,
          listings.get(key),
          imports.get(key),
          rules.get(key),
        );
      })
      .sort(byPath);
    return { components, estimatedTokens: summarize(components).estimatedTokens };
  });
  const upFront = sessionProviders.flatMap((provider): UpFrontDelta[] => {
    const at = (side: ComparedRevision, index: number) =>
      upFrontTotals(upFrontContext(side.components, provider, snapshots[index]!.names));
    const totals = [at(before!, 0), at(after!, 1)] as const;
    if (!totals.some(hasUpFront)) return [];
    return [
      {
        provider,
        before: totals[0],
        after: totals[1],
        deltaTokens: totals[1].tokens - totals[0].tokens,
        deltaOnDemandTokens: totals[1].onDemandTokens - totals[0].onDemandTokens,
      },
    ];
  });
  const delta: PullRequestDelta = {
    schemaVersion: 10,
    base: ids[0],
    head: ids[1],
    measurement: measurer.measurement,
    comparison: compareRevisions(before!, after!),
    upFront,
  };
  return { delta, files, measured, snapshots };
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
  const { delta, files, measured, snapshots } = readCommits(repo, base, head, options);
  const all = files.flat();
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

/** A manifest's listing at one side, as the file table shows it. */
function listed(listing: SkillListing | null): string {
  return !listing ? "none" : listing.status === "listed" ? String(listing.tokens) : listing.status;
}

/**
 * What each agent lists up front, for the providers whose up-front or on-demand text changed, or a
 * line saying neither did. The unresolved counts follow, so a fixed frontmatter is not read as growth.
 */
function upFrontLines(delta: PullRequestDelta): string[] {
  if (!delta.upFront.length) return [];
  const signed = (value: number) => (value > 0 ? `+${value}` : String(value));
  const intro =
    "Listed up front, the stored text an agent keeps from the start of a session at the repository root (root instructions, rules that load at launch, Claude imports, and skill names and descriptions), apart from the rest it reads on demand; both are stored text, not loaded context or billing tokens";
  const changed = delta.upFront.filter((entry) => entry.deltaTokens || entry.deltaOnDemandTokens);
  if (!changed.length) return [`${intro}: unchanged.`, ""];
  const lines = [
    `${intro}:`,
    "",
    "| Agent | Up front | Δ up front | On demand | Δ on demand |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...changed.map(
      ({ provider, before, after, deltaTokens, deltaOnDemandTokens }) =>
        `| ${sessionProviderNames[provider]} | ${before.tokens} → ${after.tokens} | ${signed(deltaTokens)} | ${before.onDemandTokens} → ${after.onDemandTokens} | ${signed(deltaOnDemandTokens)} |`,
    ),
    "",
  ];
  const unresolved = changed.filter(
    ({ before, after }) => before.unresolved || after.unresolved || before.listingUnresolved || after.listingUnresolved,
  );
  if (unresolved.length) {
    lines.push(
      `Not counted up front because Strata could not tell whether they load: ${unresolved
        .map(
          ({ provider, before, after }) =>
            `${sessionProviderNames[provider]} ${before.unresolved + before.listingUnresolved} → ${after.unresolved + after.listingUnresolved}`,
        )
        .join(
          ", ",
        )} (root rules or skill manifests whose frontmatter it could not read, and the legacy \`.cursorrules\`).`,
      "",
    );
  }
  return lines;
}

export function renderPullRequestDelta(delta: PullRequestDelta): string {
  const comparison = delta.comparison;
  const signed = (value: number) => (value > 0 ? `+${value}` : String(value));
  const skills = comparison.skillListing;
  const listingLine =
    skills.beforeManifests || skills.afterManifests
      ? [
          `Skill listings, the names and descriptions an agent keeps in context before a skill is used: **${signed(skills.deltaTokens)}** tokens (${skills.beforeTokens} → ${skills.afterTokens}), measured separately from the stored text above; do not add them.` +
            (skills.beforeUnresolved || skills.afterUnresolved
              ? ` Manifests with unreadable frontmatter, not counted: ${skills.beforeUnresolved} → ${skills.afterUnresolved}.`
              : ""),
          "",
        ]
      : [];
  const listingColumn = comparison.components.some((component) => component.listing);
  // Both sides listed: the token change; otherwise each side's state, such as a manifest added or hidden.
  const listingCell = (listing: ComparedListing | undefined) =>
    !listing
      ? " —"
      : listing.before?.status === "listed" && listing.after?.status === "listed"
        ? ` ${signed(listing.deltaTokens)}`
        : ` ${listed(listing.before)} → ${listed(listing.after)}`;
  const lines = [
    "## Strata configuration delta",
    "",
    `Base \`${delta.base.slice(0, 12)}\` → head \`${delta.head.slice(0, 12)}\``,
    "",
    `Stored instructional text: **${signed(comparison.deltaTokens)}** tokens (${comparison.beforeTokens} → ${comparison.afterTokens}); tracked files: **${signed(comparison.deltaFiles)}** (${comparison.beforeFiles} → ${comparison.afterFiles}).`,
    "",
    `Method: ${cell(delta.measurement.method)}. ${cell(delta.measurement.limitations)}`,
    "",
    ...listingLine,
    ...upFrontLines(delta),
    ...providerLines(delta),
    "| Category | Δ files | Δ tokens |",
    "| --- | ---: | ---: |",
    ...comparison.byCategory
      .filter((group) => group.deltaFiles || group.deltaTokens)
      .map((group) => `| ${cell(group.key)} | ${signed(group.deltaFiles)} | ${signed(group.deltaTokens)} |`),
    "",
    listingColumn ? "| File | Change | Δ tokens | Δ listed |" : "| File | Change | Δ tokens |",
    listingColumn ? "| --- | --- | ---: | ---: |" : "| --- | --- | ---: |",
    ...comparison.components
      .slice(0, 25)
      .map(
        (component) =>
          `| ${cell(component.path)} | ${component.kind}${component.imported ? " (imported)" : ""} | ${signed(component.deltaTokens)} |${listingColumn ? `${listingCell(component.listing)} |` : ""}`,
      ),
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
