import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { git, listTree } from "./git.js";
import { trackedFile } from "./inventory.js";
import type { Submodule } from "./model.js";

/**
 * Git commands in a submodule run with the parent's Git variables removed, so they read the
 * submodule's own objects, and without lazy fetching, so a partial clone never reaches the network.
 */
function submoduleEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_NO_LAZY_FETCH: "1" };
  for (const name of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_COMMON_DIR",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  ]) {
    delete env[name];
  }
  return env;
}

/**
 * The submodule's own repository, when it is checked out at `path` inside the parent. Its top level
 * must be the submodule directory itself, so a directory that resolves to another repository is skipped.
 */
function checkout(root: string, path: string, env: NodeJS.ProcessEnv): string | null {
  const directory = join(root, path);
  if (!existsSync(join(directory, ".git"))) return null;
  try {
    const real = realpathSync(directory);
    const inside = relative(realpathSync(root), real);
    if (!inside || isAbsolute(inside) || inside === ".." || inside.startsWith(`..${sep}`)) return null;
    const top = git(directory, ["rev-parse", "--show-toplevel"], undefined, env).toString("utf8").trim();
    return realpathSync(top) === real ? top : null;
  } catch {
    return null;
  }
}

/** Regular files whose path is recognized inside the submodule or where it is mounted in the parent. */
function countConfigFiles(repo: string, commit: string, mount: string, env: NodeJS.ProcessEnv): number {
  return listTree(repo, commit, env).filter(
    ({ mode, blob, path }) => trackedFile(mode, blob, path) || trackedFile(mode, blob, `${mount}/${path}`),
  ).length;
}

/**
 * Count the recognized agent-configuration files in each submodule at the commit the parent
 * records. Only Git objects are read, never the submodule's working tree; a submodule that is not
 * checked out, or lacks that commit, is counted as unknown.
 */
export function inspectSubmodules(root: string, commits: Map<string, string>): Submodule[] {
  const env = submoduleEnv();
  return [...commits]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, commit]) => {
      const repo = checkout(root, path, env);
      if (!repo) return { path, configFiles: null };
      try {
        git(repo, ["cat-file", "-e", `${commit}^{commit}`], undefined, env);
        return { path, configFiles: countConfigFiles(repo, commit, path, env) };
      } catch {
        return { path, configFiles: null };
      }
    });
}
