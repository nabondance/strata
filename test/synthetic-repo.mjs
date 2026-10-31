import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Starts a Git repository in `dir`, with helpers to run Git, write files, and commit them.
 * `env`, when given, is called before each Git command for extra environment variables, such as dates.
 */
export function gitRepository(dir, { env } = {}) {
  const run = (args, extra) =>
    execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      // Git's messages stay out of the test output; a failed command still includes them in its error.
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env?.(), ...extra },
    }).trim();
  const git = (...args) => run(args);
  const put = (path, content) => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  /** Commits every change and returns the commit ID; `date` sets its author and committer dates. */
  const commit = (message, { date, flags = [] } = {}) => {
    const dated = date && { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
    run(["add", "-A"], dated);
    run(["commit", "-q", ...flags, "-m", message], dated);
    return git("rev-parse", "HEAD");
  };
  mkdirSync(dir, { recursive: true });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Strata Test");
  git("config", "user.email", "strata-test@example.invalid");
  git("config", "commit.gpgsign", "false");
  return { git, put, commit };
}

/** A new Git repository in a temporary directory; `cleanup` removes it. */
export function syntheticRepo(prefix, options) {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  const cleanup = () => rmSync(repo, { recursive: true, force: true });
  try {
    return { repo, ...gitRepository(repo, options), cleanup };
  } catch (error) {
    // Callers clean up in their own finally, which a failed setup never reaches.
    cleanup();
    throw error;
  }
}
