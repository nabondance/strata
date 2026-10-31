/** Whether a repository-relative path is left out of analysis, as if it were not in the tree. */
export type Ignored = (path: string) => boolean;

/** Leaves nothing out: analysis without `--ignore`. */
export const ignoreNothing: Ignored = () => false;

const special = /[.+^${}()|[\]\\]/g;

/** One path segment's pattern: `*` is any run of characters but `/`, `?` one such character. */
function segment(part: string): string {
  return part.replace(special, "\\$&").replace(/\*+/g, "[^/]*").replace(/\?/g, "[^/]");
}

/**
 * Compile a pattern as `.gitignore` reads one, for files only: `*` and `?` stay within a segment;
 * `**` as a whole segment spans any number of folders (`**\/x`, `a/**`, `a/**\/b`); a trailing `/`
 * matches only a folder, so everything under it; a `/` at the start or in the middle anchors the
 * pattern at the repository root, and a pattern with no other `/` matches at any depth. A pattern
 * that matches a folder matches every file under it. Other characters, `[` and `\`
 * included, match themselves, and `!` patterns are refused rather than read as re-including a path.
 */
export function ignorePattern(pattern: string): RegExp {
  if (!pattern.trim()) throw new Error("An ignore pattern cannot be empty");
  if (pattern.startsWith("!")) throw new Error(`Ignore patterns cannot re-include paths: ${pattern}`);
  const folder = pattern.endsWith("/");
  const body = pattern.replace(/\/+$/, "");
  const anchored = body.includes("/");
  const parts = body
    .replace(/^\/+/, "")
    .split("/")
    .filter((part, index, all) => part !== "**" || all[index - 1] !== "**");
  if (!parts.join("")) throw new Error(`An ignore pattern must name a path: ${pattern}`);
  let source = "";
  for (const [index, part] of parts.entries()) {
    if (part === "**") {
      const last = index === parts.length - 1;
      source += index === 0 ? (last ? ".*" : "(?:.*/)?") : last ? "/.*" : "/(?:.*/)?";
      continue;
    }
    if (index > 0 && parts[index - 1] !== "**") source += "/";
    source += segment(part);
  }
  return new RegExp(`^${anchored ? "" : "(?:.*/)?"}${source}${folder ? "/.*" : "(?:/.*)?"}$`, "s");
}

/** Whether a path matches any of the patterns given with `--ignore`; see `ignorePattern`. */
export function ignoreMatcher(patterns: readonly string[]): Ignored {
  if (!patterns.length) return ignoreNothing;
  const compiled = patterns.map(ignorePattern);
  return (path) => compiled.some((pattern) => pattern.test(path));
}
