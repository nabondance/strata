import type { Provider } from "./adapters.js";
import { readBlobs } from "./git.js";
import { type BlobMeasurement, type TrackedFile, versionKey } from "./inventory.js";
import type { Measurer } from "./measurement.js";

/**
 * What an agent keeps in context for a skill before it is used: the frontmatter `name` and
 * `description`, not the manifest body. `listed` counts that stored text; `hidden` means the
 * frontmatter keeps the skill out of the listing, so it costs nothing until invoked; `unresolved`
 * means Strata could not read the listed text and does not guess it.
 */
export interface SkillListing {
  status: "listed" | "hidden" | "unresolved";
  /** Tokens of the listed text under the report's measurement: 0 when hidden, null when unresolved. */
  tokens: number | null;
}

/** Claude Code truncates the combined `description` and `when_to_use` at this many characters. */
export const claudeDescriptionLimit = 1536;

interface Frontmatter {
  /** Top-level fields; a value that is not a scalar Strata reads maps to null. */
  fields: Map<string, string | null>;
  /** Each field's source: the text after its key, and the lines that continue it. */
  sources: Map<string, { first: string; rest: string[] }>;
  body: string;
}

const keyLine = /^([A-Za-z0-9_-]+)[ \t]*:(?:[ \t]+(.*)|[ \t]*)$/;
// Lines that continue the value of the key above them: indented, blank, or a compact sequence item.
const continuation = /^(?:[ \t]|-(?:[ \t]|$)|[ \t]*$)/;
const comment = /[ \t]+#.*$/;

/**
 * Split a manifest into its frontmatter and body, or return null when the frontmatter cannot be
 * read. Frontmatter counts only when the first line is `---`; a later `---` line closes it. Strata
 * reads a documented subset of YAML: top-level keys whose values are plain scalars (over one or
 * more lines), single-line quoted scalars, or literal and folded block scalars. Other values, such
 * as flow collections, are recorded as unreadable rather than guessed. An unclosed block, a line
 * that is not a key, or a duplicate key, which YAML rejects, makes the whole frontmatter unread.
 */
export function readFrontmatter(text: string): Frontmatter | null {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trimEnd() !== "---") return { fields: new Map(), sources: new Map(), body: lines.join("\n") };
  const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
  if (end < 0) return null;
  const block = lines.slice(1, end);
  const fields = new Map<string, string | null>();
  const sources = new Map<string, { first: string; rest: string[] }>();
  for (let index = 0; index < block.length; ) {
    const line = block[index]!;
    if (!line.trim() || /^#/.test(line)) {
      index += 1;
      continue;
    }
    const match = keyLine.exec(line);
    if (!match || fields.has(match[1]!)) return null;
    let next = index + 1;
    while (next < block.length && continuation.test(block[next]!)) next += 1;
    const source = { first: match[2]?.trimEnd() ?? "", rest: block.slice(index + 1, next) };
    fields.set(match[1]!, scalar(source.first, source.rest));
    sources.set(match[1]!, source);
    index = next;
  }
  return { fields, sources, body: lines.slice(end + 1).join("\n") };
}

