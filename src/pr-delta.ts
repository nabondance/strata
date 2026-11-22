import { pluginCandidate } from "./adapters.js";
import { treeImports } from "./claude-imports.js";
import {
  type ComparedRevision,
  type Comparison,
  type ComponentDelta,
  compareRevisions,
  type McpServerRef,
  type PluginComparisonRef,
  type PluginStateChange,
} from "./compare.js";
import { ContentPass } from "./content-pass.js";
import { signed } from "./format.js";
import { geminiSettingsPath } from "./gemini-settings.js";
import { blobSizes, git, isPartialClone, listTree, resolveCommit } from "./git.js";
import { ignoreMatcher } from "./ignore.js";
import {
  byPath,
  distinctBlobs,
  measureBlobs,
  pluginCandidateFile,
  summarize,
  TokenCounts,
  type TrackedFile,
  toComponent,
  trackedFile,
  versionKey,
} from "./inventory.js";
import { keepsUpFront, type LimitCheck, type LimitFigures, limitLines } from "./limits.js";
import { McpServerLists } from "./mcp-servers.js";
import { createMeasurer, type Measurement } from "./measurement.js";
import type { ClaudeImport, PluginCatalog, PluginState } from "./model.js";
import { confirmedPackages, isPluginPackageFile, PluginLists, packagesLeftOutNotice } from "./plugins.js";
import {
  type CountedProvider,
  type ProviderCountPlan,
  type ProviderMeasurementMetadata,
  textRecipients,
} from "./provider-count.js";
import { countProviderBlobs, countsLocally, GeminiSettings, providerName, TextCheck } from "./provider-counting.js";
import { providerReads } from "./provider-view.js";
import { RuleLoading } from "./rule-loading.js";
import { type SkillListing, SkillListings } from "./skill-listing.js";
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

/** Resolve a revision expression, such as `HEAD~3` or a short ID, to its full commit ID; `side` names it in the error. */
function commitId(repo: string, revision: string, side: "Base" | "Head"): string {
  const id = resolveCommit(repo, revision);
  if (id === null) {
    throw new Error(
      `${side} ${JSON.stringify(revision)} does not name a commit in this repository; check it, or fetch it if this clone lacks it`,
    );
  }
  return id;
}

/**
 * The recognized files in a commit's tree, followed by the files Claude imports there that no path
 * rule recognizes, and the plugin packages `confirmed` by content. All of them are added to `pass`, which
 * import parsing hands what it reads. The tree already leaves out what `--ignore` matches.
 */
function trackedFiles(
  repo: string,
  tree: ReturnType<typeof listTree>,
  imports: Map<string, ClaudeImport[]>,
  pass: ContentPass,
  confirmed: ReadonlySet<string>,
  leftOut: ReadonlySet<string>,
): TrackedFile[] {
  const recognized = tree.flatMap(({ mode, blob, path }) =>
    leftOut.has(path) ? [] : (trackedFile(mode, blob, path) ?? []),
  );
  pass.add(recognized);
  const found = treeImports(repo, tree, recognized, imports, (blob, body) => pass.offer(blob, body));
  const packages = tree.flatMap(({ mode, blob, path }) => {
    const file = pluginCandidateFile(mode, blob, path);
    return file && confirmed.has(versionKey(path, blob)) ? [file] : [];
  });
  // A package keeps its label while a Claude import reaches it, as in `strata analyze`.
  const packaged = new Set(packages.map((file) => file.path));
  const imported = found.filter((file) => !packaged.has(file.path));
  pass.add(imported);
  pass.add(packages);
  return [...recognized, ...imported, ...packages];
}

