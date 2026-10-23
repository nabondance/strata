import type { Category, ContextFile, Provider, UpFront } from "./adapters.js";
import type { Measurement } from "./measurement.js";
import type { ProviderMeasurementMetadata, ProviderTextCount } from "./provider-count.js";
import type { SkillListing } from "./skill-listing.js";

export type CountedProvider = ProviderTextCount["provider"];

/** A `@path` import in a Claude instruction file, or in Markdown an import reaches. */
export interface ClaudeImport {
  /** 1-based line of the import. */
  line: number;
  /**
   * The repository path it names, resolved against the importing file's directory. Null when it
   * points outside the repository (`external`), or names a path no regular file has anywhere in the
   * analyzed history, whose text is then not stored.
   */
  target: string | null;
  /** Set when the import names a home-directory or absolute path, or climbs above the repository root. */
  external?: true;
}

/** An MCP server a tracked file defines, by name. Its command, URL, arguments, and environment are never stored. */
export interface McpServer {
  name: string;
  /** `local` starts a process on the developer's machine; `remote` connects to a URL. */
  transport: "local" | "remote" | "unknown";
  /** Set when the file turns the server off, as Codex's `enabled = false` does. */
  disabled?: true;
}

/**
 * The MCP servers one version of a file defines: `listed` when Strata could read them, which may be
 * none, or `unresolved` when the file does not parse in its tool's format. Defined is not loaded:
 * some tools ask before starting a project server, others start it once the folder is trusted, and
 * user configuration is outside Git.
 */
export type McpServers = { status: "listed"; servers: McpServer[] } | { status: "unresolved" };

/** One version of one tracked file: a path together with the blob stored there. */
export interface Component {
  path: string;
  provider: Provider;
  /**
   * The providers documented as reading its path: on a shared component, and on another tool's file
   * Cursor or Copilot reads, only in a history with that tool's configuration. See `providerReads`
   * for conditions.
   */
  readers?: Provider[];
  /** On `AGENTS.md` (`agents-md`) and `GEMINI.md` (`gemini-md`): Gemini CLI reads it only while `context.fileName` names it. */
  contextFile?: ContextFile;
  category: Category;
  /** On a format its provider documents as superseded but still reads: the root `.cursorrules` and Copilot's `.chatmode.md`. */
  legacy?: true;
  blob: string;
  bytes: number;
  estimatedTokens: number | null;
  providerTokenCounts?: Partial<Record<CountedProvider, ProviderTextCount>>;
  /**
   * Present only on files no path rule recognizes, which are in an inventory because a Claude
   * `@path` import reaches them there. Markdown is measured as instructions; anything else is source-only.
   */
  imported?: true;
  /** The `@path` imports in this version of a file whose imports Claude Code can expand, in source order. */
  imports?: ClaudeImport[];
  /** On a `CLAUDE.md`, `CLAUDE.local.md`, or `AGENTS.md` with `imports`: Claude Code starts expanding imports here. */
  importRoot?: true;
  /**
   * On a root instruction file, or a root rule whose frontmatter loads it at launch: its readers keep
   * it from the start of a session at the repository root (`listed`), or may (`unresolved`). Which
   * reader does is decided per revision by `upFrontContext`.
   */
  upFront?: UpFront;
  /** On a skill manifest, `listing` measures the frontmatter text an agent lists before the skill is used. */
  skill?: { root: string; role: "manifest" | "resource"; listing?: SkillListing };
  /** On an MCP configuration file, or a Gemini CLI or Codex settings file that mentions MCP servers. */
  mcp?: McpServers;
}

export interface SkillGroup {
  root: string;
  provider: Provider;
  readers?: Provider[];
  manifestPath: string | null;
  manifestEstimatedTokens: number;
  /** The manifest's listing; null without a manifest. Measured separately; never add it to the manifest's tokens. */
  listing: SkillListing | null;
  resourceCount: number;
  resourceBytes: number;
}

export interface Change {
  kind: "added" | "removed" | "modified" | "renamed";
  path: string;
  previousPath?: string;
  previousTokens: number | null;
  estimatedTokens: number | null;
  deltaTokens: number;
  /** Index into `Report.components` of the file version now at `path`; null when the file was removed. */
  component: number | null;
}

/**
 * What a revision did to the age of its instruction text: the bytes of trimmed, nonblank lines it
 * added, and the bytes it removed by the revision those lines had appeared at. Lines are matched by
 * exact text across all instructional files, so a moved line keeps its age; see `LineAges`.
 */
export interface LineAgeChange {
  /** Stored bytes (UTF-8 for text) of the line copies that first appear at this revision. */
  added: number;
  /** Bytes removed, grouped by `from`, the index in `Report.revisions` where they had appeared; oldest first. */
  removed?: Array<{ from: number; bytes: number }>;
}

export type CategoryTotals = Record<
  Category,
  { count: number; bytes: number; estimatedTokens: number; sourceOnlyCount: number }
>;

/**
 * A revision as stored in a report: its totals and what it changed. Its file inventory is not
 * repeated; `expandRevisions` rebuilds it by replaying `changes` from the first revision.
 */
export interface Revision {
  id: string;
  date: string;
  firstParent: string | null;
  componentCount: number;
  categoryTotals: CategoryTotals;
  estimatedTokens: number;
  /**
   * Listed tokens of the skill manifests present. Measured separately and mostly drawn from text
   * `estimatedTokens` already counts, so never add the two.
   */
  skillListingTokens: number;
  /** Skill manifests present whose listing is unresolved, so `skillListingTokens` leaves them out. */
  skillListingUnresolved: number;
  changes: Change[];
  providerTokenTotals?: Partial<Record<CountedProvider, number>>;
  /**
   * Present when the root `.gemini/settings.json` sets `context.fileName`: labels of the recognized
   * files it names. Absent means Gemini CLI's default, `GEMINI.md` only.
   */
  geminiContextFiles?: ContextFile[];
  /** Present when the revision added or removed instruction lines. `instructionAges` replays these. */
  lineAge?: LineAgeChange;
}

/** A revision together with its rebuilt inventory. Unchanged revisions share one inventory. */
export interface RevisionSnapshot extends Revision {
  components: Component[];
  skillGroups: SkillGroup[];
}

/** A submodule: a commit from another repository, whose files are not part of this history. */
export interface Submodule {
  path: string;
  /**
   * Recognized agent-configuration files in the submodule at the commit the parent records, or
   * null when that commit could not be read because the submodule is not checked out or lacks it.
   */
  configFiles: number | null;
}

export interface Report {
  schemaVersion: 19;
  repository: string;
  branch: string;
  /** The first revision is where a shallow fetch cut the history: it has a parent that was not fetched. */
  shallow: boolean;
  /** Submodules at the last revision, when there are any. Their files are never analyzed. */
  submodules?: Submodule[];
  privacy: { mode: "local" | "shareable" };
  measurement: Measurement;
  providerMeasurements?: ProviderMeasurementMetadata[];
  /** How `lineAge` matches and weighs lines. */
  lineAgeMethod: "exact-trimmed-line-multiset-stored-bytes-v1";
  /** Every distinct file version in the history, once each, ordered by path. */
  components: Component[];
  revisions: Revision[];
}
