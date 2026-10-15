import type { Category, ContextFile, Provider } from "./adapters.js";
import type { Measurement } from "./measurement.js";
import type { ProviderMeasurementMetadata, ProviderTextCount } from "./provider-count.js";

export type CountedProvider = ProviderTextCount["provider"];

/** One version of one tracked file: a path together with the blob stored there. */
export interface Component {
  path: string;
  provider: Provider;
  /** On a shared component, the providers documented as reading its path. */
  readers?: Provider[];
  /** On `AGENTS.md` (`agents-md`) and `GEMINI.md` (`gemini-md`): Gemini CLI reads it only while `context.fileName` names it. */
  contextFile?: ContextFile;
  category: Category;
  blob: string;
  bytes: number;
  estimatedTokens: number | null;
  providerTokenCounts?: Partial<Record<CountedProvider, ProviderTextCount>>;
  skill?: { root: string; role: "manifest" | "resource" };
}

export interface SkillGroup {
  root: string;
  provider: Provider;
  readers?: Provider[];
  manifestPath: string | null;
  manifestEstimatedTokens: number;
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

export interface Report {
  schemaVersion: 10;
  repository: string;
  branch: string;
  shallow: boolean;
  privacy: { mode: "local" | "shareable" };
  measurement: Measurement;
  providerMeasurements?: ProviderMeasurementMetadata[];
  /** Every distinct file version in the history, once each, ordered by path. */
  components: Component[];
  revisions: Revision[];
}
