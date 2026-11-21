import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The release workflow's approval step, run against a fake `gh`. As right after
// release-please opens its pull request, `gh pr list --label` (GitHub's search)
// finds nothing, while the pull request list already has it.

const repo = "owner/strata";
const branch = "release-please--branches--main--components--context-strata";
const head = "a".repeat(40);
const label = { name: "autorelease: pending" };
const releasePr = { head: { ref: branch, repo: { full_name: repo } }, labels: [label] };
const runs = [
  { id: 1, conclusion: "action_required", path: ".github/workflows/ci.yml" },
  { id: 2, conclusion: "action_required", path: ".github/workflows/pr-title.yml" },
].map((run) => ({ ...run, head_branch: branch, head_repository: { full_name: repo } }));

const step = readFileSync(".github/workflows/release-please.yml", "utf8")
  .split("- name: Approve the release PR's own checks")[1]
  .split("        run: |\n")[1]
  .split("\n")
  .map((line) => line.slice(10))
  .join("\n");

const fakeGh = `#!/usr/bin/env bash
case "$*" in
  "pr list"*) exit 0 ;;
  *"/pulls?"*) cat "$FAKE/pulls.json" ;;
  *"/branches/"*) echo "$FAKE_HEAD" ;;
  *"/approve") echo "\${*: -1}" >>"$FAKE/approved"; touch "$FAKE/done" ;;
  *"actions/runs?"*)
    if [ -e "$FAKE/done" ]; then jq '.workflow_runs[].conclusion = null' "$FAKE/runs.json"; else cat "$FAKE/runs.json"; fi ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`;

function approve(t, pulls) {
  const fake = mkdtempSync(join(tmpdir(), "strata-release-approval-"));
  t.after(() => rmSync(fake, { recursive: true, force: true }));
  writeFileSync(join(fake, "gh"), fakeGh, { mode: 0o755 });
  writeFileSync(join(fake, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(fake, "pulls.json"), JSON.stringify(pulls));
  writeFileSync(join(fake, "runs.json"), JSON.stringify({ workflow_runs: runs }));
  const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", step], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${fake}:${process.env.PATH}`, FAKE: fake, FAKE_HEAD: head, GH_REPO: repo },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const log = join(fake, "approved");
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
}

const options = { skip: process.platform === "win32" };

test("approves the checks of a release PR that search does not list yet", options, (t) => {
  const other = { head: { ref: "feature", repo: { full_name: repo } }, labels: [{ name: "dependencies" }] };
  assert.deepEqual(approve(t, [other, releasePr]), [
    `repos/${repo}/actions/runs/1/approve`,
    `repos/${repo}/actions/runs/2/approve`,
  ]);
});

test("approves nothing without a release PR", options, (t) => {
  assert.deepEqual(approve(t, []), []);
});

test("does not take a fork's pull request for the release PR", options, (t) => {
  const fork = { head: { ref: branch, repo: { full_name: "someone/strata" } }, labels: [label] };
  const deleted = { head: { ref: branch, repo: null }, labels: [label] };
  assert.deepEqual(approve(t, [fork, deleted]), []);
});