/** A scalar from its first-line text and continuation lines, or null if it is not one Strata reads. */
function scalar(first: string, rest: string[]): string | null {
  const head = first.replace(comment, "");
  const block = /^([|>])[+-]?$/.exec(head);
  if (block) return blockScalar(block[1] === ">", rest);
  if (first.startsWith('"') || first.startsWith("'")) {
    return rest.some((line) => line.trim()) ? null : quoted(first);
  }
  if (/^[[{&*!%@`|>]/.test(head)) return null;
  // A comment line ends a plain scalar; any value text after it is not part of the scalar, which YAML rejects.
  const commentLine = rest.findIndex((line) => /^[ \t]*#/.test(line));
  if (commentLine >= 0 && rest.slice(commentLine).some((line) => line.trim() && !/^[ \t]*#/.test(line))) return null;
  const lines = commentLine >= 0 ? rest.slice(0, commentLine) : rest;
  const parts = [head.trim(), ...lines.map((line) => line.replace(comment, "").trim())];
  // Inside a plain scalar these start a comment, a mapping, or a sequence, which YAML treats otherwise.
  if (parts.some((part) => /^#|^-(?:\s|$)|:(?:\s|$)/.test(part))) return null;
  const value = fold(parts);
  return value === "~" || value === "null" ? "" : value;
}

/** Fold lines: a single line break becomes a space, and each blank line a newline. */
function fold(parts: string[]): string {
  let output = "";
  let blanks = 0;
  for (const part of parts) {
    if (!part) {
      if (output) blanks += 1;
      continue;
    }
    if (output) output += blanks ? "\n".repeat(blanks) : " ";
    output += part;
    blanks = 0;
  }
  return output;
}

/** A literal (`|`) or folded (`>`) block scalar; trailing line breaks are dropped. */
function blockScalar(folded: boolean, rest: string[]): string | null {
  const first = rest.find((line) => line.trim());
  if (first === undefined) return "";
  const indent = /^ */.exec(first)![0].length;
  if (!indent) return null;
  const lines: string[] = [];
  for (const line of rest) {
    if (!line.trim()) lines.push("");
    else if (/^ */.exec(line)![0].length < indent) return null;
    else lines.push(line.slice(indent));
  }
  while (lines.length && !lines.at(-1)) lines.pop();
  if (!folded) return lines.join("\n");
  // More-indented lines keep their line breaks; other lines fold as in a plain scalar.
  let output = "";
  let blanks = 0;
  let previousIndented = false;
  for (const line of lines) {
    if (!line) {
      blanks += 1;
      continue;
    }
    const indented = /^\s/.test(line);
    if (output || blanks) {
      output += indented || previousIndented ? "\n".repeat(blanks + 1) : blanks ? "\n".repeat(blanks) : " ";
    }
    output += line;
    blanks = 0;
    previousIndented = indented;
  }
  return output;
}

const escapes: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  '"': '"',
  "\\": "\\",
  "/": "/",
  " ": " ",
  "0": "\0",
};

/** A single-line quoted scalar, followed by nothing but an optional comment. */
function quoted(text: string): string | null {
  const quote = text[0]!;
  let output = "";
  for (let index = 1; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote === "'" && char === "'" && text[index + 1] === "'") {
      output += "'";
      index += 1;
    } else if (char === quote) {
      const after = text.slice(index + 1);
      return !after.trim() || /^[ \t]+#/.test(after) ? output : null;
    } else if (quote === '"' && char === "\\") {
      const sequence = text[index + 1] ?? "";
      const hex = { x: 2, u: 4, U: 8 }[sequence];
      if (sequence in escapes) {
        output += escapes[sequence];
        index += 1;
      } else if (hex) {
        const digits = text.slice(index + 2, index + 2 + hex);
        const point = digits.length === hex && /^[0-9a-fA-F]+$/.test(digits) ? Number.parseInt(digits, 16) : -1;
        // Beyond U+10FFFF is not a code point, so the value is not one Strata can read.
        if (point < 0 || point > 0x10ffff) return null;
        output += String.fromCodePoint(point);
        index += 1 + hex;
      } else return null;
    } else output += char;
  }
  return null;
}

/**
 * The text an agent lists for a skill before it is used: an empty string when the skill is left
 * out of the listing, or null when Strata cannot tell. Claude Code lists `name` (by default the
 * skill directory name) and `description` (by default the first non-empty body line) with
 * `when_to_use` appended, the two truncated together at 1,536 characters, and leaves out a skill
 * with `disable-model-invocation: true`. Codex, Cursor, and Gemini CLI require both `name` and `description`;
 * Cursor also leaves out a skill with `disable-model-invocation: true` until it is invoked by name.
 */
export function listingText(text: string, provider: Provider, directoryName: string): string | null {
  const frontmatter = readFrontmatter(text);
  if (!frontmatter) return null;
  const { fields, body } = frontmatter;
  const field = (key: string) => fields.get(key)?.trim();
  if (provider !== "claude") {
    if (provider === "cursor") {
      if (fields.get("disable-model-invocation") === null) return null;
      if (/^(?:true|True|TRUE)$/.test(field("disable-model-invocation") ?? "")) return "";
    }
    const name = field("name");
    const description = field("description");
    return name && description ? `${name}\n${description}` : null;
  }
  for (const key of ["name", "description", "when_to_use", "disable-model-invocation"]) {
    if (fields.get(key) === null) return null;
  }
  if (/^(?:true|True|TRUE)$/.test(field("disable-model-invocation") ?? "")) return "";
  const name = field("name") || directoryName;
  const description =
    field("description") ||
    body
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ||
    "";
  const whenToUse = field("when_to_use");
  const listed = Array.from(whenToUse ? (description ? `${description}\n${whenToUse}` : whenToUse) : description)
    .slice(0, claudeDescriptionLimit)
    .join("");
  return listed ? `${name}\n${listed}` : name;
}

/** One manifest Strata cannot read must not stop the analysis, so any failure leaves it unresolved. */
function safeListingText(text: string, provider: Provider, directoryName: string): string | null {
  try {
    return listingText(text, provider, directoryName);
  } catch {
    return null;
  }
}

/**
 * Measure the listing of every distinct skill manifest version, keyed by path and blob. Manifest
 * content is read for this even when the measurement itself needs only sizes. A manifest that is
 * not valid UTF-8 is unresolved.
 */
export function skillListings(
  root: string,
  files: Iterable<TrackedFile>,
  measured: Map<string, BlobMeasurement>,
  measurer: Measurer,
): Map<string, SkillListing> {
  const manifests = new Map<string, TrackedFile>();
  for (const file of files) {
    if (file.classification.skillRole === "manifest") manifests.set(versionKey(file.path, file.blob), file);
  }
  const blobs = [...new Set([...manifests.values()].map((file) => file.blob))];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const texts = new Map<string, string | null>();
  for (const [blob, body] of readBlobs(root, blobs, (id) => measured.get(id)?.bytes ?? 0)) {
    try {
      texts.set(blob, decoder.decode(body));
    } catch {
      texts.set(blob, null);
    }
  }
  const listings = new Map<string, SkillListing>();
  for (const [key, file] of manifests) {
    const text = texts.get(file.blob);
    const { provider, skillRoot = "" } = file.classification;
    const listed = text == null ? null : safeListingText(text, provider, skillRoot.split("/").at(-1) ?? "");
    listings.set(
      key,
      listed === null
        ? { status: "unresolved", tokens: null }
        : listed === ""
          ? { status: "hidden", tokens: 0 }
          : { status: "listed", tokens: measurer.count(Buffer.from(listed, "utf8")) },
    );
  }
  return listings;
}
