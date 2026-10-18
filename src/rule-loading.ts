import { rootRuleProvider, type UpFront } from "./adapters.js";
import { readBlobs } from "./git.js";
import { type BlobMeasurement, type TrackedFile, versionKey } from "./inventory.js";
import { readFrontmatter } from "./skill-listing.js";

// A YAML list Strata recognizes without reading its items: a flow sequence on the key's line, or
// block sequence items on the lines below it, with blank and comment lines between.
const flowSequence = /^\[.*\S.*\](?:[ \t]+#.*)?$/;
const sequenceItem = /^[ \t]*-[ \t]+\S/;
const blankOrComment = /^[ \t]*(?:#.*)?$/;

/**
 * Whether a root rule is part of what its tool keeps from the start of a session: `listed`, null
 * when it loads only for matching files or on request, or `unresolved` when Strata cannot tell.
 *
 * Claude Code loads a rule without `paths` at launch, and one whose YAML does not parse as if it
 * had none; a `paths` string or list scopes it to matching files. Strata reads a subset of YAML,
 * so frontmatter outside it, or a `paths` value that is empty or neither a string nor a list, is
 * unresolved. Cursor applies a rule with `alwaysApply: true` to every chat; without it, a rule
 * applies when a file matches its globs, when the agent requests it, or when it is mentioned.
 */
export function ruleUpFront(text: string, provider: "claude" | "cursor"): UpFront | null {
  const frontmatter = readFrontmatter(text);
  if (!frontmatter) return "unresolved";
  if (provider === "cursor") {
    if (!frontmatter.fields.has("alwaysApply")) return null;
    const value = frontmatter.fields.get("alwaysApply")?.trim();
    if (value === undefined) return "unresolved";
    if (/^(?:true|True|TRUE)$/.test(value)) return "listed";
    return /^(?:false|False|FALSE)$/.test(value) ? null : "unresolved";
  }
  if (!frontmatter.sources.has("paths")) return "listed";
  const value = frontmatter.fields.get("paths");
  if (value) return value.trim() ? null : "unresolved";
  const { first, rest } = frontmatter.sources.get("paths")!;
  const head = first.replace(/[ \t]+#.*$/, "");
  if (value === null && flowSequence.test(head) && !rest.some((line) => line.trim())) {
    return /^\[\s*\]/.test(head) ? "unresolved" : null;
  }
  if (value === null && !head && rest.some((line) => sequenceItem.test(line))) {
    return rest.every((line) => sequenceItem.test(line) || blankOrComment.test(line) || /^[ \t]{2,}\S/.test(line))
      ? null
      : "unresolved";
  }
  return "unresolved";
}

/**
 * Decide, for every distinct version of a root rule, whether its tool lists it up front, keyed by
 * path and blob. Rules that load only for matching files are left out of the map. Rule content is
 * read for this even when the measurement itself needs only sizes; a rule that is not valid UTF-8
 * is unresolved.
 */
export function rulesUpFront(
  root: string,
  files: Iterable<TrackedFile>,
  measured: Map<string, BlobMeasurement>,
): Map<string, UpFront> {
  const rules = new Map<string, { file: TrackedFile; provider: "claude" | "cursor" }>();
  for (const file of files) {
    const provider = rootRuleProvider(file.path, file.classification);
    if (provider) rules.set(versionKey(file.path, file.blob), { file, provider });
  }
  const blobs = [...new Set([...rules.values()].map(({ file }) => file.blob))];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const texts = new Map<string, string | null>();
  for (const [blob, body] of readBlobs(root, blobs, (id) => measured.get(id)?.bytes ?? 0)) {
    try {
      texts.set(blob, decoder.decode(body));
    } catch {
      texts.set(blob, null);
    }
  }
  const decided = new Map<string, UpFront>();
  for (const [key, { file, provider }] of rules) {
    const text = texts.get(file.blob);
    let upFront: UpFront | null;
    try {
      upFront = text == null ? "unresolved" : ruleUpFront(text, provider);
    } catch {
      upFront = "unresolved";
    }
    if (upFront) decided.set(key, upFront);
  }
  return decided;
}
