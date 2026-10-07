import type { Component, Revision } from "./analyze.js";

export interface ComparisonDelta {
  key: string;
  beforeFiles: number;
  afterFiles: number;
  deltaFiles: number;
  beforeTokens: number;
  afterTokens: number;
  deltaTokens: number;
}

export interface ComponentDelta {
  path: string;
  provider: Component["provider"];
  category: Component["category"];
  kind: "added" | "removed" | "edited";
  beforeTokens: number | null;
  afterTokens: number | null;
  deltaFiles: number;
  deltaTokens: number;
}

export interface Comparison {
  beforeTokens: number;
  afterTokens: number;
  deltaTokens: number;
  percentChange: number | null;
  beforeFiles: number;
  afterFiles: number;
  deltaFiles: number;
  byProvider: ComparisonDelta[];
  byCategory: ComparisonDelta[];
  components: ComponentDelta[];
}

// This function is also embedded in the standalone HTML report. Keep its runtime
// dependencies inside the function so the browser uses the same comparison logic.
export function compareRevisions(baseline: Revision, target: Revision): Comparison {
  const groups = (keyFor: (component: Component) => string): ComparisonDelta[] => {
    const totals = new Map<string, ComparisonDelta>();
    const add = (component: Component, side: "before" | "after") => {
      const key = keyFor(component);
      let total = totals.get(key);
      if (!total) {
        total = { key, beforeFiles: 0, afterFiles: 0, deltaFiles: 0, beforeTokens: 0, afterTokens: 0, deltaTokens: 0 };
        totals.set(key, total);
      }
      if (side === "before") {
        total.beforeFiles += 1;
        total.beforeTokens += component.estimatedTokens ?? 0;
      } else {
        total.afterFiles += 1;
        total.afterTokens += component.estimatedTokens ?? 0;
      }
    };
    baseline.components.forEach((component) => add(component, "before"));
    target.components.forEach((component) => add(component, "after"));
    return [...totals.values()].map((total) => ({
      ...total,
      deltaFiles: total.afterFiles - total.beforeFiles,
      deltaTokens: total.afterTokens - total.beforeTokens,
    })).sort((a, b) => a.key.localeCompare(b.key));
  };

  const identity = (component: Component) => `${component.provider}\0${component.category}\0${component.path}`;
  const before = new Map(baseline.components.map((component) => [identity(component), component]));
  const after = new Map(target.components.map((component) => [identity(component), component]));
  const components: ComponentDelta[] = [];
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const oldComponent = before.get(key);
    const newComponent = after.get(key);
    if (oldComponent?.blob === newComponent?.blob) continue;
    const component = newComponent ?? oldComponent!;
    components.push({
      path: component.path,
      provider: component.provider,
      category: component.category,
      kind: !oldComponent ? "added" : !newComponent ? "removed" : "edited",
      beforeTokens: oldComponent?.estimatedTokens ?? null,
      afterTokens: newComponent?.estimatedTokens ?? null,
      deltaFiles: Number(Boolean(newComponent)) - Number(Boolean(oldComponent)),
      deltaTokens: (newComponent?.estimatedTokens ?? 0) - (oldComponent?.estimatedTokens ?? 0),
    });
  }
  components.sort((a, b) => Math.abs(b.deltaTokens) - Math.abs(a.deltaTokens) || a.path.localeCompare(b.path));

  const deltaTokens = target.estimatedTokens - baseline.estimatedTokens;
  return {
    beforeTokens: baseline.estimatedTokens,
    afterTokens: target.estimatedTokens,
    deltaTokens,
    percentChange: baseline.estimatedTokens === 0 ? null : deltaTokens / baseline.estimatedTokens * 100,
    beforeFiles: baseline.components.length,
    afterFiles: target.components.length,
    deltaFiles: target.components.length - baseline.components.length,
    byProvider: groups((component) => component.provider),
    byCategory: groups((component) => component.category),
    components,
  };
}
