import { posix } from "node:path";
import { type Classification, classify } from "./adapters.js";
import { blobSizes, gitTokens, readBlobs, type TreeEntry } from "./git.js";
import { importLinks } from "./import-links.js";
import { type TrackedFile, versionKey } from "./inventory.js";
import type { ClaudeImport } from "./model.js";

/** Claude Code follows imports this many hops from a root file; the files at the last hop are loaded. */
export const maxImportHops = 4;

// Claude Code reads an import where `@` starts a line or follows whitespace. The path runs to the
// next whitespace, and a backslash keeps a space in it.
const importPattern = /(?:^|\s)@((?:[^\s\\]|\\ )+)/g;
const fence = /^[ \t]*(`{3,}|~{3,})(.*)$/;

/** Blank fenced code blocks, HTML comments, and code spans, keeping line breaks so lines still count. */
function visibleText(text: string): string[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  let open: string | null = null;
  // A comment that starts a line is an HTML block, which runs to the end of the line holding `-->`,
  // or to the end of the file. A comment inside a paragraph is inline; see `blankInline`.
  let block = false;
  const visible = lines.map((line) => {
    if (block) {
      if (line.includes("-->")) block = false;
      return "";
    }
    if (open !== null) {
      const close = fence.exec(line);
      if (close && close[1]![0] === open[0] && close[1]!.length >= open.length && !close[2]!.trim()) open = null;
      return "";
    }
    const start = fence.exec(line);
    // A backtick fence's info string cannot contain a backtick.
    if (start && !(start[1]![0] === "`" && start[2]!.includes("`"))) {
      open = start[1]!;
      return "";
    }
    if (/^ {0,3}<!--/.test(line)) {
      block = !line.slice(line.indexOf("<!--") + 4).includes("-->");
      return "";
    }
    return line;
  });
  const paragraphs = visible.join("\n").split(/(\n[ \t]*\n)/);
  return paragraphs.map(blankInline).join("").split("\n");
}

/**
 * Blank the code spans and inline HTML comments in a paragraph, whichever opens first. A span opens
 * with a run of backticks and closes at the next run of the same length; a comment closes at the
 * next `-->`. One with no close in its paragraph is literal text, so a stray backtick or `<!--` hides
 * nothing. Blanking with spaces lets an `@` right after either start an import, as it does after
 * any other inline element.
 */
function blankInline(paragraph: string): string {
  const blank = (text: string) => text.replace(/[^\n]/g, " ");
  const runEnd = (start: number) => {
    let end = start;
    while (paragraph[end] === "`") end += 1;
    return end;
  };
  let output = "";
  let index = 0;
  for (;;) {
    const tick = paragraph.indexOf("`", index);
    const comment = paragraph.indexOf("<!--", index);
    if (tick < 0 && comment < 0) return output + paragraph.slice(index);
    let start: number;
    let end = -1;
    let literal: number;
    if (comment >= 0 && (tick < 0 || comment < tick)) {
      start = comment;
      literal = comment + 4;
      const close = paragraph.indexOf("-->", literal);
      if (close >= 0) end = close + 3;
    } else {
      start = tick;
      literal = runEnd(tick);
      const length = literal - tick;
      for (let search = literal; ; ) {
        const next = paragraph.indexOf("`", search);
        if (next < 0) break;
        const after = runEnd(next);
        if (after - next === length) {
          end = after;
          break;
        }
        search = after;
      }
    }
    if (end < 0) {
      output += paragraph.slice(index, literal);
      index = literal;
    } else {
      output += paragraph.slice(index, start) + blank(paragraph.slice(start, end));
      index = end;
    }
  }
}

const openers: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

/** Whether `text` opens as many `opener` brackets as it closes with `closer`. */
const balanced = (text: string, opener: string, closer: string) =>
  text.split(opener).length >= text.split(closer).length;

