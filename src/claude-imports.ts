import { posix } from "node:path";
import { type Classification, classify } from "./adapters.js";
import { blobSizes, gitTokens, readBlobs, type TreeEntry } from "./git.js";
import { importLinks } from "./import-links.js";
import type { TrackedFile } from "./inventory.js";
import type { ClaudeImport } from "./model.js";

/** Claude Code follows imports this many hops from a root file; the files at the last hop are loaded. */
export const maxImportHops = 4;

// Claude Code reads an import where `@` starts a line or follows whitespace. The path runs to the
// next whitespace, and a backslash keeps a space in it.
const importPattern = /(?:^|\s)@((?:[^\s\\]|\\ )+)/g;
const fence = /^[ \t]*(`{3,}|~{3,})(.*)$/;

/** Blank fenced code blocks, HTML comments, and code spans, keeping line breaks so lines still count. */
function visibleText(text: string): string[] {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  let open: string | null = null;
  // A comment that starts a line is an HTML block, which runs to the end of the line holding `-->`;
  // one inside a line is inline, and the text after it is still text.
  let comment: "block" | "inline" | null = null;
  const visible = lines.map((line) => {
    if (comment === "block") {
      if (line.includes("-->")) comment = null;
      return "";
    }
    if (open !== null) {
      const close = fence.exec(line);
      if (close && close[1]![0] === open[0] && close[1]!.length >= open.length && !close[2]!.trim()) open = null;
      return "";
    }
    const start = comment ? null : fence.exec(line);
    // A backtick fence's info string cannot contain a backtick.
    if (start && !(start[1]![0] === "`" && start[2]!.includes("`"))) {
      open = start[1]!;
      return "";
    }
    if (!comment && /^ {0,3}<!--/.test(line)) {
      if (!line.slice(line.indexOf("<!--") + 4).includes("-->")) comment = "block";
      return "";
    }
    let output = "";
    let rest = line;
    for (;;) {
      if (comment) {
        const end = rest.indexOf("-->");
        if (end < 0) return output;
        rest = rest.slice(end + 3);
        comment = null;
      }
      const begin = rest.indexOf("<!--");
      if (begin < 0) return output + rest;
      output += `${rest.slice(0, begin)} `;
      rest = rest.slice(begin + 4);
      comment = "inline";
    }
  });
  const paragraphs = visible.join("\n").split(/(\n[ \t]*\n)/);
  return paragraphs.map(blankCodeSpans).join("").split("\n");
}

/**
 * Blank the code spans in a paragraph. A span opens with a run of backticks and closes at the next
 * run of the same length; a run with no match is literal text. Blanking with spaces lets an `@`
 * right after a span start an import, as it does after any other inline element.
 */
function blankCodeSpans(paragraph: string): string {
  const runEnd = (start: number) => {
    let end = start;
    while (paragraph[end] === "`") end += 1;
    return end;
  };
  let output = "";
  let index = 0;
  for (;;) {
    const open = paragraph.indexOf("`", index);
    if (open < 0) return output + paragraph.slice(index);
    const length = runEnd(open) - open;
    let close = -1;
    for (let search = open + length; ; ) {
      const next = paragraph.indexOf("`", search);
      if (next < 0) break;
      const end = runEnd(next);
      if (end - next === length) {
        close = end;
        break;
      }
      search = end;
    }
    if (close < 0) {
      output += paragraph.slice(index, open + length);
      index = open + length;
    } else {
      output += paragraph.slice(index, open) + paragraph.slice(open, close).replace(/[^\n]/g, " ");
      index = close;
    }
  }
}

/**
 * The `@path` imports in a Markdown file, in source order, as Claude Code reads them: outside fenced
 * code blocks, code spans, and HTML comments, with `#` fragments removed and `\ ` read as a space.
 * A path must start with `./`, `~/`, `/`, or a letter, digit, `.`, `_`, or `-`, so a quoted path or
 * a second `@` is not an import. Strata reads Markdown structure only this far: indented code
 * blocks are read as text, and an `@` directly after emphasis or a link bracket is not an import.
 */
