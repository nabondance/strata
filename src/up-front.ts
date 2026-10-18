import type { ContextFile, Provider } from "./adapters.js";
import { importLinks } from "./import-links.js";
import type { Component } from "./model.js";
import { providerReads } from "./provider-view.js";

/** The tools whose sessions start with stored text; `shared` and `unknown` are labels, not tools. */
export type SessionProvider = Exclude<Provider, "shared" | "unknown">;
export const sessionProviders = ["claude", "codex", "copilot", "cursor", "gemini"] as const satisfies SessionProvider[];
export const sessionProviderNames: Record<SessionProvider, string> = {
  claude: "Claude Code",
  codex: "Codex",
  copilot: "Copilot",
  cursor: "Cursor",
  gemini: "Gemini CLI",
};

/**
 * What one provider keeps from the start of a session at the repository root, apart from the rest
 * of the stored text it reads. Both are stored-text measurements, not loaded context or billing.
 */
export interface UpFrontContext {
  provider: SessionProvider;
  /** Files the provider keeps from the start: root instructions, rules that load at launch, and what Claude imports from them. */
  files: Component[];
  /** Stored-text tokens of `files`. */
  fileTokens: number;
  /** Of `files`, those measured in source bytes only, whose text is not counted. */
  sourceOnly: number;
  /** Listed tokens of the skill manifests the provider reads; never part of `fileTokens`. */
  listingTokens: number;
  /** Skill manifests the provider reads whose listing is unresolved and left out of `listingTokens`. */
  listingUnresolved: number;
  /** `fileTokens` plus `listingTokens`: the stored text listed up front. */
  tokens: number;
  /**
   * Stored-text tokens of every other file the provider reads, kept for later, for a session started
   * in a subdirectory, or for other work such as code review; never the files in `skipped`.
   */
  onDemandTokens: number;
  /**
   * Root files the provider reads by convention but skips by default at this revision: `AGENTS.md`
   * beside a root Claude file for Claude Code, or beside a non-empty `AGENTS.override.md` for Codex.
   */
  skipped: number;
  /** Stored-text tokens of `skipped`. */
  skippedTokens: number;
  /** Files counted on demand that may be read up front, because Strata cannot tell. */
  unresolved: number;
}

/**
 * Split what a provider reads at one revision into the stored text it keeps from the start of a
 * session at the repository root and the rest. Up front are the root instruction files labeled
 * `upFront: "listed"` that the provider reads by `providerReads`, its own root rules labeled the
 * same way, and, for Claude, every file reached by `@path` imports from those, plus the listings
 * of the skill manifests it reads. Two defaults decide between root files: Claude Code reads
 * `AGENTS.md` only without a root `CLAUDE.md`, `.claude/CLAUDE.md`, or `CLAUDE.local.md`, and Codex
 * reads a non-empty `AGENTS.override.md` instead of `AGENTS.md`. Everything else the provider reads
 * is on demand: nested instructions, path-scoped rules, skill manifests, commands, agents, and
 * memory, except the root `AGENTS.md` those defaults skip, counted in `skipped`. Claude keeps a
 * file its imports reach even when another tool owns it, so its up-front files can include one
 * the Claude view does not list. Labels decide this, not paths, so a shareable report gives the same answer. The HTML
 * report embeds this function's source, so it may use only its arguments, `providerReads`, and
 * `importLinks`.
 */
export function upFrontContext(
  components: readonly Component[],
  provider: SessionProvider,
  geminiContextFiles?: readonly ContextFile[] | null,
): UpFrontContext {
  const configured = components.some((component) => component.provider === provider);
  const reads = components.filter((component) => providerReads(component, provider, geminiContextFiles, configured));
  // A rule's frontmatter is read by the tool that owns it; another tool reading its folder applies its own rules.
  const counts = (component: Component) => component.category !== "rules" || component.provider === provider;
  const claudeRoot = reads.some(
    (component) =>
      component.provider === "claude" &&
      component.category === "instructions" &&
      component.upFront === "listed" &&
      !component.imported,
  );
  const override = reads.some(
    (component) => component.provider === "codex" && component.upFront === "listed" && component.bytes > 0,
  );
  const skip = (component: Component) =>
    component.upFront === "listed" &&
    component.contextFile === "agents-md" &&
    ((provider === "claude" && claudeRoot) || (provider === "codex" && override));
  const direct = reads.filter((component) => component.upFront === "listed" && counts(component) && !skip(component));
  const kept = new Set(direct.map((component) => component.path));
  if (provider === "claude") {
    for (const link of importLinks(components, direct)) {
      if (link.status === "resolved" && link.target !== null) kept.add(link.target);
    }
  }
  // An import loads its target whoever owns it, so Claude keeps another tool's file it imports.
  const files = (provider === "claude" ? components : reads).filter((component) => kept.has(component.path));
  const fileTokens = files.reduce((sum, component) => sum + (component.estimatedTokens ?? 0), 0);
  let listingTokens = 0;
  let listingUnresolved = 0;
  let onDemandTokens = 0;
  let unresolved = 0;
  let skipped = 0;
  let skippedTokens = 0;
  for (const component of reads) {
    if (component.skill?.role === "manifest") {
      listingTokens += component.skill.listing?.tokens ?? 0;
      if (component.skill.listing?.status === "unresolved") listingUnresolved += 1;
    }
    if (kept.has(component.path)) continue;
    if (skip(component)) {
      skipped += 1;
      skippedTokens += component.estimatedTokens ?? 0;
      continue;
    }
    onDemandTokens += component.estimatedTokens ?? 0;
    if (component.upFront === "unresolved" && counts(component)) unresolved += 1;
  }
  return {
    provider,
    files,
    fileTokens,
    sourceOnly: files.filter((component) => component.estimatedTokens === null).length,
    listingTokens,
    listingUnresolved,
    tokens: fileTokens + listingTokens,
    onDemandTokens,
    skipped,
    skippedTokens,
    unresolved,
  };
}

/** A provider's up-front totals at one side of a comparison, without the file list. */
export type UpFrontTotals = Omit<UpFrontContext, "provider" | "files"> & { fileCount: number };

export function upFrontTotals(context: UpFrontContext): UpFrontTotals {
  const { provider: _provider, files, ...totals } = context;
  return { ...totals, fileCount: files.length };
}

/** Whether a provider has stored text to split at all: tokens either side, or something unresolved. */
export function hasUpFront(totals: UpFrontTotals): boolean {
  return !!(
    totals.tokens ||
    totals.onDemandTokens ||
    totals.fileCount ||
    totals.skipped ||
    totals.listingUnresolved ||
    totals.unresolved
  );
}