/**
 * A path without the punctuation that ends its sentence or clause: trailing `.`, `,`, `:`, `;`, `!`,
 * `?`, and quotes, and a closing `)`, `]`, or `}` that the path itself does not open, as in
 * `(@a.md, @b.md)`. Claude Code's tokenizing is not published, so this is Strata's reading: a path
 * that really ends in one of these characters is read without it.
 */
function trimPunctuation(path: string): string {
  let end = path.length;
  for (; end > 0; end -= 1) {
    const last = path[end - 1]!;
    const opener = openers[last];
    if (opener === undefined ? !".,:;!?\"'".includes(last) : balanced(path.slice(0, end), opener, last)) break;
  }
  return path.slice(0, end);
}

/**
 * The `@path` imports in a Markdown file, in source order, as Claude Code reads them: outside fenced
 * code blocks, code spans, and HTML comments, with `#` fragments and trailing punctuation removed
 * (see `trimPunctuation`) and `\ ` read as a space. A path must start with `./`, `~/`, `/`, or a
 * letter, digit, `.`, `_`, or `-`, so a quoted path or a second `@` is not an import. Strata reads
 * Markdown structure only this far: indented code blocks are read as text, and an `@` directly after
 * emphasis or a link bracket is not an import.
 */
export function importPaths(text: string): Array<{ path: string; line: number }> {
  const found: Array<{ path: string; line: number }> = [];
  for (const [index, line] of visibleText(text).entries()) {
    for (const match of line.matchAll(importPattern)) {
      const hash = match[1]!.indexOf("#");
      const path = trimPunctuation(hash < 0 ? match[1]! : match[1]!.slice(0, hash)).replace(/\\ /g, " ");
      // Claude Code also accepts `./`, and rejects paths starting with `@` or one of `#%^&*()`; the
      // first-character rule already decides those.
      const valid = path.startsWith("~/") || (path.startsWith("/") && path !== "/") || /^[a-zA-Z0-9._-]/.test(path);
      if (valid) found.push({ path, line: index + 1 });
    }
  }
  return found;
}

/**
 * The repository path an import names, resolved against the directory of the file that holds it,
 * or null when it names something outside the repository: a home-directory or absolute path, or a
 * relative path that climbs above the repository root.
 */
export function resolveImport(path: string, importer: string): string | null {
  if (path.startsWith("~/") || path.startsWith("/")) return null;
  const resolved = posix.normalize(posix.join(posix.dirname(importer), path));
  return resolved === ".." || resolved.startsWith("../") ? null : resolved;
}

/** File extensions that make an import's word a path even when no file has it; see `pathShaped`. */
export const pathExtensions = [".md", ".txt", ".json", ".yaml", ".yml", ".toml", ".mdc", ".rules"];

/**
 * Whether an import, as written, has the shape of a path: it holds a `/` or ends with one of
 * `pathExtensions`. A report keeps the target of a path-shaped import that no file has, such as
 * `@mastra/server`, but not a bare word such as `@alice`, which is more likely prose.
 */
export function pathShaped(path: string): boolean {
  const lower = path.toLowerCase();
  return path.includes("/") || pathExtensions.some((extension) => lower.endsWith(extension));
}

/**
 * A file's imports: one entry per distinct target, at its first line, and each external import.
 * The target of each path-shaped import (see `pathShaped`) is added to `shaped`.
 */
export function readImports(text: string, importer: string, shaped?: Set<string>): ClaudeImport[] {
  const seen = new Set<string>();
  const imports: ClaudeImport[] = [];
  for (const { path, line } of importPaths(text)) {
    const target = resolveImport(path, importer);
    if (target === null) {
      imports.push({ line, target, external: true });
      continue;
    }
    if (shaped && pathShaped(path)) shaped.add(target);
    if (seen.has(target)) continue;
    seen.add(target);
    imports.push({ line, target });
  }
  return imports;
}

/** Imports are followed from Markdown files only. */
export const markdown = (path: string) => path.endsWith(".md");

