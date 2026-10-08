import { categories, type Provider } from "./adapters.js";
import type { Revision } from "./analyze.js";

export type ProviderView = "all" | Provider;

/** Project a revision for display. Shared files overlap provider views but occur once in All. */
export function viewRevision(revision: Revision, view: ProviderView, previous?: Revision): Revision {
  if (view === "all") return revision;
  const includes = (provider: Provider) => provider === view || (provider === "shared" && view !== "shared" && view !== "unknown");
  const components = revision.components.filter((component) => includes(component.provider));
  const before = new Map(previous?.components.map((component) => [component.path, component]));
  const after = new Map(revision.components.map((component) => [component.path, component]));
  const categoryTotals = Object.fromEntries(categories.map((category) => [category, {
    count: 0, bytes: 0, estimatedTokens: 0, sourceOnlyCount: 0,
  }])) as Revision["categoryTotals"];
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
    skillGroups: revision.skillGroups.filter((group) => includes(group.provider)),
    categoryTotals,
    estimatedTokens: components.reduce((sum, component) => sum + (component.estimatedTokens ?? 0), 0),
    changes: revision.changes.flatMap((change) => {
      const oldComponent = before.get(change.previousPath ?? change.path);
      const newComponent = after.get(change.path);
      const oldVisible = oldComponent && includes(oldComponent.provider);
      const newVisible = newComponent && includes(newComponent.provider);
      if (oldVisible && newVisible) return [change];
      if (oldVisible) return [{ kind: "removed" as const, path: oldComponent.path, previousTokens: oldComponent.estimatedTokens,
        estimatedTokens: null, deltaTokens: -(oldComponent.estimatedTokens ?? 0) }];
      if (newVisible) return [{ kind: "added" as const, path: newComponent.path, previousTokens: null,
        estimatedTokens: newComponent.estimatedTokens, deltaTokens: newComponent.estimatedTokens ?? 0 }];
      return [];
    }),
  };
}
