import type { ImportLink } from "./import-links.js";
import type { Component } from "./model.js";

type Mapped = Pick<Component, "path" | "category" | "estimatedTokens">;

/** One line of the configuration map: a folder or a file, in display order. */
export interface MapRow {
  kind: "folder" | "file";
  /** The file's path, or the folder's path without a trailing slash. */
  path: string;
  /** The file name, or the folder name joined by slashes to any chain of single folders below it. */
  label: string;
  /** 0 for entries at the repository root. */
  depth: number;
  /** The row of the folder holding this one, or -1 at the root. */
  parent: number;
  /** 1-based place among the entries of the same folder, and how many entries that folder shows. */
  position: number;
  siblings: number;
  /** The file's index in the given components; files only. */
  component?: number;
  /** Files at or under this row, and how many of them are source-only. */
  files: number;
  sourceOnly: number;
  /** Stored-text tokens of the file or of every file under the folder; null for a source-only file. */
  tokens: number | null;
  /** Tokens by category, largest first. A source-only file lists its category with 0. */
  categories: { category: Component["category"]; tokens: number }[];
  /** Folders only: whether the map hides what the folder holds. */
  collapsed?: boolean;
  /** Folders only: the paths of the folders the row stands for, outermost first; the last is `path`. */
  chain?: string[];
  /** Imports from the files this row shows that do not resolve to a tracked file. */
  unresolved: number;
}

/** A line from the row of an importing file to the row of the file it imports. */
export interface MapEdge {
  /** Rows of the importing and the imported file, or of the collapsed folders holding them. */
  from: number;
  to: number;
  /** The resolved imports the line stands for; more than one when collapsed folders merge them. */
  links: ImportLink[];
}

export interface ConfigMap {
  rows: MapRow[];
  edges: MapEdge[];
  /** For each given component, the row that shows it: its own, or that of the collapsed folder holding it. */
  rowOf: number[];
  /** Resolved imports between files that one collapsed folder holds, which have no line to draw. */
  folded: number;
  /** Resolved imports whose importing or imported file is not among the given components. */
  offMap: number;
  /** Unresolved imports, whether or not the importing file is on the map. */
  unresolved: number;
  /** Stored-text tokens of every file on the map. */
  totalTokens: number;
  /** Folders under the root, shown or not. */
  folders: number;
  /** For each importing path, the paths its resolved imports reach, other than itself, in link order. */
  targets: Map<string, string[]>;
  /** For each imported path, the paths that import it, other than itself, in link order. */
  sources: Map<string, string[]>;
}

export interface MapOptions {
  /**
   * Folders the reader opened (false) or closed (true), by path; these override `fallback`. A row that
   * several folders share is closed when any of them was closed and open when any was opened, so a choice
   * made at one revision holds at another where the folders share rows differently.
   */
  toggled?: ReadonlyMap<string, boolean>;
  /**
   * How other folders start. `auto` opens folders level by level, as deep as it can while the map keeps
   * to 80 rows, and always opens the folders at the repository root; `expanded` and `collapsed` open or
   * close them all.
   */
  fallback?: "auto" | "expanded" | "collapsed";
}

/**
 * Lay out a revision's files as a folder tree, with a line for each resolved Claude `@path` import whose
 * two files are both on the map. A folder contains its files; that is all the tree says. A line is a
 * `links to` edge from `importLinks`, not proof that a session loaded the file. Unresolved imports are
 * counted on the row of the importing file, never drawn, and a file importing itself gets no line. Folders come before files, each sorted by name,
 * and a folder holding only one folder shares its row, so `.claude/skills` takes one line when `.claude`
 * holds nothing else. The HTML report embeds this function's source, so it must stay self-contained.
 */