/** The label of a file recognized only because an import reaches it: Markdown is measured, anything else is source-only. */
export function importedClassification(path: string): Classification {
  return markdown(path)
    ? { provider: "claude", category: "instructions", instructionalText: true, imported: true }
    : { provider: "claude", category: "other", instructionalText: false, imported: true };
}

const key = versionKey;

/**
 * Whether a target can name a file. The repository root or a path ending in `/` cannot, and a
 * pathspec for one would match every file under it, so its history is never read.
 */
const fileLike = (path: string) => path !== "." && !path.endsWith("/");

/** Called with each blob import parsing reads, so other work on the same content need not read it again. */
export type OnRead = (blob: string, body: Buffer) => void;

/** Claude Code reads an imported symlink's file; Strata follows at most this many links in a row. */
export const maxSymlinks = 4;

/**
 * The repository path a Git symlink at `path` points to, resolved against the link's directory, or
 * null when it points outside the repository (an absolute path, or one that climbs above the root)
 * or cannot name a file.
 */
export function symlinkDestination(text: string, path: string): string | null {
  if (!text || text.startsWith("/") || text.includes("\0")) return null;
  const resolved = posix.normalize(posix.join(posix.dirname(path), text));
  return resolved === ".." || resolved.startsWith("../") || !fileLike(resolved) ? null : resolved;
}

/** The text of symlink blobs, or null for one that is not valid UTF-8. Nothing else reads these blobs. */
function readLinks(repo: string, blobs: Iterable<string>, texts: Map<string, string | null>): void {
  const pending = [...new Set(blobs)].filter((blob) => !texts.has(blob));
  if (!pending.length) return;
  const sizes = blobSizes(repo, pending);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const [blob, body] of readBlobs(repo, pending, (id) => sizes.get(id) ?? 0)) {
    try {
      texts.set(blob, decoder.decode(body));
    } catch {
      texts.set(blob, null);
    }
  }
}

/** Give each parsed import whose target is a followed symlink the file it leads to, as `symlinkTarget`. */
function addSymlinkTargets(parsed: Map<string, ClaudeImport[]>, followed: Map<string, string>): void {
  if (!followed.size) return;
  const file = (target: string | null) => (target === null ? undefined : followed.get(target));
  for (const [version, imports] of parsed) {
    if (!imports.some(({ target, symlinkTarget }) => symlinkTarget === undefined && file(target) !== undefined))
      continue;
    parsed.set(
      version,
      imports.map((entry) => {
        const symlinkTarget = file(entry.target);
        return symlinkTarget === undefined ? entry : { ...entry, symlinkTarget };
      }),
    );
  }
}

/**
 * Parse the imports of file versions, keyed by path and blob. Each blob is read once and also
 * handed to `onRead`; a file that is not valid UTF-8 has no imports.
 */
function parseVersions(
  repo: string,
  versions: Iterable<{ path: string; blob: string }>,
  parsed: Map<string, ClaudeImport[]>,
  onRead?: OnRead,
  shaped?: Set<string>,
): void {
  const pending = [...versions].filter(({ path, blob }) => !parsed.has(key(path, blob)));
  if (!pending.length) return;
  const blobs = [...new Set(pending.map(({ blob }) => blob))];
  const sizes = blobSizes(repo, blobs);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const texts = new Map<string, string | null>();
  for (const [blob, body] of readBlobs(repo, blobs, (id) => sizes.get(id) ?? 0)) {
    onRead?.(blob, body);
    try {
      texts.set(blob, decoder.decode(body));
    } catch {
      texts.set(blob, null);
    }
  }
  for (const { path, blob } of pending) {
    const text = texts.get(blob);
    parsed.set(key(path, blob), text ? readImports(text, path, shaped) : []);
  }
}

/**
 * Drop the target of every import that `kept` rejects: a bare word that no file or symlink in the
 * analyzed history has, such as the `alice` in "ask @alice". That word is text from the file, not a
 * path, and reports carry paths but not file contents. The import keeps its line and stays missing.
 */
