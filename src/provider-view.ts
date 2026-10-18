import { type ContextFile, categories, type Provider } from "./adapters.js";
import type { Component, RevisionSnapshot } from "./model.js";

export type ProviderView = "all" | Provider;

type Readable = Pick<Component, "provider" | "readers" | "contextFile">;

/**
 * Whether a provider reads a file at a revision: its own files and files that list it as a reader,
 * with two conditions. Gemini CLI reads `AGENTS.md` and `GEMINI.md` only while a revision's
 * `geminiContextFiles` names them (`GEMINI.md` alone by default). Cursor reads files it does not own,
 * such as `AGENTS.md` or `.claude/skills`, only at a revision that tracks Cursor configuration
 * (`cursorConfigured`). Labels decide this, not paths, so a shareable report gives the same answer.
 * The HTML report embeds this function's source, so it must stay self-contained.
 */
export function providerReads(
  entry: Readable,
  provider: Provider,
  geminiContextFiles?: readonly ContextFile[] | null,
  cursorConfigured?: boolean,
): boolean {
  if (provider === "gemini" && entry.contextFile)
    return (geminiContextFiles ?? ["gemini-md"]).includes(entry.contextFile);
  if (entry.provider === provider) return true;
  if (provider === "cursor" && !cursorConfigured) return false;
  return !!entry.readers?.includes(provider);
}

/**
 * Project a revision for display. A file appears in the view of each provider that reads it, by
 * `providerReads`, and once in All. A settings change can bring a Gemini context file into or out
 * of the Gemini view without changing the file, and adding or removing the last Cursor file brings
 * `AGENTS.md` and other files Cursor reads for compatibility into or out of the Cursor view; given
 * the report's `table`, such a file is listed as added or removed. The HTML report embeds this function's source, so it may use only its
 * arguments, `categories`, and `providerReads`.
 */
export function viewRevision(
  revision: RevisionSnapshot,
  view: ProviderView,
  previous?: RevisionSnapshot,
  table?: readonly Component[],
): RevisionSnapshot {
  if (view === "all") return revision;
  // A revision tracks Cursor configuration when it holds any file labeled Cursor.
  const cursorAt = (at: RevisionSnapshot | undefined) =>
    !!at?.components.some((component) => component.provider === "cursor");
  const cursorNow = cursorAt(revision);
  const cursorBefore = cursorAt(previous);
  const includes = (entry: Readable, at: RevisionSnapshot | undefined) =>
    view === "shared" || view === "unknown"
      ? entry.provider === view
      : providerReads(entry, view, at?.geminiContextFiles, at === revision ? cursorNow : cursorBefore);
  const components = revision.components.filter((component) => includes(component, revision));
  const before = new Map(previous?.components.map((component) => [component.path, component]));
  const after = new Map(revision.components.map((component) => [component.path, component]));
  const categoryTotals = Object.fromEntries(
    categories.map((category) => [
      category,
      {
        count: 0,
        bytes: 0,
        estimatedTokens: 0,
        sourceOnlyCount: 0,
      },
    ]),
  ) as RevisionSnapshot["categoryTotals"];
  for (const component of components) {
    const total = categoryTotals[component.category];
    total.count += 1;
    total.bytes += component.bytes;
    total.estimatedTokens += component.estimatedTokens ?? 0;
    if (component.estimatedTokens === null) total.sourceOnlyCount += 1;
  }
  return {
    ...revision,
    components,
    componentCount: components.length,
    skillGroups: revision.skillGroups.filter((group) => includes(group, revision)),
    categoryTotals,
    estimatedTokens: components.reduce((sum, component) => sum + (component.estimatedTokens ?? 0), 0),
    skillListingTokens: components.reduce((sum, component) => sum + (component.skill?.listing?.tokens ?? 0), 0),
    skillListingUnresolved: components.filter((component) => component.skill?.listing?.status === "unresolved").length,
    changes: [...revision.changes, ...flips()].flatMap((change) => {
      const oldComponent = before.get(change.previousPath ?? change.path);
      const newComponent = after.get(change.path);
      const oldVisible = oldComponent && includes(oldComponent, previous);
      const newVisible = newComponent && includes(newComponent, revision);
      if (oldVisible && newVisible) return [change];
      if (oldVisible)
        return [
          {
            kind: "removed" as const,
            path: oldComponent.path,
            previousTokens: oldComponent.estimatedTokens,
            estimatedTokens: null,
            deltaTokens: -(oldComponent.estimatedTokens ?? 0),
            component: null,
          },
        ];
      if (newVisible)
        return [
          {
            kind: "added" as const,
            path: newComponent.path,
            previousTokens: null,
            estimatedTokens: newComponent.estimatedTokens,
            deltaTokens: newComponent.estimatedTokens ?? 0,
            component: change.component,
          },
        ];
      return [];
    }),
  };

  /** Unchanged files whose visibility a settings change flipped, as edits for the mapping above. */
  function flips(): RevisionSnapshot["changes"] {
    if (!previous || !table) return [];
    if (previous.geminiContextFiles === revision.geminiContextFiles && cursorBefore === cursorNow) return [];
    const touched = new Set(revision.changes.flatMap((change) => [change.path, change.previousPath]));
    return revision.components.flatMap((component) =>
      before.get(component.path) === component &&
      !touched.has(component.path) &&
      includes(component, previous) !== includes(component, revision)
        ? [
            {
              kind: "modified" as const,
              path: component.path,
              previousTokens: component.estimatedTokens,
              estimatedTokens: component.estimatedTokens,
              deltaTokens: 0,
              component: table.indexOf(component),
            },
          ]
        : [],
    );
  }
}
