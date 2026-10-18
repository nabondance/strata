import { execFileSync, spawn } from "node:child_process";

const maxBuffer = 1024 * 1024 * 1024;
const blobChunkBytes = 32 * 1024 * 1024;
const blobChunkCount = 4096;

function failure(args: string[], stderr: string, error?: unknown): Error {
  if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    return new Error("Git was not found on PATH; install Git to use Strata");
  }
  const detail =
    stderr
      .trim()
      .split("\n")
      .find((line) => line.trim())
      ?.replace(/^(?:fatal|error): /, "") ?? (error instanceof Error ? error.message : "unknown error");
  // Name the subcommand, after any leading `-c name=value` options.
  let command = 0;
  while (args[command] === "-c") command += 2;
  return new Error(`Git failed (${args[command] ?? args[0]}): ${detail}`);
}

/** Run a read-only Git command in a repository and return its raw output. */
export function git(repo: string, args: string[], input?: string, env?: NodeJS.ProcessEnv): Buffer {
  try {
    return execFileSync("git", ["-C", repo, ...args], {
      encoding: "buffer",
      ...(env ? { env } : {}),
      maxBuffer,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      ...(input === undefined ? {} : { input: Buffer.from(input) }),
    });
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString("utf8") ?? "";
    throw failure(args, stderr, error);
  }
}

export function gitText(repo: string, args: string[]): string {
  return git(repo, args).toString("utf8").trim();
}

/** Stream a Git command's NUL-delimited output as batches of tokens, without buffering it all. */
export async function* gitTokens(repo: string, args: string[]): AsyncGenerator<string[]> {
  const child = spawn("git", ["-C", repo, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    if (stderr.length < 8192) stderr += chunk;
  });
  const exit = new Promise<{ code: number | null; error?: Error }>((resolve) => {
    child.on("error", (error) => resolve({ code: null, error }));
    child.on("close", (code) => resolve({ code }));
  });
  let finished = false;
  try {
    let rest: Buffer | null = null;
    for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
      const tokens: string[] = [];
      let start = 0;
      for (let end = chunk.indexOf(0, start); end >= 0; end = chunk.indexOf(0, start)) {
        const piece = chunk.subarray(start, end);
        tokens.push((rest ? Buffer.concat([rest, piece]) : piece).toString("utf8"));
        rest = null;
        start = end + 1;
      }
      if (start < chunk.length) {
        const tail = chunk.subarray(start);
        rest = rest ? Buffer.concat([rest, tail]) : tail;
      }
      if (tokens.length) yield tokens;
    }
    const { code, error } = await exit;
    finished = true;
    if (error || code !== 0) throw failure(args, stderr, error);
    if (rest) yield [rest.toString("utf8")];
  } finally {
    if (!finished) child.kill();
  }
}

export interface TreeEntry {
  mode: string;
  blob: string;
  path: string;
}

/** List every entry of a revision's tree, recursively. */
export function listTree(repo: string, revision: string, env?: NodeJS.ProcessEnv): TreeEntry[] {
  const output = git(repo, ["ls-tree", "-r", "-z", "--full-tree", revision], undefined, env);
  const entries: TreeEntry[] = [];
  for (let start = 0; start < output.length; ) {
    const end = output.indexOf(0, start);
    if (end < 0) throw new Error("Malformed git ls-tree output");
    const entry = output.toString("utf8", start, end);
    const tab = entry.indexOf("\t");
    const [mode, , blob] = entry.slice(0, tab).split(" ");
    if (tab < 0 || !mode || !blob) throw new Error("Malformed git ls-tree entry");
    entries.push({ mode, blob, path: entry.slice(tab + 1) });
    start = end + 1;
  }
  return entries;
}

/** Byte sizes of blobs, read from object headers without loading their content. */
export function blobSizes(repo: string, blobs: string[]): Map<string, number> {
  const sizes = new Map<string, number>();
  if (!blobs.length) return sizes;
  const output = git(repo, ["cat-file", "--batch-check"], `${blobs.join("\n")}\n`).toString("utf8");
  for (const line of output.split("\n")) {
    if (!line) continue;
    const [blob, type, size] = line.split(" ");
    if (!blob || type !== "blob" || !size) throw new Error(`Git object is unavailable or not a blob: ${line}`);
    sizes.set(blob, Number(size));
  }
  return sizes;
}

/** Read blob contents in batches bounded by the known sizes, so memory stays flat on large histories. */
export function* readBlobs(
  repo: string,
  blobs: string[],
  sizeOf: (blob: string) => number,
): Generator<[blob: string, body: Buffer]> {
  for (let index = 0; index < blobs.length; ) {
    const chunk: string[] = [];
    for (
      let bytes = 0;
      index < blobs.length && chunk.length < blobChunkCount && (!chunk.length || bytes < blobChunkBytes);
      index += 1
    ) {
      const blob = blobs[index]!;
      chunk.push(blob);
      bytes += sizeOf(blob);
    }
    const output = git(repo, ["cat-file", "--batch"], `${chunk.join("\n")}\n`);
    let offset = 0;
    for (const blob of chunk) {
      const newline = output.indexOf(10, offset);
      const [, type, size] = newline < 0 ? [] : output.toString("utf8", offset, newline).split(" ");
      if (type !== "blob" || !size) throw new Error(`Git blob ${blob} is unavailable`);
      const start = newline + 1;
      const end = start + Number(size);
      yield [blob, output.subarray(start, end)];
      offset = end + 1;
    }
  }
}
