import type { Component } from "./analyze.js";

export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TreemapLeaf extends Rectangle {
  path: string;
  provider: Component["provider"];
  category: Component["category"];
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

// Kept self-contained because the HTML report embeds this same function.
export function layoutTreemap(components: Component[]): TreemapLayout {
  type Box = { x: number; y: number; width: number; height: number };
  type Weighted<T> = { item: T; weight: number };
  const place = <T>(items: Weighted<T>[], box: Box): { item: T; box: Box }[] => {
    if (!items.length) return [];
    if (items.length === 1) return [{ item: items[0]!.item, box }];
    const total = items.reduce((sum, entry) => sum + entry.weight, 0);
    let cumulative = 0;
    let split = 1;
    let nearest = Infinity;
    for (let index = 1; index < items.length; index += 1) {
      cumulative += items[index - 1]!.weight;
      const difference = Math.abs(total / 2 - cumulative);
      if (difference < nearest) {
        nearest = difference;
        split = index;
      }
    }
    const first = items.slice(0, split);
    const second = items.slice(split);
    const ratio = first.reduce((sum, entry) => sum + entry.weight, 0) / total;
    if (box.width >= box.height) {
      const firstWidth = box.width * ratio;
      return [
        ...place(first, { x: box.x, y: box.y, width: firstWidth, height: box.height }),
        ...place(second, { x: box.x + firstWidth, y: box.y, width: box.width - firstWidth, height: box.height }),
      ];
    }
    const firstHeight = box.height * ratio;
    return [
      ...place(first, { x: box.x, y: box.y, width: box.width, height: firstHeight }),
      ...place(second, { x: box.x, y: box.y + firstHeight, width: box.width, height: box.height - firstHeight }),
    ];
  };

  const instructional = components.filter((component) => component.estimatedTokens !== null);
  const positive = instructional.filter((component) => component.estimatedTokens! > 0);
  const grouped = new Map<Component["category"], Component[]>();
  for (const component of positive) {
    const group = grouped.get(component.category) ?? [];
    group.push(component);
    grouped.set(component.category, group);
  }
  const categories = [...grouped.entries()].map(([category, members]) => ({
    category,
    members: members.sort((a, b) => b.estimatedTokens! - a.estimatedTokens! || a.path.localeCompare(b.path)),
    estimatedTokens: members.reduce((sum, member) => sum + member.estimatedTokens!, 0),
  })).sort((a, b) => b.estimatedTokens - a.estimatedTokens || a.category.localeCompare(b.category));
  const box = { x: 0, y: 0, width: 100, height: 100 };
  const groups = place(categories.map((category) => ({ item: category, weight: category.estimatedTokens })), box).map(({ item, box: bounds }) => ({
    category: item.category,
    estimatedTokens: item.estimatedTokens,
    ...bounds,
    leaves: place(item.members.map((component) => ({ item: component, weight: component.estimatedTokens! })), bounds).map(({ item: component, box: leaf }) => ({
      path: component.path,
      provider: component.provider,
      category: component.category,
      estimatedTokens: component.estimatedTokens!,
      ...leaf,
    })),
  }));
  return {
    groups,
    sourceOnlyCount: components.length - instructional.length,
    zeroTokenCount: instructional.length - positive.length,
    totalTokens: positive.reduce((sum, component) => sum + component.estimatedTokens!, 0),
  };
}
