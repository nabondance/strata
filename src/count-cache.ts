import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CountCache } from "./provider-count.js";

/**
 * Where remote counts are kept between runs: `STRATA_CACHE_DIR`, or the platform's user cache
 * directory. The file holds only endpoint families, model names, Git blob IDs, and token counts.
 */
export function defaultCachePath(env: NodeJS.ProcessEnv = process.env): string {
  const directory =
    env.STRATA_CACHE_DIR ||
    (process.platform === "darwin"
      ? join(homedir(), "Library", "Caches", "strata")
      : process.platform === "win32"
        ? join(env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "strata")
        : join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "strata"));
  return join(directory, "provider-counts.json");
}

export interface FileCountCache extends CountCache {
  /** Write new counts back, readable by the owner only. Nothing is written when nothing changed. */
  save(): void;
}

/** A count cache backed by one JSON file. A missing or unreadable file starts an empty cache. */
export function fileCountCache(path: string): FileCountCache {
  let counts: Record<string, number> = {};
  try {
    const stored = JSON.parse(readFileSync(path, "utf8"));
    if (stored?.version === 1 && stored.counts && typeof stored.counts === "object") counts = stored.counts;
  } catch {
    // Start empty: a cache only saves requests.
  }
  let changed = false;
  return {
    get: (key) => {
      const value = counts[key];
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
    },
    set: (key, tokens) => {
      if (counts[key] === tokens) return;
      counts[key] = tokens;
      changed = true;
    },
    save: () => {
      if (!changed) return;
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      // Write beside the cache and rename, so a concurrent run never reads a half-written file.
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify({ version: 1, counts })}\n`, { mode: 0o600 });
      chmodSync(temporary, 0o600);
      renameSync(temporary, path);
      changed = false;
    },
  };
}
