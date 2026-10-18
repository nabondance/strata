import { hierarchy, treemap } from "d3-hierarchy";
import type { Component } from "./model.js";

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
  /** Whether the layout kept room for the category's name above its files. */
  headed: boolean;
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

/**
 * The space to lay the treemap out in. Without one, the layout fills a 100 by 100 square with no gaps,
 * so every rectangle's area is exactly its share of the tokens. The report passes its drawn size in
 * pixels, so gaps and category headers keep the same size whatever the treemap's shape.
 */
export interface TreemapFrame {
  width: number;
  height: number;
  /** Space between categories. */
  gap?: number;
  /** Space between files in one category. */
  seam?: number;
  /** Height kept at the top of a category for its name, when the category is large enough to spare it. */
  header?: number;
  /**
   * How many times wider than tall the layout aims to make each rectangle. Labels run horizontally,
   * so a wide rectangle fits a file name that a square one would break mid-word. Areas are unaffected.
   */
  wide?: number;
}

/** The HTML report embeds this function's source; it may use only its arguments, `hierarchy`, and `treemap`. */
export function layoutTreemap(components: Component[], frame?: TreemapFrame): TreemapLayout {
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
  const width = frame?.width ?? 100;
  const height = frame?.height ?? 100;
  const header = frame?.header ?? 0;
  const headed = new Set<string>();
  // Squarify in a space stretched vertically, then shrink it back, so its square tiles come out wide.
  const squarify = treemap<LayoutDatum>().tile();
  const wide = frame?.wide ?? 1;
  // d3 positions a category before its files, so the header can depend on the category's own size.
  const laidOut = treemap<LayoutDatum>()
    .size([width, height])
    .round(false)
    .tile((node, x0, y0, x1, y1) => {
      squarify(node, x0, y0 * wide, x1, y1 * wide);
      for (const child of node.children ?? []) {
        child.y0 /= wide;
        child.y1 /= wide;
      }
    })
    .paddingInner((node) => (node.depth === 0 ? (frame?.gap ?? 0) : (frame?.seam ?? 0)))
    .paddingTop((node) => {
      if (!header || node.depth !== 1 || node.x1 - node.x0 < header * 4 || node.y1 - node.y0 < header * 3) return 0;
      headed.add(node.data.key);
      return header;
    })(root);
  const groups = (laidOut.children ?? []).map((group) => ({
    category: group.data.category!,
    estimatedTokens: group.value ?? 0,
    headed: headed.has(group.data.key),
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