function forgetWords(parsed: Map<string, ClaudeImport[]>, kept: (target: string) => boolean): void {
  for (const [version, imports] of parsed) {
    if (imports.some(({ target }) => target !== null && !kept(target)))
      parsed.set(
        version,
        imports.map((entry) =>
          entry.target === null || kept(entry.target) ? entry : { line: entry.line, target: null },
        ),
      );
  }
}

/**
 * What a commit did to a path outside the recognized inventory: the regular file now there, or null,
 * and the symlink blob when the path became or stayed a symlink.
 */
interface PathEvent {
  path: string;
  blob: string | null;
  link?: string;
}

const pathspecBytes = 64 * 1024;

/**
 * The first-parent history of specific paths, by commit: each commit that changed one of them and
 * the regular file each then held, or null when it was removed or became a symlink or submodule; a
 * symlink's blob is kept as `link`. A pathspec also matches the files under a directory of that
 * name, so only the requested paths are kept: an import of a directory names no file.
 */
async function pathHistory(repo: string, paths: string[]): Promise<Map<string, PathEvent[]>> {
  const events = new Map<string, PathEvent[]>();
  const requested = new Set(paths);
  for (let start = 0; start < paths.length; ) {
    const chunk: string[] = [];
    for (let bytes = 0; start < paths.length && (!chunk.length || bytes < pathspecBytes); start += 1) {
      chunk.push(`:(literal)${paths[start]!}`);
      bytes += paths[start]!.length + 11;
    }
    let current: PathEvent[] | undefined;
    let pending: { mode: string; blob: string; status: string } | null = null;
    const tokens = gitTokens(repo, [
      // With a single path, `log.follow` would turn on `--follow` and report renames despite `--no-renames`.
      "-c",
      "log.follow=false",
      "log",
      "--first-parent",
      "--reverse",
      "--diff-merges=first-parent",
      "--root",
      "--raw",
      "-z",
      "--no-abbrev",
      "--no-renames",
      "--no-ext-diff",
      "--no-color",
      "--no-show-signature",
      "--ignore-submodules=none",
      "--format=%x01%H",
      "HEAD",
      "--",
      ...chunk,
    ]);
    for await (const batch of tokens) {
      for (let token of batch) {
        if (pending) {
          if (!current) throw new Error("Malformed git log output");
          const present = pending.status !== "D";
          const regular = pending.mode === "100644" || pending.mode === "100755";
          if (requested.has(token))
            current.push({
              path: token,
              blob: present && regular ? pending.blob : null,
              ...(present && pending.mode === "120000" ? { link: pending.blob } : {}),
            });
          pending = null;
          continue;
        }
        if (token[0] === "\n") token = token.slice(1);
        if (!token) continue;
        if (token[0] === "\x01") {
          const id = token.slice(1);
          current = events.get(id) ?? [];
          events.set(id, current);
        } else if (token[0] === ":") {
          const fields = token.split(" ");
          pending = { mode: fields[1] ?? "", blob: fields[3] ?? "", status: fields[4] ?? "" };
          if (!pending.status) throw new Error("Malformed git log output");
        } else {
          throw new Error("Malformed git log output");
        }
      }
    }
  }
  return events;
}

/** One commit as analysis replays it: what it removed and wrote among the paths in the inventory. */
export interface ImportDelta {
  id: string;
  removed: string[];
  written: TrackedFile[];
  /**
   * Recognized paths that became or stayed a symlink, with the link's blob, or stopped being one
   * (`null`). Analysis reads these from its own history log, so following an import of a recognized
   * path needs no other.
   */
  links?: SymlinkEvent[];
}

/** A path's symlink at one commit: the link's blob, or null once the path is no symlink. */
export interface SymlinkEvent {
  path: string;
  link: string | null;
}

const entry = (path: string, classification: Classification, imports: ClaudeImport[] | undefined): Importing => ({
  path,
  ...(classification.contextFile ? { contextFile: classification.contextFile } : {}),
  ...(classification.importRoot ? { importRoot: true as const } : {}),
  ...(imports?.length ? { imports } : {}),
});

