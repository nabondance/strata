import { execFileSync, spawn } from "node:child_process";
import { statSync } from "node:fs";
import { resolve } from "node:path";

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

/**
 * Run a Git command in a repository and return its raw output. Strata's commands are read-only,
 * except the fetch in `fetchMissingBlobs`, which adds a partial clone's missing blobs to `.git`.
 */
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

/**
 * The top level of the work tree that holds `path`, with errors that name the path instead of
 * repeating Git's message: a missing path, a file, or a directory outside any repository.
 */
export function repositoryRoot(path: string): string {
  const absolute = resolve(path);
  let directory: boolean;
  try {
    directory = statSync(absolute).isDirectory();
  } catch {
    throw new Error(`The directory ${absolute} does not exist.`);
  }
  if (!directory) throw new Error(`${absolute} is not a directory.`);
  try {
    return gitText(absolute, ["rev-parse", "--show-toplevel"]);
  } catch (error) {
    if (error instanceof Error && /not a git repository/i.test(error.message)) {
      throw new Error(`${absolute} is not inside a Git repository.`);
    }
    throw error;
  }
}

/**
 * The full ID of the commit a revision expression names, such as `HEAD~3`, a branch, or a short ID,
 * or null when it names none. `--end-of-options` keeps an expression that starts with `-` from
 * being read as an option.
 */
export function resolveCommit(repo: string, revision: string): string | null {
  try {
    return gitText(repo, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${revision}^{commit}`]) || null;
  } catch {
    return null;
  }
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

/** The remotes a partial clone can fetch missing objects from; none in a full clone. */
function promisorRemotes(repo: string): string[] {
  try {
    return gitText(repo, ["config", "--type=bool", "--get-regexp", "^remote\\..*\\.promisor$"])
      .split("\n")
      .flatMap((line) => line.match(/^remote\.(.*)\.promisor true$/)?.[1] ?? []);
  } catch {
    return [];
  }
}

/**
 * The environment for a fetch nobody asked for: it may use the caller's credential helpers and
 * askpass programs, but it must fail rather than wait at a terminal. `GIT_SSH` can name a tool that
 * does not take OpenSSH options, so it is left as it is.
 */
function withoutTerminalPrompts(repo: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  let ssh = process.env.GIT_SSH_COMMAND;
  if (!ssh) {
    try {
      ssh = gitText(repo, ["config", "--get", "core.sshCommand"]) || undefined;
    } catch {
      ssh = undefined;
    }
  }
  if (ssh || !process.env.GIT_SSH) env.GIT_SSH_COMMAND = `${ssh ?? "ssh"} -o BatchMode=yes`;
  return env;
}

/** Whether this Git honors `GIT_NO_LAZY_FETCH`, added in 2.44. */
function honorsNoLazyFetch(repo: string): boolean {
  const [, major, minor] = gitText(repo, ["version"]).match(/(\d+)\.(\d+)/) ?? [];
  return Number(major) > 2 || (Number(major) === 2 && Number(minor) >= 44);
}

/**
 * Sizes of those blobs this clone already holds, fetching none. On a partial clone with a Git that
 * cannot turn lazy fetching off, it lists the objects stored locally, which never fetches.
 */
function localBlobSizes(repo: string, blobs: string[], partial: boolean): Map<string, number> {
  const wanted = new Set(blobs);
  const sizes = new Map<string, number>();
  const output =
    partial && !honorsNoLazyFetch(repo)
      ? git(repo, ["cat-file", "--batch-all-objects", "--batch-check", "--unordered"])
      : git(repo, ["cat-file", "--batch-check"], `${blobs.join("\n")}\n`, { ...process.env, GIT_NO_LAZY_FETCH: "1" });
  for (const line of output.toString("utf8").split("\n")) {
    const [blob, type, size] = line.split(" ");
    if (blob && type === "blob" && size && wanted.has(blob)) sizes.set(blob, Number(size));
  }
  return sizes;
}

/**
 * In a partial clone, download the missing blobs in one request per remote. Git would otherwise
 * fetch each on demand, with one pack and one round trip per blob, which is slow and can fail on a
 * long history. A failure is left to the caller, which sees the blobs are still missing.
 */
function fetchMissingBlobs(repo: string, blobs: string[], remotes: string[]): void {
  for (const remote of remotes) {
    const local = localBlobSizes(repo, blobs, true);
    const missing = blobs.filter((blob) => !local.has(blob));
    if (!missing.length) return;
    try {
      // The command Git itself runs for a lazy fetch, given every object at once.
      git(
        repo,
        [
          "-c",
          "fetch.negotiationAlgorithm=noop",
          "-c",
          "gc.auto=0",
          "-c",
          "maintenance.auto=false",
          "fetch",
          "--quiet",
          "--no-tags",
          "--no-write-fetch-head",
          "--recurse-submodules=no",
          "--filter=blob:none",
          "--stdin",
          remote,
        ],
        `${missing.join("\n")}\n`,
        withoutTerminalPrompts(repo),
      );
    } catch {
      // Try the next remote. What no remote provides stays missing.
    }
  }
}

/** Byte sizes of blobs, read from object headers without loading their content. */
export function blobSizes(repo: string, blobs: string[]): Map<string, number> {
  const sizes = new Map<string, number>();
  if (!blobs.length) return sizes;
  fetchMissingBlobs(repo, blobs, promisorRemotes(repo));
  const output = git(repo, ["cat-file", "--batch-check"], `${blobs.join("\n")}\n`).toString("utf8");
  for (const line of output.split("\n")) {
    if (!line) continue;
    const [blob, type, size] = line.split(" ");
    if (!blob || type !== "blob" || !size) throw new Error(`Git object is unavailable or not a blob: ${line}`);
    sizes.set(blob, Number(size));
  }
  return sizes;
}

/**
 * Sizes of the blobs that can be read. One a partial clone cannot download, as when its remote is
 * unreachable or needs a login, is left out rather than stopping the analysis.
 */
export function availableBlobSizes(repo: string, blobs: string[]): Map<string, number> {
  if (!blobs.length) return new Map();
  const remotes = promisorRemotes(repo);
  fetchMissingBlobs(repo, blobs, remotes);
  return localBlobSizes(repo, blobs, remotes.length > 0);
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
