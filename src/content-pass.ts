import { readBlobs } from "./git.js";
import { type TrackedFile, versionKey } from "./inventory.js";

/** One kind of work done with file content, such as counting tokens or reading frontmatter. */
export interface ContentUse {
  /** Whether this use needs the content of a file version. */
  wants(file: TrackedFile): boolean;
  /** Use a blob's content, given the file versions holding it that this use asked for. */
  read(blob: string, body: Buffer, files: TrackedFile[]): void;
}

/**
 * Reads each blob that any use needs once, and gives its content to every use that asked for it.
 * Files are added first; a read done for another reason, such as parsing Claude imports, can be
 * offered to the waiting uses so the pass does not read that blob again.
 */
export class ContentPass {
  /** For each blob still to read, the file versions each use waits on. */
  private readonly pending = new Map<string, Map<ContentUse, TrackedFile[]>>();
  /** The versions each use was already given or is waiting on, so adding one twice does nothing. */
  private readonly asked: Set<string>[];

  constructor(private readonly uses: readonly ContentUse[]) {
    this.asked = uses.map(() => new Set());
  }

  add(files: Iterable<TrackedFile>): void {
    for (const file of files) {
      const key = versionKey(file.path, file.blob);
      this.uses.forEach((use, index) => {
        const asked = this.asked[index]!;
        if (asked.has(key) || !use.wants(file)) return;
        asked.add(key);
        let waiting = this.pending.get(file.blob);
        if (!waiting) {
          waiting = new Map();
          this.pending.set(file.blob, waiting);
        }
        const versions = waiting.get(use);
        if (versions) versions.push(file);
        else waiting.set(use, [file]);
      });
    }
  }

  /** Give a blob's content, read for another reason, to the uses waiting on it. */
  offer(blob: string, body: Buffer): void {
    const waiting = this.pending.get(blob);
    if (!waiting) return;
    this.pending.delete(blob);
    for (const [use, files] of waiting) use.read(blob, body, files);
  }

  /** Read every blob still waited on, in bounded batches sized from `sizes`. */
  run(repo: string, sizes: Map<string, number>): void {
    for (const [blob, body] of readBlobs(repo, [...this.pending.keys()], (id) => sizes.get(id) ?? 0)) {
      this.offer(blob, body);
    }
  }
}

const decoder = new TextDecoder("utf-8", { fatal: true });

/** A blob's text, or null when it is not valid UTF-8. */
export function utf8Text(body: Buffer): string | null {
  try {
    return decoder.decode(body);
  } catch {
    return null;
  }
}
