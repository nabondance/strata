import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { git, gitText, listTree } from "./git.js";
import { trackedFile } from "./inventory.js";
import type { Submodule } from "./model.js";

/**
 * The submodule's own repository, when it is checked out at `path`. An empty submodule directory
 * would otherwise resolve to the parent repository, so the top level must be the directory itself.
 */
function checkout(root: string, path: string): string | null {
  const directory = join(root, path);
  if (!existsSync(join(directory, ".git"))) return null;
  try {
    const top = gitText(directory, ["rev-parse", "--show-toplevel"]);
    return realpathSync(top) === realpathSync(directory) ? top : null;
  } catch {
    return null;
  }
}

/**
 * Count the recognized agent-configuration files in each submodule at the commit the parent
 * records. Only Git objects are read, never the submodule's working tree; a submodule that is not
 * checked out, or lacks that commit, is counted as unknown.
 */
export function inspectSubmodules(root: string, commits: Map<string, string>): Submodule[] {
  return [...commits]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, commit]) => {
      const repo = checkout(root, path);
      if (!repo) return { path, configFiles: null };
      try {
        git(repo, ["cat-file", "-e", `${commit}^{commit}`]);
      } catch {
        return { path, configFiles: null };
      }
      const configFiles = listTree(repo, commit).filter(({ mode, blob, path }) => trackedFile(mode, blob, path)).length;
      return { path, configFiles };
    });
}