/** The files in a tree that are plugin packages by name, or may be by content. */
const packageFiles = (tree: ReturnType<typeof listTree>) =>
  tree.flatMap(({ mode, blob, path }) => {
    const file = trackedFile(mode, blob, path);
    if (file) return file.classification.pluginPackage ? [file] : [];
    return pluginCandidateFile(mode, blob, path) ?? [];
  });

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
  schemaVersion: 15;
  base: string;
  head: string;
  /** The `--ignore` patterns, as given, when there were any: both trees leave out the paths they match. */
  ignore?: string[];
  /** Set on a partial clone with files that may be plugin manifests or marketplaces, which Strata did not read. */
  pluginPackagesLeftOut?: true;
  measurement: Measurement;
  comparison: Comparison;
  /** Per provider that reads stored text at either commit, for a session started at the repository root. */
  upFront: UpFrontDelta[];
  /** How each provider was counted (Codex always, Claude and Gemini with `--precise`), and its totals at both commits. */
  providerMeasurements?: ProviderMeasurementMetadata[];
  providerTotals?: ProviderTotalDelta[];
  /** With limits such as `--limit-tokens`: each limit checked, in the comparison's measurement. */
  limits?: LimitCheck[];
}

/** With `text`, the shared read also finds which instruction blobs are blank or not UTF-8, for provider counts. */
function readCommits(
  repo: string,
  base: string,
  head: string,
  ignore: readonly string[],
  text?: TextCheck,
  onNotice?: (line: string) => void,
) {
  const measurer = createMeasurer("estimate");
  const ignored = ignoreMatcher(ignore);
  git(repo, ["rev-parse", "--git-dir"]);
  const ids = [commitId(repo, base, "Base"), commitId(repo, head, "Head")] as const;
  // Each tree keeps its own imports, since a symlink an import names can lead elsewhere in the other.
  const imports = ids.map(() => new Map<string, ClaudeImport[]>());
  // One shared pass reads each blob whose content any step needs, once.
  const tokens = new TokenCounts(measurer);
  const gemini = new GeminiSettings();
  const skills = new SkillListings(measurer);
  const ruleLoading = new RuleLoading();
  const mcpLists = new McpServerLists();
  const partial = isPartialClone(repo);
  const pluginLists = new PluginLists(partial);
  const pass = new ContentPass([tokens, gemini, skills, ruleLoading, mcpLists, pluginLists, ...(text ? [text] : [])]);
  const trees = ids.map((id) => listTree(repo, id).filter(({ path }) => !ignored(path)));
  // A partial clone may lack any version, so it leaves plugin packages out at both commits.
  const packages = trees.flatMap(packageFiles);
  const leftOut = new Set(partial ? packages.map((file) => file.path) : []);
  const confirmed = partial
    ? new Set<string>()
    : confirmedPackages(
        repo,
        packages.filter((file) => pluginCandidate(file.path)),
      );
  const files = trees.map((tree, index) => trackedFiles(repo, tree, imports[index]!, pass, confirmed, leftOut));
  const packagesUnread = leftOut.size > 0 || (partial && files.flat().some((file) => isPluginPackageFile(file)));
  if (packagesUnread) onNotice?.(packagesLeftOutNotice);
  const sizes = blobSizes(repo, distinctBlobs(files.flat()));
  pass.run(repo, sizes);
  const measured = measureBlobs(files.flat(), sizes, measurer, tokens);
  const listings = skills.listings;
  const rules = ruleLoading.upFront;
  const mcp = mcpLists.lists;
  const plugins = pluginLists.lists;
  const configured = gemini.configured;
  const snapshots = files.map((snapshot) => {
    const settings = snapshot.find((file) => file.path === geminiSettingsPath);
    return { snapshot, names: settings ? (configured.get(settings.blob) ?? null) : null };
  });
  const [before, after] = files.map((snapshot, index): ComparedRevision => {
    const components = snapshot
      .map((file) => {
        const key = versionKey(file.path, file.blob);
        return toComponent(
          file,
          measured.get(file.blob)!,
          undefined,
          listings.get(key),
          imports[index]!.get(key),
          rules.get(key),
          mcp.get(key),
          plugins.get(key),
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
    schemaVersion: 15,
    base: ids[0],
    head: ids[1],
    ...(ignore.length ? { ignore: [...ignore] } : {}),
    ...(packagesUnread ? { pluginPackagesLeftOut: true as const } : {}),
    measurement: measurer.measurement,
    comparison: compareRevisions(before!, after!),
    upFront,
  };
  return { delta, files, measured, snapshots };
}

/** The figures a comparison's limits are checked against: the stored-text total and each agent's session-start tokens. */
export function limitFigures(delta: PullRequestDelta): LimitFigures {
  const { comparison, upFront } = delta;
  return {
    total: { before: comparison.beforeTokens, after: comparison.afterTokens },
    upFront: new Map(
      upFront
        .filter(({ before, after }) => keepsUpFront(before) || keepsUpFront(after))
        .map((entry) => [entry.provider, { before: entry.before.tokens, after: entry.after.tokens }]),
    ),
  };
}

/**
 * Compare two Git commits without checking them out or writing into the target repository. Paths
 * matching an `ignore` pattern, read as `.gitignore` reads it, are left out of both trees.
 */
export function compareGitCommits(
  repo: string,
  base: string,
  head: string,
  options: { ignore?: readonly string[]; onNotice?: (line: string) => void } = {},
): PullRequestDelta {
  return readCommits(repo, base, head, options.ignore ?? [], undefined, options.onNotice).delta;
}

/**
 * Compare two commits and add each provider's own totals at both: Codex counted locally, and Claude
 * and Gemini too with `--precise`. A provider reads a file at a commit by `providerReads`, with that
 * commit's Gemini settings; the counts never mix providers.
 */
export async function compareGitCommitsWithProviders(
  repo: string,
  base: string,
  head: string,
  options: { providerPlan: ProviderCountPlan; onNotice?: (line: string) => void; ignore?: readonly string[] },
): Promise<PullRequestDelta> {
  const text = new TextCheck(countsLocally(options.providerPlan));
  const { delta, files, measured, snapshots } = readCommits(
    repo,
    base,
    head,
    options.ignore ?? [],
    text,
    options.onNotice,
  );
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
    text,
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
  // No counted provider reads stored text at either commit: the delta has no provider fields.
  if (!metadata.length) return delta;
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
    .replace(/\p{Cc}/gu, " ")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/([`*_[\]])/g, "\\$1");
}

/** The provider-count table: each provider's totals under the method it was counted with. */
function providerLines(delta: PullRequestDelta): string[] {
  if (!delta.providerTotals?.length) return [];
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
  const intro =
    "At session start: what each agent reads when a session opens at the repository root, and what it reads only when needed";
  const changed = delta.upFront.filter((entry) => entry.deltaTokens || entry.deltaOnDemandTokens);
  if (!changed.length) return [`${intro}: unchanged.`, ""];
  const lines = [
    `${intro}:`,
    "",
    "| Agent | At start | Δ at start | When needed | Δ when needed |",
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
      `Maybe read at start, counted as when needed: ${unresolved
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

/**
 * The MCP servers tracked files define at each commit, and the names added or removed, when either
 * commit has a file that can define them. A file that cannot be read is counted on its own.
 */
function mcpLines(delta: PullRequestDelta): string[] {
  const mcp = delta.comparison.mcp;
  if (!mcp) return [];
  const names = (refs: McpServerRef[]) => {
    const shown = refs.slice(0, 10).map((ref) => `${cell(ref.name)} (${cell(ref.path)})`);
    return shown.join(", ") + (refs.length > 10 ? `, and ${refs.length - 10} more` : "");
  };
  const parts = [
    `MCP servers the tracked files define: **${signed(mcp.deltaServers)}** (${mcp.beforeServers} → ${mcp.afterServers}).`,
  ];
  if (mcp.added.length) parts.push(`Added: ${names(mcp.added)}.`);
  if (mcp.removed.length) parts.push(`Removed: ${names(mcp.removed)}.`);
  if (mcp.beforeUnresolved || mcp.afterUnresolved) {
    parts.push(`Files whose servers could not be read, not counted: ${mcp.beforeUnresolved} → ${mcp.afterUnresolved}.`);
  }
  parts.push(
    "Defined is not loaded: some tools ask before starting a project server and others start it once the folder is trusted, and the tool definitions a server sends are not measured.",
  );
  return [parts.join(" "), ""];
}

const pluginStateLabels: Record<PluginState, string> = {
  enabled: "enabled",
  disabled: "turned off",
  configured: "configured with a list",
  defined: "defined here",
  catalog: "marketplace file",
  marketplace: "registered marketplace",
  "skills-folder": "in .claude/skills, loads unless turned off",
};

const pluginLabel = (state: PluginState, listed?: PluginCatalog) =>
  listed
    ? `${pluginStateLabels[state]}, ${listed.local + listed.external} plugin${listed.local + listed.external === 1 ? "" : "s"} (${listed.local} by relative path)`
    : pluginStateLabels[state];

/**
 * The plugins tracked files name at each commit, and what changed, when either commit has a file
 * that names them. The same plugin named by two files is two references, each with its own state.
 */
function pluginLines(delta: PullRequestDelta): string[] {
  const plugins = delta.comparison.plugins;
  if (!plugins) return [];
  const capped = <T>(refs: T[], line: (ref: T) => string) =>
    refs.slice(0, 10).map(line).join(", ") + (refs.length > 10 ? `, and ${refs.length - 10} more` : "");
  const entry = (ref: PluginComparisonRef) =>
    `${cell(ref.name)}, ${pluginLabel(ref.state, ref.listed)} (${cell(ref.path)})`;
  const parts = [
    `Agent plugin references in tracked files: **${signed(plugins.deltaPlugins)}** (${plugins.beforePlugins} → ${plugins.afterPlugins}).`,
  ];
  if (plugins.added.length) parts.push(`Added: ${capped(plugins.added, entry)}.`);
  if (plugins.removed.length) parts.push(`Removed: ${capped(plugins.removed, entry)}.`);
  if (plugins.changed.length) {
    const change = (ref: PluginStateChange) =>
      `${cell(ref.name)}, ${pluginLabel(ref.before, ref.beforeListed)} → ${pluginLabel(ref.after, ref.afterListed)} (${cell(ref.path)})`;
    parts.push(`Changed: ${capped(plugins.changed, change)}.`);
  }
  if (plugins.beforeUnresolved || plugins.afterUnresolved) {
    parts.push(
      `Files whose plugins could not be read at either commit, left out of this comparison: ${plugins.beforeUnresolved} → ${plugins.afterUnresolved}.`,
    );
  }
  parts.push(
    "Enabled is not installed, and defined is not active. Strata does not fetch or estimate what a plugin outside this repository adds.",
  );
  return [parts.join(" "), ""];
}

export function renderPullRequestDelta(delta: PullRequestDelta): string {
  const comparison = delta.comparison;
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
    ...(delta.ignore?.length
      ? [
          `Left out at both commits: paths matching ${delta.ignore.map(cell).join(", ")} (\`--ignore\`). The totals cover the rest of the repository.`,
          "",
        ]
      : []),
    ...(delta.limits ? limitLines(delta.limits) : []),
    `Stored instructional text: **${signed(comparison.deltaTokens)}** tokens (${comparison.beforeTokens} → ${comparison.afterTokens}); tracked files: **${signed(comparison.deltaFiles)}** (${comparison.beforeFiles} → ${comparison.afterFiles}).`,
    "",
    `Method: ${cell(delta.measurement.method)}. ${cell(delta.measurement.limitations)}`,
    "",
    ...listingLine,
    ...mcpLines(delta),
    ...(delta.pluginPackagesLeftOut ? [packagesLeftOutNotice, ""] : []),
    ...pluginLines(delta),
    ...upFrontLines(delta),
    ...providerLines(delta),
    // With no changed file, both tables would have headers only.
    ...(!comparison.components.length
      ? ["No instruction files changed."]
      : [
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
        ]),
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
