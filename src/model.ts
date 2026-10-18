import type { Category, ContextFile, Provider } from "./adapters.js";
import type { Measurement } from "./measurement.js";
import type { ProviderMeasurementMetadata, ProviderTextCount } from "./provider-count.js";
import type { SkillListing } from "./skill-listing.js";

export type CountedProvider = ProviderTextCount["provider"];

/** One version of one tracked file: a path together with the blob stored there. */
export interface Component {
  path: string;
  provider: Provider;
  /**
   * The providers documented as reading its path: on a shared component, and on another tool's file
   * Cursor reads, only in a history with Cursor configuration. See `providerReads` for conditions.
   */
  readers?: Provider[];
  /** On `AGENTS.md` (`agents-md`) and `GEMINI.md` (`gemini-md`): Gemini CLI reads it only while `context.fileName` names it. */
  contextFile?: ContextFile;
  category: Category;
  /** On a format its provider documents as superseded but still reads: the root `.cursorrules`. */
  legacy?: true;
  blob: string;
  bytes: number;
  estimatedTokens: number | null;
  providerTokenCounts?: Partial<Record<CountedProvider, ProviderTextCount>>;
  /** On a skill manifest, `listing` measures the frontmatter text an agent lists before the skill is used. */
  skill?: { root: string; role: "manifest" | "resource"; listing?: SkillListing };
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
  schemaVersion: 14;
  repository: string;
  branch: string;
  shallow: boolean;
  /** Submodules at the last revision, when there are any. Their files are never analyzed. */
  submodules?: Submodule[];
  privacy: { mode: "local" | "shareable" };
  measurement: Measurement;
  providerMeasurements?: ProviderMeasurementMetadata[];
  /** Every distinct file version in the history, once each, ordered by path. */
  components: Component[];
  revisions: Revision[];
}
