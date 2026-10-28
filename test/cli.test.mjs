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
import { checkLimits, limitLines, limitMessages, limitSummary, parseLimits } from "../dist/limits.js";
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
    // The British spelling runs the same command, and help says so.
    assert.match(mainHelp.stdout, /analyse is an alias/);
    assert.equal(strata(["analyse", "--help"]).stdout, strata(["analyze", "--help"]).stdout);
    assert.equal(strata(["help", "analyse"]).stdout, strata(["analyze", "--help"]).stdout);
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
      [["diff", repo, "--base", base, "--head", head, "--max-tokens", "10%"], /not a percentage/],
      [["diff", repo, "--base", base, "--head", head, "--max-tokens", "claude=5"], /does not take an agent name/],
      [["diff", repo, "--base", base, "--head", head, "--max-up-front-tokens", "bob=5"], /Unknown agent bob/],
      [["diff", repo, "--base", base, "--head", head, "--max-increase", "1.5"], /whole number of tokens/],
      [["diff", repo, "--base", base, "--head", head, "--max-increase", "5", "--max-increase", "6%"], /set twice/],
      [["diff", repo, "--base", base, "--head", head, "--on-exceed", "warn"], /--on-exceed requires a limit/],
      [["diff", repo, "--base", base, "--head", head, "--max-tokens", "1", "--on-exceed", "x"], /fail or warn/],
      [["analyze", repo, "--max-increase", "5"], /Unknown option '--max-increase'/],
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
    const britishSpelling = strata(["analyse", "-q", "-f", "json", "-o", "-"], { cwd: repo });
    assert.equal(britishSpelling.status, 0);
    assert.deepEqual(JSON.parse(britishSpelling.stdout).revisions, JSON.parse(silent.stdout).revisions);
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

