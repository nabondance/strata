import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Starts a Git repository in `dir`, with helpers to run Git, write files, and commit them.
 * `commit` takes an optional ISO date for its author and committer dates, and returns the commit ID.
 */
export function gitRepository(dir) {
  const run = (args, env) =>
    execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      ...(env && { env: { ...process.env, ...env } }),
    }).trim();
  const git = (...args) => run(args);
  const put = (path, content) => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  const commit = (message, date) => {
    const env = date && { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
    run(["add", "-A"], env);
    run(["commit", "-q", "-m", message], env);
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
export function syntheticRepo(prefix) {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  return { repo, ...gitRepository(repo), cleanup: () => rmSync(repo, { recursive: true, force: true }) };
}