type Importing = Parameters<typeof importLinks>[0][number];

/**
 * Add the files Claude imports to a replayed history. Starting from the import roots, each round
 * reads the imports of the Markdown versions found so far and the history of the paths they name,
 * for up to four rounds, since no chain can be longer; a named path that was a symlink is followed
 * to its file, which becomes the import's `symlinkTarget`. The history is then replayed: whenever a
 * commit changes what the roots reach, the reached files outside the recognized inventory are
 * written to or removed from that commit's delta, so the rest of analysis treats them as ordinary
 * components. Returns the imports of every parsed version, keyed by path and blob; each blob read
 * is also handed to `onRead`.
 */
export async function addImportedFiles(
  repo: string,
  deltas: ImportDelta[],
  onRead?: OnRead,
): Promise<Map<string, ClaudeImport[]>> {
  const parsed = new Map<string, ClaudeImport[]>();
  const recognized = new Map<string, TrackedFile[]>();
  for (const delta of deltas) {
    for (const file of delta.written) {
      const versions = recognized.get(file.path) ?? [];
      versions.push(file);
      recognized.set(file.path, versions);
    }
  }
  const roots = [...recognized.values()].flat().filter((file) => file.classification.importRoot);
  // Targets some import writes as a path, which the report keeps even when no file has them.
  const shaped = new Set<string>();
  parseVersions(repo, roots, parsed, onRead, shaped);

  const candidates = new Map<string, PathEvent[]>();
  const candidateVersions = new Map<string, Set<string>>();
  // Every symlink blob each path had, and the text of each. A recognized path's links come from
  // analysis's own history log; an unrecognized path's from `lookUp`.
  const linkVersions = new Map<string, Set<string>>();
  const addLink = (path: string, link: string) => {
    const links = linkVersions.get(path) ?? new Set<string>();
    links.add(link);
    linkVersions.set(path, links);
  };
  for (const delta of deltas) for (const { path, link } of delta.links ?? []) if (link !== null) addLink(path, link);
  const linkTexts = new Map<string, string | null>();
  const looked = new Set<string>();
  /**
   * Read the history of unrecognized paths not looked up yet; analysis already holds the history of
   * recognized ones, so a repository whose imports name only recognized paths reads no other log.
   */
  const lookUp = async (paths: Iterable<string>) => {
    const fresh = [...new Set(paths)].filter((path) => fileLike(path) && !classify(path) && !looked.has(path)).sort();
    for (const path of fresh) looked.add(path);
    for (const [id, events] of await pathHistory(repo, fresh)) {
      for (const event of events) {
        if (event.link !== undefined) addLink(event.path, event.link);
        if (event.blob === null) continue;
        const versions = candidateVersions.get(event.path) ?? new Set<string>();
        versions.add(event.blob);
        candidateVersions.set(event.path, versions);
      }
      const known = candidates.get(id);
      if (known) known.push(...events);
      else candidates.set(id, events);
    }
  };
  const isFile = (path: string) => recognized.has(path) || candidateVersions.has(path);
  /**
   * The file each symlink path leads to, link by link, for up to `maxSymlinks` links. A link is
   * followed only when every symlink version the path had in the history points to the same path,
   * and the chain ends at a path some regular file had.
   */
  const followLinks = async (paths: string[]) => {
    const followed = new Map<string, string>();
    let chains = paths.map((path) => ({ path, at: path }));
    for (let step = 0; step < maxSymlinks && chains.length; step += 1) {
      readLinks(
        repo,
        chains.flatMap(({ at }) => [...linkVersions.get(at)!]),
        linkTexts,
      );
      const next = chains.flatMap((chain) => {
        const ends = new Set(
          [...linkVersions.get(chain.at)!].map((blob) => symlinkDestination(linkTexts.get(blob) ?? "", chain.at)),
        );
        const [end] = ends;
        return ends.size === 1 && end !== null && end !== undefined ? [{ path: chain.path, at: end }] : [];
      });
      await lookUp(next.map(({ at }) => at));
      chains = [];
      for (const chain of next) {
        if (isFile(chain.at)) followed.set(chain.path, chain.at);
        else if (linkVersions.has(chain.at)) chains.push(chain);
      }
    }
    return followed;
  };

  const targets = new Set<string>();
  const symlinkTargets = new Map<string, string>();
  let frontier: Array<{ path: string; blob: string }> = roots;
  for (let hop = 1; hop <= maxImportHops && frontier.length; hop += 1) {
    const found = new Set<string>();
    for (const { path, blob } of frontier) {
      for (const { target } of parsed.get(key(path, blob)) ?? []) {
        if (target !== null && !targets.has(target)) found.add(target);
      }
    }
    for (const target of found) targets.add(target);
    await lookUp(found);
    // A symlink's file is reached at the same hop as the path the import names.
    for (const [path, file] of await followLinks([...found].filter((path) => linkVersions.has(path)))) {
      symlinkTargets.set(path, file);
      if (targets.has(file)) continue;
      targets.add(file);
      found.add(file);
    }
    frontier = [...found].flatMap((path) =>
      !markdown(path)
        ? []
        : (recognized.get(path) ?? [...(candidateVersions.get(path) ?? [])].map((blob) => ({ path, blob }))),
    );
    parseVersions(repo, frontier, parsed, onRead, shaped);
  }
  addSymlinkTargets(parsed, symlinkTargets);
  // Imports from the last hop are past the depth limit, so their targets were not looked up. Only a
  // target not written as a path needs its history, to know whether a file has it.
  const beyond = new Set<string>();
  for (const imports of parsed.values()) {
    for (const { target } of imports) {
      if (target !== null && !shaped.has(target) && !targets.has(target) && fileLike(target) && !classify(target))
        beyond.add(target);
    }
  }
  const trackedBeyond = new Set<string>();
  for (const events of (await pathHistory(repo, [...beyond].sort())).values()) {
    for (const { path, blob, link } of events) if (blob !== null || link !== undefined) trackedBeyond.add(path);
  }
  forgetWords(
    parsed,
    (target) =>
      shaped.has(target) ||
      isFile(target) ||
      symlinkTargets.has(target) ||
      linkVersions.has(target) ||
      trackedBeyond.has(target),
  );
  if (![...parsed.values()].some((imports) => imports.length)) return parsed;

  // Replay only the files expansion can involve: the roots and every path an import names. An
  // import reaches its `symlinkTarget` only while the path it names is a symlink.
  const files = new Map<string, TrackedFile>();
  const outside = new Map<string, string>();
  const reached = new Map<string, string>();
  const linked = new Set<string>();
  const linkedNow = (imports: ClaudeImport[] | undefined) =>
    imports?.some(({ target, symlinkTarget }) => symlinkTarget !== undefined && !linked.has(target!))
      ? imports.map((entry) =>
          entry.symlinkTarget === undefined || linked.has(entry.target!)
            ? entry
            : { line: entry.line, target: entry.target },
        )
      : imports;
  for (const delta of deltas) {
    let touched = false;
    for (const path of delta.removed) touched = files.delete(path) || touched;
    for (const file of delta.written) {
      if (!file.classification.importRoot && !targets.has(file.path)) continue;
      files.set(file.path, file);
      touched = true;
    }
    for (const { path, link } of delta.links ?? []) {
      if (!symlinkTargets.has(path)) continue;
      if (link === null) linked.delete(path);
      else linked.add(path);
      touched = true;
    }
    for (const { path, blob, link } of candidates.get(delta.id) ?? []) {
      if (blob === null) outside.delete(path);
      else outside.set(path, blob);
      if (link === undefined) linked.delete(path);
      else linked.add(path);
      touched = true;
    }
    if (!touched) continue;
    const entries: Importing[] = [];
    for (const file of files.values()) {
      entries.push(entry(file.path, file.classification, linkedNow(parsed.get(key(file.path, file.blob)))));
    }
    for (const [path, blob] of outside) {
      entries.push(entry(path, importedClassification(path), linkedNow(parsed.get(key(path, blob)))));
    }
    const now = new Map<string, string>();
    for (const link of importLinks(entries)) {
      if (link.status === "resolved" && outside.has(link.target!)) now.set(link.target!, outside.get(link.target!)!);
    }
    for (const path of reached.keys()) if (!now.has(path)) delta.removed.push(path);
    for (const [path, blob] of now) {
      if (reached.get(path) !== blob) delta.written.push({ path, blob, classification: importedClassification(path) });
    }
    reached.clear();
    for (const [path, blob] of now) reached.set(path, blob);
  }
  return parsed;
}