export function configMap(
  components: readonly Mapped[],
  links: readonly ImportLink[],
  options: MapOptions = {},
): ConfigMap {
  interface Folder {
    name: string;
    path: string;
    folders: Map<string, Folder>;
    files: number[];
    count: number;
    sourceOnly: number;
    tokens: number;
    categories: Map<Component["category"], number>;
  }
  const folder = (name: string, path: string): Folder => ({
    name,
    path,
    folders: new Map(),
    files: [],
    count: 0,
    sourceOnly: 0,
    tokens: 0,
    categories: new Map(),
  });
  const root = folder("", "");
  let folders = 0;
  for (const [index, component] of components.entries()) {
    const parts = component.path.split("/");
    const tokens = component.estimatedTokens;
    let at = root;
    const add = (into: Folder) => {
      into.count += 1;
      if (tokens === null) into.sourceOnly += 1;
      into.tokens += tokens ?? 0;
      into.categories.set(component.category, (into.categories.get(component.category) ?? 0) + (tokens ?? 0));
    };
    add(root);
    for (const [depth, name] of parts.slice(0, -1).entries()) {
      let next = at.folders.get(name);
      if (!next) {
        next = folder(name, parts.slice(0, depth + 1).join("/"));
        at.folders.set(name, next);
        folders += 1;
      }
      at = next;
      add(at);
    }
    at.files.push(index);
  }

  const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const names = components.map((component) => component.path.split("/").at(-1)!);
  // A folder holding only one folder shares its row with it; the row is named by the chain and opens the last.
  const shown = (start: Folder) => {
    let at = start;
    let label = start.name;
    const chain = [start.path];
    while (!at.files.length && at.folders.size === 1) {
      at = at.folders.values().next().value!;
      label += `/${at.name}`;
      chain.push(at.path);
    }
    return { at, label, chain };
  };
  // Each folder's entries are sorted once and reused by every pass below.
  type Entry = number | ReturnType<typeof shown>;
  const sorted = new Map<Folder, Entry[]>();
  const entries = (at: Folder): Entry[] => {
    let list = sorted.get(at);
    if (!list) {
      list = [
        ...[...at.folders.values()].sort((a, b) => byName(a.name, b.name)).map((child) => shown(child)),
        ...[...at.files].sort((a, b) => byName(names[a]!, names[b]!)),
      ];
      sorted.set(at, list);
    }
    return list;
  };

  // `auto` opens one more level at a time while the whole map stays within the row budget. The reader's own
  // toggles are left out of this, so opening one folder never closes another.
  const fallback = options.fallback ?? "auto";
  const toggled = options.toggled ?? new Map<string, boolean>();
  const rowsWithin = (at: Folder, depth: number, open: number): number =>
    entries(at).reduce<number>(
      (sum, entry) =>
        sum + 1 + (typeof entry === "number" || depth >= open ? 0 : rowsWithin(entry.at, depth + 1, open)),
      0,
    );
  // Folders at a depth below `openDepth` start open.
  let openDepth = fallback === "expanded" ? Number.POSITIVE_INFINITY : fallback === "collapsed" ? 0 : 1;
  if (fallback === "auto") {
    let count = rowsWithin(root, 0, openDepth);
    for (;;) {
      const deeper = rowsWithin(root, 0, openDepth + 1);
      if (deeper > 80 || deeper === count) break;
      openDepth += 1;
      count = deeper;
    }
  }

  const rows: MapRow[] = [];
  const rowOf: number[] = new Array(components.length).fill(-1);
  const ranked = (categories: Map<Component["category"], number>) =>
    [...categories.entries()]
      .map(([category, tokens]) => ({ category, tokens }))
      .sort((a, b) => b.tokens - a.tokens || byName(a.category, b.category));
  const holdAll = (at: Folder, row: number) => {
    for (const index of at.files) rowOf[index] = row;
    for (const child of at.folders.values()) holdAll(child, row);
  };
  const walk = (at: Folder, depth: number, parent: number) => {
    const list = entries(at);
    for (const [place, entry] of list.entries()) {
      const row = rows.length;
      if (typeof entry === "number") {
        const component = components[entry]!;
        const tokens = component.estimatedTokens;
        rows.push({
          kind: "file",
          path: component.path,
          label: names[entry]!,
          depth,
          parent,
          position: place + 1,
          siblings: list.length,
          component: entry,
          files: 1,
          sourceOnly: tokens === null ? 1 : 0,
          tokens,
          categories: [{ category: component.category, tokens: tokens ?? 0 }],
          unresolved: 0,
        });
        rowOf[entry] = row;
        continue;
      }
      const choices = entry.chain.map((path) => toggled.get(path));
      const collapsed = choices.includes(true) ? true : choices.includes(false) ? false : depth >= openDepth;
      rows.push({
        kind: "folder",
        path: entry.at.path,
        label: entry.label,
        depth,
        parent,
        position: place + 1,
        siblings: list.length,
        files: entry.at.count,
        sourceOnly: entry.at.sourceOnly,
        tokens: entry.at.tokens,
        categories: ranked(entry.at.categories),
        collapsed,
        chain: entry.chain,
        unresolved: 0,
      });
      if (collapsed) holdAll(entry.at, row);
      else walk(entry.at, depth + 1, row);
    }
  };
  walk(root, 0, -1);

  const rowByPath = new Map(components.map((component, index) => [component.path, rowOf[index]!]));
  const edges = new Map<string, MapEdge>();
  let folded = 0;
  let offMap = 0;
  let unresolved = 0;
  const targets = new Map<string, string[]>();
  const sources = new Map<string, string[]>();
  const listed = (lists: Map<string, string[]>, key: string, value: string) => {
    const list = lists.get(key);
    if (list) list.push(value);
    else lists.set(key, [value]);
  };
  for (const link of links) {
    const from = rowByPath.get(link.source);
    // Every unresolved import counts, as in the imports table; only one from a file on the map marks a row.
    if (link.status !== "resolved") {
      if (from !== undefined) rows[from]!.unresolved += 1;
      unresolved += 1;
      continue;
    }
    // A file that imports itself links nothing to anything else.
    if (link.target === link.source) continue;
    listed(targets, link.source, link.target!);
    listed(sources, link.target!, link.source);
    const to = link.target === null ? undefined : rowByPath.get(link.target);
    if (from === undefined || to === undefined) offMap += 1;
    else if (to === from) folded += 1;
    else {
      const key = `${from}>${to}`;
      const edge = edges.get(key) ?? { from, to, links: [] };
      edge.links.push(link);
      edges.set(key, edge);
    }
  }
  return {
    rows,
    edges: [...edges.values()].sort((a, b) => a.from - b.from || a.to - b.to),
    rowOf,
    folded,
    offMap,
    unresolved,
    totalTokens: root.tokens,
    folders,
    targets,
    sources,
  };
}