export function importPaths(text: string): Array<{ path: string; line: number }> {
  const found: Array<{ path: string; line: number }> = [];
  for (const [index, line] of visibleText(text).entries()) {
    for (const match of line.matchAll(importPattern)) {
      const hash = match[1]!.indexOf("#");
      const path = (hash < 0 ? match[1]! : match[1]!.slice(0, hash)).replace(/\\ /g, " ");
      const valid =
        path.startsWith("./") ||
        path.startsWith("~/") ||
        (path.startsWith("/") && path !== "/") ||
        (!path.startsWith("@") && !/^[#%^&*()]+/.test(path) && /^[a-zA-Z0-9._-]/.test(path));
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

/** A file's imports: one entry per distinct target, at its first line, and each external import. */
export function readImports(text: string, importer: string): ClaudeImport[] {
  const seen = new Set<string>();
  const imports: ClaudeImport[] = [];
  for (const { path, line } of importPaths(text)) {
    const target = resolveImport(path, importer);
    if (target === null) {
      imports.push({ line, target, external: true });
      continue;
    }
    if (seen.has(target)) continue;
    seen.add(target);
    imports.push({ line, target });
  }
  return imports;
}

/** Whether Claude Code starts expanding imports at this file: `CLAUDE.md`, `CLAUDE.local.md`, or `AGENTS.md`. */
export function importRoot(classification: Classification): boolean {
  return !!classification.importRoot;
}

/** Imports are followed from Markdown files only. */
export const markdown = (path: string) => path.endsWith(".md");

/** The label of a file recognized only because an import reaches it: Markdown is measured, anything else is source-only. */
export function importedClassification(path: string): Classification {
  return markdown(path)
    ? { provider: "claude", category: "instructions", instructionalText: true, imported: true }
    : { provider: "claude", category: "other", instructionalText: false, imported: true };
}

const key = (path: string, blob: string) => `${path}\0${blob}`;

/**
 * Parse the imports of file versions, keyed by path and blob. Each blob is read once; a file that
 * is not valid UTF-8 has no imports.
 */
function parseVersions(
  repo: string,
  versions: Iterable<{ path: string; blob: string }>,
  parsed: Map<string, ClaudeImport[]>,
): void {
  const pending = [...versions].filter(({ path, blob }) => !parsed.has(key(path, blob)));
  if (!pending.length) return;
  const blobs = [...new Set(pending.map(({ blob }) => blob))];
  const sizes = blobSizes(repo, blobs);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const texts = new Map<string, string | null>();
  for (const [blob, body] of readBlobs(repo, blobs, (id) => sizes.get(id) ?? 0)) {
    try {
      texts.set(blob, decoder.decode(body));
    } catch {
      texts.set(blob, null);
    }
  }
  for (const { path, blob } of pending) {
    const text = texts.get(blob);
    parsed.set(key(path, blob), text ? readImports(text, path) : []);
  }
}

/** What a commit did to a path outside the recognized inventory: the regular file now there, or null. */
interface PathEvent {
  path: string;
  blob: string | null;
}

const pathspecBytes = 64 * 1024;

/**
 * The first-parent history of specific paths, by commit: each commit that changed one of them and
 * the regular file each then held, or null when it was removed or became a symlink or submodule.
 * A pathspec also matches the files under a directory of that name, so only the requested paths are
 * kept: an import of a directory names no file.
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
          const regular = pending.mode === "100644" || pending.mode === "100755";
          if (requested.has(token))
            current.push({ path: token, blob: pending.status !== "D" && regular ? pending.blob : null });
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

/**
 * Drop the target of every import that names a path no regular file ever had in the analyzed
 * history. Such a target is text from the file, such as the `alice` in "ask @alice", not a path the
 * repository holds, and reports carry paths but never file contents. The import keeps its line.
 */
function forgetUntracked(parsed: Map<string, ClaudeImport[]>, tracked: (path: string) => boolean): void {
  for (const [version, imports] of parsed) {
    if (imports.some(({ target }) => target !== null && !tracked(target)))
      parsed.set(
        version,
        imports.map((entry) =>
          entry.target === null || tracked(entry.target) ? entry : { line: entry.line, target: null },
        ),
      );
  }
}

/** One commit as analysis replays it: what it removed and wrote among the paths in the inventory. */
export interface ImportDelta {
  id: string;
  removed: string[];
  written: TrackedFile[];
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
 * for up to four rounds, since no chain can be longer. The history is then replayed: whenever a
 * commit changes what the roots reach, the reached files outside the recognized inventory are
 * written to or removed from that commit's delta, so the rest of analysis treats them as ordinary
 * components. Returns the imports of every parsed version, keyed by path and blob.
 */
export async function addImportedFiles(repo: string, deltas: ImportDelta[]): Promise<Map<string, ClaudeImport[]>> {
  const parsed = new Map<string, ClaudeImport[]>();
  const recognized = new Map<string, TrackedFile[]>();
  for (const delta of deltas) {
    for (const file of delta.written) {
      const versions = recognized.get(file.path) ?? [];
      versions.push(file);
      recognized.set(file.path, versions);
    }
  }
  const roots = [...recognized.values()].flat().filter((file) => importRoot(file.classification));
  parseVersions(repo, roots, parsed);

  const candidates = new Map<string, PathEvent[]>();
  const candidateVersions = new Map<string, Set<string>>();
  const targets = new Set<string>();
  let frontier: Array<{ path: string; blob: string }> = roots;
  for (let hop = 1; hop <= maxImportHops && frontier.length; hop += 1) {
    const found = new Set<string>();
    for (const { path, blob } of frontier) {
      for (const { target } of parsed.get(key(path, blob)) ?? []) {
        if (target !== null && !targets.has(target)) found.add(target);
      }
    }
    for (const target of found) targets.add(target);
    const unrecognized = [...found].filter((path) => !classify(path)).sort();
    for (const [id, events] of await pathHistory(repo, unrecognized)) {
      const known = candidates.get(id);
      if (known) known.push(...events);
      else candidates.set(id, events);
      for (const { path, blob } of events) {
        if (blob === null) continue;
        const versions = candidateVersions.get(path) ?? new Set<string>();
        versions.add(blob);
        candidateVersions.set(path, versions);
      }
    }
    frontier = [...found].flatMap((path) =>
      !markdown(path)
        ? []
        : (recognized.get(path) ?? [...(candidateVersions.get(path) ?? [])].map((blob) => ({ path, blob }))),
    );
    parseVersions(repo, frontier, parsed);
  }
  // Imports from the last hop are past the depth limit; their targets are looked up only to know
  // whether they name a tracked path.
  const beyond = new Set<string>();
  for (const { path, blob } of frontier) {
    for (const { target } of parsed.get(key(path, blob)) ?? []) {
      if (target !== null && !targets.has(target) && !classify(target)) beyond.add(target);
    }
  }
  const trackedBeyond = new Set<string>();
  for (const events of (await pathHistory(repo, [...beyond].sort())).values()) {
    for (const { path, blob } of events) if (blob !== null) trackedBeyond.add(path);
  }
  forgetUntracked(parsed, (path) => recognized.has(path) || candidateVersions.has(path) || trackedBeyond.has(path));
  if (![...parsed.values()].some((imports) => imports.length)) return parsed;

  // Replay only the files expansion can involve: the roots and every path an import names.
  const files = new Map<string, TrackedFile>();
  const outside = new Map<string, string>();
  const reached = new Map<string, string>();
  for (const delta of deltas) {
    let touched = false;
    for (const path of delta.removed) touched = files.delete(path) || touched;
    for (const file of delta.written) {
      if (!importRoot(file.classification) && !targets.has(file.path)) continue;
      files.set(file.path, file);
      touched = true;
    }
    for (const { path, blob } of candidates.get(delta.id) ?? []) {
      if (blob === null) outside.delete(path);
      else outside.set(path, blob);
      touched = true;
    }
    if (!touched) continue;
    const entries: Importing[] = [];
    for (const file of files.values()) {
      entries.push(entry(file.path, file.classification, parsed.get(key(file.path, file.blob))));
    }
    for (const [path, blob] of outside) {
      entries.push(entry(path, importedClassification(path), parsed.get(key(path, blob))));
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
 * of each file version read on the way are added to `parsed`, keyed by path and blob. Each pass
 * adds the tree's files that `importLinks` finds imported but missing, until none are left.
 */
export function treeImports(
  repo: string,
  tree: TreeEntry[],
  recognized: TrackedFile[],
  parsed: Map<string, ClaudeImport[]>,
): TrackedFile[] {
  const regular = new Map(
    tree.flatMap(({ mode, blob, path }) => (mode === "100644" || mode === "100755" ? [[path, blob] as const] : [])),
  );
  const files = new Map(recognized.map((file) => [file.path, file]));
  const imported: TrackedFile[] = [];
  parseVersions(
    repo,
    recognized.filter((file) => importRoot(file.classification)),
    parsed,
  );
  for (;;) {
    const entries = [...files.values()].map((file) =>
      entry(file.path, file.classification, parsed.get(key(file.path, file.blob))),
    );
    const links = importLinks(entries);
    const unread = links.flatMap((link) => {
      const file = link.status === "resolved" ? files.get(link.target!) : undefined;
      return file && markdown(file.path) && !parsed.has(key(file.path, file.blob)) ? [file] : [];
    });
    let added = false;
    for (const link of links) {
      const blob = link.status === "missing" && link.target !== null ? regular.get(link.target) : undefined;
      if (blob === undefined || files.has(link.target!)) continue;
      const file = { path: link.target!, blob, classification: importedClassification(link.target!) };
      files.set(file.path, file);
      imported.push(file);
      added = true;
    }
    if (!added && !unread.length) return imported;
    parseVersions(repo, unread, parsed);
  }
}