/**
 * The files Claude imports in one commit's tree that the path rules do not recognize. The imports
 * of each file version read on the way are added to `parsed`, keyed by path and blob, and each blob
 * read is handed to `onRead`. Each pass adds the tree's files that `importLinks` finds imported but
 * missing, until none are left. An import of a symlink in the tree is followed, for up to
 * `maxSymlinks` links, to the regular file it leads to, which is set as its `symlinkTarget` in
 * `parsed`; so `parsed` must hold this tree's imports only.
 */
export function treeImports(
  repo: string,
  tree: TreeEntry[],
  recognized: TrackedFile[],
  parsed: Map<string, ClaudeImport[]>,
  onRead?: OnRead,
): TrackedFile[] {
  const regular = new Map(
    tree.flatMap(({ mode, blob, path }) => (mode === "100644" || mode === "100755" ? [[path, blob] as const] : [])),
  );
  const symlinks = new Map(tree.flatMap(({ mode, blob, path }) => (mode === "120000" ? [[path, blob] as const] : [])));
  const linkTexts = new Map<string, string | null>();
  const followed = new Map<string, string>();
  const tried = new Set<string>();
  const follow = (path: string) => {
    // The first import of a symlink reads every link in the tree at once.
    readLinks(repo, symlinks.values(), linkTexts);
    let at = path;
    for (let step = 0; step < maxSymlinks; step += 1) {
      const blob = symlinks.get(at);
      if (blob === undefined) return null;
      const next = symlinkDestination(linkTexts.get(blob) ?? "", at);
      if (next === null) return null;
      if (regular.has(next)) return next;
      at = next;
    }
    return null;
  };
  const files = new Map(recognized.map((file) => [file.path, file]));
  const imported: TrackedFile[] = [];
  parseVersions(
    repo,
    recognized.filter((file) => file.classification.importRoot),
    parsed,
    onRead,
  );
  for (;;) {
    // Imports parsed since the last pass may name a symlink an earlier pass followed.
    addSymlinkTargets(parsed, followed);
    const entries = [...files.values()].map((file) =>
      entry(file.path, file.classification, parsed.get(key(file.path, file.blob))),
    );
    const links = importLinks(entries);
    const unread = links.flatMap((link) => {
      const file = link.status === "resolved" ? files.get(link.target!) : undefined;
      return file && markdown(file.path) && !parsed.has(key(file.path, file.blob)) ? [file] : [];
    });
    let added = false;
    let relinked = false;
    for (const link of links) {
      if (link.status !== "missing" || link.target === null) continue;
      let path = link.target;
      if (symlinks.has(path) && !tried.has(path)) {
        tried.add(path);
        const file = follow(path);
        if (file !== null) {
          followed.set(path, file);
          relinked = true;
          path = file;
        }
      }
      const blob = regular.get(path);
      if (blob === undefined || files.has(path)) continue;
      const file = { path, blob, classification: importedClassification(path) };
      files.set(file.path, file);
      imported.push(file);
      added = true;
    }
    if (!added && !relinked && !unread.length) return imported;
    parseVersions(repo, unread, parsed, onRead);
  }
}
