import { categories, type Provider } from "./adapters.js";
import type { RevisionSnapshot } from "./model.js";

export type ProviderView = "all" | Provider;

/**
 * Project a revision for display. A shared file appears in the view of each provider that reads it,
 * and once in All. Gemini reads a shared `AGENTS.md` only in revisions whose settings name it, so a
 * settings change can bring that file into or out of the Gemini view without changing the file.
 * The HTML report embeds this function's source, so it may use only its arguments and `categories`.
 */
export function viewRevision(
  revision: RevisionSnapshot,
  view: ProviderView,
  previous?: RevisionSnapshot,
): RevisionSnapshot {
  if (view === "all") return revision;
  const includes = (
    entry: { provider: Provider; readers?: Provider[]; path?: string },
    at: Pick<RevisionSnapshot, "geminiReadsAgentsMd"> | undefined,
  ) =>
    entry.provider === view ||
    (entry.provider === "shared" &&
      (view === "shared" ||
        !!entry.readers?.includes(view) ||
        (view === "gemini" && !!at?.geminiReadsAgentsMd && entry.path?.split("/").at(-1) === "AGENTS.md")));
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
    changes: revision.changes.flatMap((change) => {
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
}