test("limits report a passed number and exit with 3, only when set", () => {
  const { repo, put, commit } = fixture();
  const outside = mkdtempSync(join(tmpdir(), "strata-limits-"));
  try {
    put("CLAUDE.md", "Root instructions.\n");
    put("AGENTS.md", "Shared.\n");
    const base = commit("Add instructions");
    put("CLAUDE.md", "Root instructions, now quite a bit longer than they were.\n");
    put(".cursor/rules/style.mdc", "---\nalwaysApply: true\n---\nPrefer small functions.\n");
    const head = commit("Grow instructions and add Cursor");
    const diff = (...args) => strata(["diff", repo, "--base", base, "--head", head, ...args]);
    const plain = compareGitCommits(repo, base, head);
    const claude = plain.upFront.find((entry) => entry.provider === "claude");

    // Without limits the output and status are unchanged.
    const none = diff("--format", "json");
    assert.equal(none.status, 0);
    assert.equal(JSON.parse(none.stdout).limits, undefined);
    assert.equal(JSON.parse(none.stdout).schemaVersion, 12);

    const over = diff(
      "--format",
      "json",
      "--max-tokens",
      String(plain.comparison.afterTokens - 1),
      "--max-increase",
      "10%",
      "--max-up-front-tokens",
      "100000",
      "--max-up-front-tokens",
      `claude=${claude.after.tokens - 1}`,
      "--max-up-front-increase",
      "10%",
    );
    assert.equal(over.status, 3, over.stderr);
    const delta = JSON.parse(over.stdout);
    assert.deepEqual({ ...delta, limits: undefined }, { ...plain, limits: undefined });
    assert.deepEqual(
      delta.limits.map(({ name, agent, result }) => [name, agent, result]),
      [
        ["max-tokens", null, "over"],
        ["max-increase", null, "over"],
        ["max-up-front-tokens", "claude", "over"],
        ["max-up-front-tokens", "codex", "within"],
        ["max-up-front-tokens", "cursor", "within"],
        ["max-up-front-increase", "claude", "over"],
        ["max-up-front-increase", "codex", "within"],
        // Cursor had nothing at the base, so a percentage cannot be taken.
        ["max-up-front-increase", "cursor", "unchecked"],
      ],
    );
    assert.match(
      over.stderr,
      /^Over limit: stored instructional text is \d+ tokens, more than the \d+ set with --max-tokens\.$/m,
    );
    assert.match(
      over.stderr,
      /^Over limit: stored instructional text grew by \d+ tokens \(\+[\d.]+%\), more than the 10% set/m,
    );
    assert.match(over.stderr, /^Over limit: Claude Code at session start is \d+ tokens/m);
    assert.match(
      over.stderr,
      /^Limit not checked: --max-up-front-increase 10% for Cursor at session start, which had no tokens at the base\.$/m,
    );
    // The displayed share is the comparison's own percentChange, to one decimal.
    const total = delta.limits.find((check) => check.name === "max-increase");
    const shown = Number(/grew by \d+ tokens \(\+([\d.]+)%\)/.exec(over.stderr)[1]);
    assert.ok(Math.abs(shown - plain.comparison.percentChange) <= 0.1, `${shown} vs ${plain.comparison.percentChange}`);
    assert.equal(total.before, plain.comparison.beforeTokens);

    const markdown = diff("--max-increase", "10%");
    assert.equal(markdown.status, 3);
    assert.match(markdown.stdout, /\*\*Over 1 of 1 limit set for this run\.\*\*/);
    assert.match(
      markdown.stdout,
      /\| Stored instructional text, increase \| \+\d+ \(\+[\d.]+%\) \| 10% \| \*\*Over\*\* \|/,
    );
    assert.match(markdown.stdout, /not that the configuration got worse/);

    // warn reports the same and exits with 0; a written file still holds the table.
    const file = join(outside, "delta.md");
    const warned = diff("--max-increase", "10%", "--on-exceed", "warn", "--output", file);
    assert.equal(warned.status, 0);
    assert.match(warned.stderr, /^Over limit: /m);
    assert.match(readFileSync(file, "utf8"), /Over 1 of 1 limit/);

    // A dry run measures nothing, so it says the limits were not checked.
    const dry = diff("--precise", "--dry-run", "--no-cache", "--max-tokens", "1");
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /Limits were not checked: a dry run measures nothing\./);

    const within = diff("--max-tokens", "100000");
    assert.equal(within.status, 0);
    assert.equal(within.stderr, "");
    assert.match(within.stdout, /Within the 1 limit set for this run\./);

    // analyze checks the latest revision, after writing the report, even with --quiet.
    const report = join(outside, "report.json");
    const analyzed = strata(["analyze", repo, "-q", "-f", "json", "-o", report, "--max-up-front-tokens", "cursor=1"]);
    assert.equal(analyzed.status, 3);
    assert.equal(analyzed.stdout, `${report}\n`);
    assert.match(analyzed.stderr, /^Over limit: Cursor at session start is \d+ tokens, more than the 1 set/m);
    assert.equal(JSON.parse(readFileSync(report, "utf8")).revisions.length, 2);
    const fine = strata(["analyze", repo, "-o", report, "--max-tokens", "100000"]);
    assert.equal(fine.status, 0);
    assert.match(fine.stdout, /Within the 1 limit set for this run\./);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("limits compare at their boundaries", () => {
  const figures = (before, after) => ({ total: { before, after }, upFront: new Map() });
  const result = (flags, before, after) =>
    checkLimits(parseLimits(flags), figures(before, after)).map((check) => check.result);
  assert.deepEqual(result({ "max-tokens": ["100"] }, 0, 100), ["within"]);
  assert.deepEqual(result({ "max-tokens": ["100"] }, 0, 101), ["over"]);
  assert.deepEqual(result({ "max-increase": ["10"] }, 100, 110), ["within"]);
  assert.deepEqual(result({ "max-increase": ["10"] }, 100, 111), ["over"]);
  assert.deepEqual(result({ "max-increase": ["10%"] }, 200, 220), ["within"]);
  assert.deepEqual(result({ "max-increase": ["10%"] }, 200, 221), ["over"]);
  assert.deepEqual(result({ "max-increase": ["0"] }, 200, 150), ["within"]);
  assert.deepEqual(result({ "max-increase": ["12.5%"] }, 0, 0), ["within"]);
  assert.deepEqual(result({ "max-increase": ["12.5%"] }, 0, 1), ["unchecked"]);
  // Percentages compare exactly: 0.57 * 10000 is not exact in floating point.
  assert.deepEqual(result({ "max-increase": ["0.57%"] }, 10000, 10057), ["within"]);
  assert.deepEqual(result({ "max-increase": ["0.57%"] }, 10000, 10058), ["over"]);
  // Tiny percentages keep their digits instead of turning into exponent notation.
  assert.deepEqual(result({ "max-increase": ["0.00000015%"] }, 1e12, 1e12 + 1500), ["within"]);
  assert.deepEqual(result({ "max-increase": ["0.00000015%"] }, 1e12, 1e12 + 1501), ["over"]);
  const tiny = checkLimits(parseLimits({ "max-increase": ["0.00000015%"] }), figures(1e12, 1e12 + 1501));
  assert.match(limitMessages(tiny)[0], /more than the 0\.00000015% set/);
  // A decrease rounds to the nearest tenth, not away from zero.
  const shrink = checkLimits(parseLimits({ "max-increase": ["10%"] }), figures(3, 2));
  assert.match(limitLines(shrink).join("\n"), /\| -1 \(-33\.3%\) \| 10% \| Within \|/);
  // A share just over the limit never prints as equal to it.
  const justOver = checkLimits(parseLimits({ "max-increase": ["10%"] }), figures(10000, 11001));
  assert.match(limitMessages(justOver)[0], /grew by 1001 tokens \(\+10\.1%\), more than the 10% set/);
  // A summary does not call skipped checks a pass.
  const mixed = checkLimits(parseLimits({ "max-tokens": ["100"], "max-increase": ["10%"] }), figures(0, 50));
  assert.equal(
    limitSummary(mixed),
    "Within 1 of 2 limits set for this run; 1 not checked because the base had no tokens.",
  );
  const skipped = checkLimits(parseLimits({ "max-increase": ["10%"] }), figures(0, 50));
  assert.equal(limitSummary(skipped), "The 1 limit set for this run was not checked: the base had no tokens.");
  // A limit for one agent that reads nothing is checked as zero tokens; the general limit skips absent agents.
  const upFront = checkLimits(parseLimits({ "max-up-front-tokens": ["5", "gemini=0"] }), {
    total: { before: 0, after: 0 },
    upFront: new Map([["claude", { before: 1, after: 9 }]]),
  });
  assert.deepEqual(
    upFront.map(({ agent, after, result }) => [agent, after, result]),
    [
      ["claude", 9, "over"],
      ["gemini", 0, "within"],
    ],
  );
});

test("the Action writes the summary, then annotates and fails or warns on a passed limit", {
  skip: process.platform === "win32",
}, () => {
  // The composite step's script, run under the shell options GitHub uses for `shell: bash`.
  const action = readFileSync("action.yml", "utf8");
  const script = action
    .split("    - name: Compare PR commits")[1]
    .split("      run: |\n")[1]
    .split("\n")
    .map((line) => line.slice(8))
    .join("\n");
  const { repo, put, commit } = fixture();
  const temp = mkdtempSync(join(tmpdir(), "strata-action-"));
  try {
    put("CLAUDE.md", "Root.\n");
    const base = commit("Add instructions");
    put("CLAUDE.md", "Root instructions, grown by a good amount.\n");
    const head = commit("Grow instructions");
    const run = (inputs) => {
      const runner = mkdtempSync(join(temp, "run-"));
      const summary = join(runner, "summary.md");
      const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], {
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_WORKSPACE: repo,
          GITHUB_ACTION_PATH: resolve("."),
          RUNNER_TEMP: runner,
          GITHUB_STEP_SUMMARY: summary,
          STRATA_BASE: base,
          STRATA_HEAD: head,
          STRATA_TOKENIZER: "estimate",
          STRATA_MODEL: "",
          STRATA_PRECISE: "false",
          STRATA_MAX_TOKENS: "",
          STRATA_MAX_INCREASE: "",
          STRATA_MAX_UP_FRONT_TOKENS: "",
          STRATA_MAX_UP_FRONT_INCREASE: "",
          STRATA_ON_EXCEED: "fail",
          ...inputs,
        },
      });
      let written = null;
      try {
        written = readFileSync(summary, "utf8");
      } catch {}
      return { ...result, summary: written };
    };

    const plain = run({});
    assert.equal(plain.status, 0, plain.stderr);
    assert.match(plain.summary, /^## Strata configuration delta/);
    assert.doesNotMatch(plain.stdout, /::/);

    const failed = run({ STRATA_MAX_INCREASE: "10%", STRATA_MAX_UP_FRONT_TOKENS: "claude=1, codex=5" });
    assert.equal(failed.status, 3);
    assert.match(failed.summary, /\*\*Over 2 of 3 limits set for this run\.\*\*/);
    assert.match(
      failed.stdout,
      /^::error title=Strata context limit::stored instructional text grew by \d+ tokens \(\+[\d.]+%25\), more than the 10%25 set/m,
    );
    assert.match(failed.stdout, /^::error title=Strata context limit::Claude Code at session start is \d+ tokens/m);

    const warned = run({ STRATA_MAX_INCREASE: "10%", STRATA_ON_EXCEED: "warn" });
    assert.equal(warned.status, 0);
    assert.match(warned.stdout, /^::warning title=Strata context limit::/m);
    assert.match(warned.summary, /Over 1 of 1 limit/);

    // A percentage that cannot be checked warns without failing the step.
    put(".cursor/rules/style.mdc", "---\nalwaysApply: true\n---\nPrefer small functions.\n");
    const withCursor = commit("Add an always-apply Cursor rule");
    const skipped = run({ STRATA_HEAD: withCursor, STRATA_MAX_UP_FRONT_INCREASE: "cursor=10%" });
    assert.equal(skipped.status, 0, skipped.stderr);
    assert.match(
      skipped.stdout,
      /^::warning title=Strata context limit not checked::--max-up-front-increase 10%25 for Cursor at session start/m,
    );
    assert.match(skipped.summary, /The 1 limit set for this run was not checked/);

    // A real failure fails the step and writes no summary.
    const invalid = run({ STRATA_MAX_TOKENS: "lots" });
    assert.equal(invalid.status, 2);
    assert.equal(invalid.summary, null);
    assert.equal(run({ STRATA_ON_EXCEED: "maybe" }).status, 1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(temp, { recursive: true, force: true });
  }
});

test("analyze notes submodules that hold agent configuration", () => {
  const { repo, git, put, commit } = fixture();
  try {
    put("CLAUDE.md", "Root instructions.\n");
    commit("Add instructions");
    const sub = (...args) =>
      execFileSync("git", ["-C", join(repo, ".claude-template"), ...args], { encoding: "utf8" }).trim();
    put(".claude-template/.claude/agents/review.md", "Review.\n");
    sub("init", "-q", "-b", "main");
    sub("config", "user.name", "Strata Test");
    sub("config", "user.email", "strata-test@example.invalid");
    sub("config", "commit.gpgsign", "false");
    sub("add", "-A");
    sub("commit", "-q", "-m", "Template");
    git("update-index", "--add", "--cacheinfo", `160000,${sub("rev-parse", "HEAD")},.claude-template`);
    git("update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},vendor/lib`);
    git("commit", "-q", "-m", "Add submodules");

    const result = strata(["analyze", repo, "--format", "json", "--output", "-"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).submodules.length, 2);
    assert.match(
      result.stderr,
      /Note: the Git submodule \.claude-template holds 1 recognized agent configuration file that Strata did not analyze\./,
    );
    assert.match(result.stderr, /Note: 1 Git submodule was not checked for agent configuration/);
    // A shareable run keeps the submodule's name out of its output too.
    const shareable = strata(["analyze", repo, "--shareable", "--format", "json", "--output", "-"]);
    assert.doesNotMatch(shareable.stdout + shareable.stderr, /claude-template/);
    assert.match(shareable.stderr, /submodule submodule-00001 holds 1 recognized/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("recorded tokenizer version matches the installed dependency", () => {
  const entry = createRequire(import.meta.url).resolve("js-tiktoken");
  const { version } = JSON.parse(readFileSync(join(dirname(entry), "..", "package.json"), "utf8"));
  assert.equal(tiktokenImplementation, `js-tiktoken@${version}`);
});
