import type { Component } from "./model.js";

/** How a `@path` import fared at one revision. */
export type ImportStatus = "resolved" | "missing" | "external" | "depth-limit";

/** A `links to` edge from a Claude instruction file to the file a `@path` import names, at one revision. */
export interface ImportLink {
  kind: "links to";
  evidence: "claude-import";
  source: string;
  /** 1-based line of the import in `source`. */
  line: number;
  /**
   * The repository path the import names, whether or not a file has it, or null when it is external.
   * When it resolves through a symlink, the file the link leads to, with the path named in `symlink`.
   */
  target: string | null;
  /** Imports from `source` to the file it names; 1 for an import in a root file. */
  hop: number;
  status: ImportStatus;
  /** Set when the import points outside the repository, including one past the depth limit, whose status is `depth-limit`. */
  external?: true;
  /** Set when the import resolved through a symlink: the path the import names. */
  symlink?: string;
}

type Importing = Pick<Component, "path" | "contextFile" | "importRoot" | "imports">;

/**
 * The `@path` imports Claude Code follows from a revision's inventory. Expansion starts at each
 * `CLAUDE.md` and `CLAUDE.local.md` (marked `importRoot`) and follows
 * imports to the files present, by the shortest chain, up to four hops; then it starts again at each
 * `AGENTS.md` (`agents-md` context file) those chains did not reach. A file reached in four hops is
 * loaded, but its own imports are not: those are `depth-limit`. An import of a path no file in the
 * inventory has is `missing`, unless the path is a symlink whose `symlinkTarget` the inventory has,
 * which it then reaches; one outside the repository is `external`. Labels decide the roots,
 * not paths, so a shareable report gives the same edges. Given `roots`, expansion starts only at
 * those of them that are import roots, in the same order. The HTML report embeds this function's
 * source, so it must stay self-contained.
 */
export function importLinks(components: readonly Importing[], roots?: readonly Importing[]): ImportLink[] {
  const maxHops = 4;
  const byPath = new Map(components.map((component) => [component.path, component]));
  const hops = new Map<string, number>();
  const queue: Importing[] = [];
  const links: ImportLink[] = [];
  const expand = (roots: Importing[]) => {
    const start = queue.length;
    for (const root of roots) {
      if (hops.has(root.path)) continue;
      hops.set(root.path, 0);
      queue.push(root);
    }
    for (let index = start; index < queue.length; index += 1) {
      const source = queue[index]!;
      const hop = hops.get(source.path)! + 1;
      for (const { line, target, external, symlinkTarget } of source.imports ?? []) {
        const direct = target === null ? undefined : byPath.get(target);
        // A path that was a symlink somewhere in the history leads to its file wherever the path has none.
        const linked = direct || symlinkTarget === undefined ? undefined : byPath.get(symlinkTarget);
        const reached = direct ?? linked;
        // Claude Code does not expand a file past the limit at all, so even its external imports are `depth-limit`.
        const status: ImportStatus =
          hop > maxHops ? "depth-limit" : external ? "external" : reached ? "resolved" : "missing";
        links.push({
          kind: "links to",
          evidence: "claude-import",
          source: source.path,
          line,
          target: linked ? symlinkTarget! : target,
          hop,
          status,
          ...(external ? { external } : {}),
          ...(linked ? { symlink: target! } : {}),
        });
        if (status === "resolved" && reached && !hops.has(reached.path)) {
          hops.set(reached.path, hop);
          queue.push(reached);
        }
      }
    }
  };
  // `AGENTS.md` starts a chain only when no `CLAUDE.md` chain reaches it; one that is imported is a hop on that chain.
  const starts = roots ?? components;
  expand(starts.filter((component) => component.importRoot && component.contextFile !== "agents-md"));
  expand(starts.filter((component) => component.importRoot && component.contextFile === "agents-md"));
  return links;
}
