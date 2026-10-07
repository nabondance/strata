import { hierarchy, treemap } from "d3-hierarchy";
import type { Component } from "./analyze.js";

export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TreemapLeaf extends Rectangle {
  componentIndex: number;
  estimatedTokens: number;
}

export interface TreemapGroup extends Rectangle {
  category: Component["category"];
  estimatedTokens: number;
  leaves: TreemapLeaf[];
}

export interface TreemapLayout {
  groups: TreemapGroup[];
  sourceOnlyCount: number;
  zeroTokenCount: number;
  totalTokens: number;
}

interface LayoutDatum {
  key: string;
  category?: Component["category"];
  componentIndex?: number;
  weight?: number;
  children?: LayoutDatum[];
}

export function layoutTreemap(components: Component[]): TreemapLayout {
  const grouped = new Map<Component["category"], LayoutDatum[]>();
  let sourceOnlyCount = 0;
  let zeroTokenCount = 0;
  let totalTokens = 0;
  for (const [componentIndex, component] of components.entries()) {
    const tokens = component.estimatedTokens;
    if (tokens === null) {
      sourceOnlyCount += 1;
    } else if (tokens === 0) {
      zeroTokenCount += 1;
    } else {
      const leaves = grouped.get(component.category) ?? [];
      leaves.push({ key: component.path, componentIndex, weight: tokens });
      grouped.set(component.category, leaves);
      totalTokens += tokens;
    }
  }
  if (!totalTokens) return { groups: [], sourceOnlyCount, zeroTokenCount, totalTokens };

  const data: LayoutDatum = {
    key: "root",
    children: [...grouped.entries()].map(([category, children]) => ({ key: category, category, children })),
  };
  const root = hierarchy(data, (datum) => datum.children)
    .sum((datum) => datum.weight ?? 0)
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0) || a.data.key.localeCompare(b.data.key));
  const laidOut = treemap<LayoutDatum>().size([100, 100]).round(false)(root);
  const groups = (laidOut.children ?? []).map((group) => ({
    category: group.data.category!,
    estimatedTokens: group.value ?? 0,
    x: group.x0,
    y: group.y0,
    width: group.x1 - group.x0,
    height: group.y1 - group.y0,
    leaves: (group.children ?? []).map((leaf) => ({
      componentIndex: leaf.data.componentIndex!,
      estimatedTokens: leaf.value ?? 0,
      x: leaf.x0,
      y: leaf.y0,
      width: leaf.x1 - leaf.x0,
      height: leaf.y1 - leaf.y0,
    })),
  }));
  return { groups, sourceOnlyCount, zeroTokenCount, totalTokens };
}
