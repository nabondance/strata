import { readBlobs } from "./git.js";
import type { BlobMeasurement, TrackedFile } from "./inventory.js";
import type { LineAgeChange } from "./model.js";

/** Recorded in the report so a reader knows how lines were matched and weighed. */
export const lineAgeMethod = "exact-trimmed-line-multiset-utf8-bytes-v1";

/** A blob's nonblank lines, as interned line IDs, each followed by how often it occurs. */
type LineCounts = Uint32Array;

/**
 * Read every instructional blob once and reduce it to counts of its trimmed, nonblank lines. Line
 * text is interned, so the many versions of a file share one copy of each line; the text itself
 * never leaves this module. Lines are matched and weighed by their stored bytes, so a file that is
 * not valid UTF-8 keeps distinct lines distinct; `weights[id]` is the byte length of line `id`.
 * Each line is read from its own bytes, because a slice of a decoded file would keep the whole
 * file alive.
 */
export function readLineCounts(
  repo: string,
  files: Iterable<TrackedFile>,
  measured: Map<string, BlobMeasurement>,
): { lines: Map<string, LineCounts>; weights: number[] } {
  const blobs = new Set<string>();
  for (const file of files) if (file.classification.instructionalText) blobs.add(file.blob);
  const ids = new Map<string, number>();
  const weights: number[] = [];
  const lines = new Map<string, LineCounts>();
  for (const [blob, body] of readBlobs(repo, [...blobs], (blob) => measured.get(blob)?.bytes ?? 0)) {
    const counts = new Map<number, number>();
    for (let start = 0; start < body.length; ) {
      const newline = body.indexOf(10, start);
      const end = newline < 0 ? body.length : newline;
      const line = trimmedRange(body, start, end);
      start = end + 1;
      if (!line) continue;
      // Latin-1 maps each byte to one character, so the key is the bytes themselves.
      const key = body.toString("latin1", line[0], line[1]);
      let id = ids.get(key);
      if (id === undefined) {
        id = weights.push(key.length) - 1;
        ids.set(key, id);
      }
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    lines.set(blob, Uint32Array.from([...counts].flat()));
  }
  return { lines, weights };
}

/**
 * The byte range of a line without the whitespace `String.prototype.trim` removes, or undefined
 * when nothing is left. Whitespace is always valid UTF-8, so the bytes of what was trimmed are the
 * UTF-8 length of the trimmed text, even when the rest of the line is not valid UTF-8.
 */
function trimmedRange(body: Buffer, start: number, end: number): [number, number] | undefined {
  const text = body.toString("utf8", start, end);
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (trimmed.length === text.length) return [start, end];
  const leading = text.length - text.trimStart().length;
  const trailing = text.length - text.trimEnd().length;
  return [
    start + Buffer.byteLength(text.slice(0, leading)),
    end - Buffer.byteLength(text.slice(text.length - trailing)),
  ];
}

/**
 * Follow every copy of every instruction line through the history. A line is matched by its exact
 * trimmed text across all instructional files, whatever their path, so text moved from one file to
 * another keeps its age. Each copy remembers the revision it appeared at. When a revision adds
 * copies of a line beyond those already present, the extra copies are new; when it removes copies,
 * the newest go first, so the oldest text is the text said to survive. A line that disappears and
 * later returns is new again: survival means continuous presence.
 */
export class LineAges {
  /** For each line ID, the revisions its present copies appeared at, oldest first. */
  private readonly origins = new Map<number, number[]>();

  constructor(
    private readonly lines: Map<string, LineCounts>,
    private readonly weights: number[],
  ) {}

  /**
   * Apply one revision: `removed` are the instructional blobs that left the inventory and `added`
   * those that entered it, counting a blob once per path. Returns the bytes added and the bytes
   * removed from each earlier revision, or undefined when the revision moved no line.
   */
  apply(revision: number, removed: string[], added: string[]): LineAgeChange | undefined {
    const net = new Map<number, number>();
    const count = (blob: string, sign: number) => {
      const counts = this.lines.get(blob);
      if (!counts) return;
      for (let index = 0; index < counts.length; index += 2) {
        const id = counts[index]!;
        net.set(id, (net.get(id) ?? 0) + sign * counts[index + 1]!);
      }
    };
    for (const blob of removed) count(blob, -1);
    for (const blob of added) count(blob, 1);
    let addedBytes = 0;
    const lost = new Map<number, number>();
    for (const [id, change] of net) {
      if (!change) continue;
      const weight = this.weights[id]!;
      let copies = this.origins.get(id);
      if (change > 0) {
        if (!copies) {
          copies = [];
          this.origins.set(id, copies);
        }
        for (let copy = 0; copy < change; copy += 1) copies.push(revision);
        addedBytes += change * weight;
      } else {
        // The blobs removed were all present, so there are always enough copies to drop.
        for (let copy = 0; copy < -change; copy += 1) {
          const origin = copies!.pop()!;
          lost.set(origin, (lost.get(origin) ?? 0) + weight);
        }
        if (!copies!.length) this.origins.delete(id);
      }
    }
    if (!addedBytes && !lost.size) return undefined;
    const removedBytes = [...lost].sort(([a], [b]) => a - b).map(([from, bytes]) => ({ from, bytes }));
    return { added: addedBytes, ...(removedBytes.length ? { removed: removedBytes } : {}) };
  }
}
