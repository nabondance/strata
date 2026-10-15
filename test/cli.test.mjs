import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { analyzeRepository } from "../dist/analyze.js";
import { compareRevisions } from "../dist/compare.js";
import { expandRevisions } from "../dist/expand.js";
import { tiktokenImplementation } from "../dist/measurement.js";
import { compareGitCommits } from "../dist/pr-delta.js";
import { redactReport } from "../dist/privacy.js";
import { renderHtml } from "../dist/report.js";

const cliPath = resolve("dist/cli.js");
const strata = (args, options = {}) =>
  spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8", ...options });

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), "strata-cli-"));
  const git = (...args) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  const put = (path, content) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  };
  const commit = (message, ...flags) => {
    git("add", "-A");
    git("commit", "-q", ...flags, "-m", message);
    return git("rev-parse", "HEAD");
  };
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Strata Test");
  git("config", "user.email", "strata-test@example.invalid");
  git("config", "commit.gpgsign", "false");
  return { repo, git, put, commit };
}

test("incremental history matches a full tree listing at every revision", async () => {
  const { repo, git, put, commit } = fixture();
  try {
    put("README.md", "Unrelated.\n");
    put("src/index.js", "export {};\n");
    commit("Unrelated start");
    put("CLAUDE.md", "Root instructions.\n");
    put(".claude/rules/style.md", "Prefer small functions.\n");
    put(".claude/skills/review/SKILL.md", "Review the change.\n");
    put(".claude/skills/review/scripts/check.sh", "#!/bin/sh\n");
    commit("Add configuration");
    commit("Empty commit", "--allow-empty");
    put("src/index.js", "export const value = 1;\n");
    commit("Unrelated change");
    chmodSync(join(repo, ".claude/skills/review/scripts/check.sh"), 0o755);
    commit("Mode-only change");
    rmSync(join(repo, ".claude/rules/style.md"));
    symlinkSync("../../CLAUDE.md", join(repo, ".claude/rules/style.md"));
    commit("Replace a rule with a symlink");
    rmSync(join(repo, ".claude/rules/style.md"));
    put(".claude/rules/style.md", "A regular file again.\n");
    commit("Restore the rule as a file");
    git("mv", ".claude/skills/review", ".claude/skills/audit");
    git("mv", "CLAUDE.md", "AGENTS.md");
    commit("Rename a skill directory and move instructions between providers");
    git("mv", "README.md", "GEMINI.md");
    commit("Rename an untracked path onto a recognized one");
    git("checkout", "-q", "-b", "side");
    put(".gemini/settings.json", "{}\n");
    put(".claude/rules/side.md", "From the side branch.\n");
    commit("Side branch configuration");
    git("checkout", "-q", "main");
    put(".claude/rules/style.md", "Changed on main.\n");
    commit("Main branch change");
    git("merge", "-q", "--no-ff", "side", "-m", "Merge side");
    put(".claude/agents/a\nb.md", "Newline in a path.\n");
    commit("Unusual path");
    rmSync(join(repo, ".claude"), { recursive: true });
    commit("Remove a configuration directory");

    const progress = [];
    const report = await analyzeRepository(repo, { onProgress: (step) => progress.push(step) });
    assert.equal(report.revisions.length, Number(git("rev-list", "--count", "--first-parent", "HEAD")));
    assert.deepEqual(progress[0], { completed: 0, total: report.revisions.length });
    assert.deepEqual(progress.at(-1), { completed: report.revisions.length, total: report.revisions.length });
    const revisions = expandRevisions(report);
    assert.deepEqual(revisions[0].components, []);
    for (const revision of revisions) {
      assert.equal(revision.componentCount, revision.components.length);
      assert.deepEqual(
        compareRevisions(revisions[0], revision),
        compareGitCommits(repo, revisions[0].id, revision.id).comparison,
        `revision ${revision.id}`,
      );
    }

    const [, added, empty, unrelated, modeOnly, symlinked, restored, renamed, ontoRecognized] = revisions;
    assert.deepEqual(empty.changes, []);
    assert.equal(empty.components, added.components);
    assert.deepEqual(unrelated.changes, []);
    assert.deepEqual(modeOnly.changes, []);
    assert.deepEqual(
      symlinked.changes.map(({ kind, path }) => [kind, path]),
      [["removed", ".claude/rules/style.md"]],
    );
    assert.deepEqual(
      restored.changes.map(({ kind, path }) => [kind, path]),
      [["added", ".claude/rules/style.md"]],
    );
    assert.deepEqual(
      renamed.changes.map(({ kind, previousPath, path }) => [kind, previousPath, path]),
      [
        ["renamed", ".claude/skills/review/scripts/check.sh", ".claude/skills/audit/scripts/check.sh"],
        ["renamed", ".claude/skills/review/SKILL.md", ".claude/skills/audit/SKILL.md"],
        ["renamed", "CLAUDE.md", "AGENTS.md"],
      ],
    );
    assert.deepEqual(
      ontoRecognized.changes.map(({ kind, path }) => [kind, path]),
      [["added", "GEMINI.md"]],
    );
    const merge = revisions.at(-3);
    assert.deepEqual(
      merge.changes.map(({ kind, path }) => [kind, path]),
      [
        ["added", ".claude/rules/side.md"],
        ["added", ".gemini/settings.json"],
      ],
    );
    assert.ok(revisions.at(-2).components.some((component) => component.path === ".claude/agents/a\nb.md"));
    assert.ok(revisions.at(-1).components.every((component) => !component.path.startsWith(".claude/")));

    // Redaction aliases the component table and every change that points into it.
    const shareable = redactReport(report);
    assert.equal(revisions[2].components[0].path, ".claude/rules/style.md");
    assert.equal(report.components[0].path, ".claude/agents/a\nb.md");
    assert.equal(shareable.components.length, report.components.length);
    for (const component of shareable.components) assert.match(component.path, /^file-\d{5}$/);
    for (const revision of shareable.revisions) {
      for (const change of revision.changes) assert.match(change.path, /^file-\d{5}$/);
    }
    assert.doesNotMatch(renderHtml(report), /Claude API/);
    assert.match(renderHtml(report), /Content-Security-Policy/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("command line follows common conventions", () => {
  const { repo, put, commit } = fixture();
  const outside = mkdtempSync(join(tmpdir(), "strata-not-a-repo-"));
  try {
    put("AGENTS.md", "Shared instructions.\n");
    const base = commit("Add instructions");
    put("AGENTS.md", "Shared instructions, now longer.\n");
    const head = commit("Grow instructions");

    const mainHelp = strata(["--help"]);
    assert.equal(mainHelp.status, 0);
    assert.match(mainHelp.stdout, /Commands:/);
    assert.equal(strata([]).stdout, mainHelp.stdout);
    assert.equal(strata(["help"]).stdout, mainHelp.stdout);
    for (const command of ["analyze", "diff", "skill"]) {
      const commandHelp = strata([command, "--help"]);
      assert.equal(commandHelp.status, 0);
      assert.match(commandHelp.stdout, new RegExp(`strata ${command}`));
      assert.equal(strata(["help", command]).stdout, commandHelp.stdout);
      assert.equal(commandHelp.stderr, "");
    }
    const version = JSON.parse(readFileSync("package.json", "utf8")).version;
    assert.equal(strata(["--version"]).stdout, `${version}\n`);
    assert.equal(strata(["-V"]).stdout, `${version}\n`);

    // Invocation mistakes exit with 2 and point at help; runtime failures exit with 1.
    for (const [args, message] of [
      [["frobnicate"], /Unknown command: frobnicate/],
      [["--frobnicate"], /Unknown option: --frobnicate/],
      [["help", "frobnicate"], /Unknown command/],
      [["analyze", repo, "--frobnicate"], /Unknown option '--frobnicate'/],
      [["analyze", repo, "extra"], /Unexpected argument: extra/],
      [["analyze", repo, "--format", "pdf"], /--format must be html, json, svg, or badge/],
      [["analyze", repo, "--format", "badge", "--open"], /--open requires HTML or SVG output/],
      [["analyze", repo, "--minimal"], /--minimal requires --format svg/],
      [["analyze", repo, "--output"], /--output/],
      [["analyze", repo, "--open", "--output", "-"], /--open requires a report file/],
      [["analyze", repo, "--claude-model", "x"], /require --precise/],
      [["diff", repo, "--base", base], /requires --base <commit> and --head <commit>/],
      [["diff", repo, "--base", base, "--head", head, "--format", "html"], /--format must be markdown or json/],
      [["diff", repo, "--base", "main", "--head", head], /full Git commit IDs, not main/],
      [["skill", "extra"], /Unexpected argument: extra/],
    ]) {
      const result = strata(args);
      assert.equal(result.status, 2, args.join(" "));
      assert.match(result.stderr, message);
      assert.match(result.stderr, /Run strata --help for usage/);
      assert.equal(result.stdout, "");
    }
    const notRepository = strata(["analyze", outside]);
    assert.equal(notRepository.status, 1);
    assert.match(notRepository.stderr, /^strata: Git failed \(rev-parse\): not a git repository/);
    assert.doesNotMatch(notRepository.stderr, /Run strata --help/);
    assert.equal(strata(["diff", outside, "--base", base, "--head", head]).status, 1);
    const missingCommit = strata(["diff", repo, "--base", base, "--head", "0".repeat(40)]);
    assert.equal(missingCommit.status, 1);
    assert.match(missingCommit.stderr, /is unavailable/);

    // The repository defaults to the current directory, and - sends the report to stdout.
    const piped = strata(["analyze", "--format=json", "-o", "-"], { cwd: repo });
    assert.equal(piped.status, 0, piped.stderr);
    const report = JSON.parse(piped.stdout);
    assert.equal(report.revisions.length, 2);
    assert.equal(report.revisions[1].id, head);
    assert.match(piped.stderr, /Analyzed 2 revisions/);
    const silent = strata(["analyze", "-q", "-f", "json", "-o", "-"], { cwd: repo });
    assert.equal(silent.stderr, "");
    assert.deepEqual(JSON.parse(silent.stdout), report);
    const html = strata(["analyze", repo, "--output", "-"]);
    assert.match(html.stdout, /^<!doctype html>/);
    const svg = strata(["analyze", repo, "-f", "svg", "-o", "-"]);
    assert.equal(svg.status, 0, svg.stderr);
    assert.match(svg.stdout, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.match(svg.stdout, /<\/svg>\n$/);
    assert.match(svg.stdout, /<text/);
    const minimal = strata(["analyze", repo, "-f", "svg", "--minimal", "-o", "-"]);
    assert.equal(minimal.status, 0, minimal.stderr);
    assert.match(minimal.stdout, /<polygon/);
    assert.doesNotMatch(minimal.stdout, /<text/);
    // The badge is shields.io endpoint JSON holding the latest total and nothing that names the repository.
    const badge = strata(["analyze", repo, "-f", "badge", "-o", "-"]);
    assert.equal(badge.status, 0, badge.stderr);
    const badgeJson = JSON.parse(badge.stdout);
    assert.equal(badgeJson.schemaVersion, 1);
    assert.equal(badgeJson.label, "agent context");
    assert.equal(badgeJson.message, `≈${report.revisions[1].estimatedTokens.toLocaleString("en-US")} tokens`);
    assert.doesNotMatch(badge.stdout, new RegExp(head.slice(0, 7)));
    assert.doesNotMatch(badge.stdout, /AGENTS\.md/);
    const exactBadge = strata(["analyze", repo, "-f", "badge", "--tokenizer", "openai-o200k_base", "-o", "-"]);
    assert.equal(exactBadge.status, 0, exactBadge.stderr);
    assert.match(JSON.parse(exactBadge.stdout).message, /^[\d,]+ tokens$/);

    const quiet = strata(["analyze", repo, "--quiet"]);
    assert.equal(quiet.status, 0, quiet.stderr);
    assert.equal(quiet.stderr, "");
    const quietPath = quiet.stdout.trim();
    assert.match(readFileSync(quietPath, "utf8"), /^<!doctype html>/);
    rmSync(dirname(quietPath), { recursive: true, force: true });

    // An existing report is replaced, and left readable by its owner only.
    const existing = join(outside, "report.json");
    writeFileSync(existing, "stale", { mode: 0o644 });
    assert.equal(strata(["analyze", repo, "-f", "json", "-o", existing]).status, 0);
    assert.equal(JSON.parse(readFileSync(existing, "utf8")).revisions.length, 2);
    if (process.platform !== "win32") assert.equal(statSync(existing).mode & 0o777, 0o600);
    // The SVG image is meant to be published, so it gets ordinary file permissions.
    const image = join(outside, "strata.svg");
    const ordinary = join(outside, "ordinary");
    writeFileSync(ordinary, "");
    assert.equal(strata(["analyze", repo, "-f", "svg", "-o", image]).status, 0);
    assert.equal(statSync(image).mode & 0o777, statSync(ordinary).mode & 0o777);
    const badgeFile = join(outside, "strata-badge.json");
    assert.equal(strata(["analyze", repo, "-f", "badge", "-o", badgeFile]).status, 0);
    assert.equal(statSync(badgeFile).mode & 0o777, statSync(ordinary).mode & 0o777);

    const delta = strata(["diff", "--base", base, "--head", head, "--format", "json"], { cwd: repo });
    assert.equal(delta.status, 0, delta.stderr);
    assert.deepEqual(JSON.parse(delta.stdout), compareGitCommits(repo, base, head));
    assert.ok(JSON.parse(delta.stdout).comparison.deltaTokens > 0);
    assert.match(strata(["diff", repo, "--base", base, "--head", head]).stdout, /^## Strata configuration delta/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("recorded tokenizer version matches the installed dependency", () => {
  const entry = createRequire(import.meta.url).resolve("js-tiktoken");
  const { version } = JSON.parse(readFileSync(join(dirname(entry), "..", "package.json"), "utf8"));
  assert.equal(tiktokenImplementation, `js-tiktoken@${version}`);
});
