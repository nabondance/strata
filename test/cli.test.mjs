import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { getEncoding } from "js-tiktoken";
import { analyzeRepository } from "../dist/analyze.js";
import { compareRevisions } from "../dist/compare.js";
import { expandRevisions } from "../dist/expand.js";
import {
  checkLimits,
  limitAnnotations,
  limitLines,
  limitMessages,
  limitResult,
  limitSummary,
  parseLimits,
} from "../dist/limits.js";
import { tiktokenImplementation } from "../dist/measurement.js";
import { compareGitCommits } from "../dist/pr-delta.js";
import { redactReport, shareableConventions } from "../dist/privacy.js";
import { progressReporter } from "../dist/progress.js";
import { renderHtml } from "../dist/report.js";
import { loadReportUi } from "./report-ui.mjs";
import { syntheticRepo } from "./synthetic-repo.mjs";

const cliPath = resolve("dist/cli.js");
const strata = (args, options = {}) =>
  spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8", ...options });

/** A new repository for one test, which removes it when done. */
const fixture = () => syntheticRepo("strata-cli-");

/** A CLI delta without the Codex counts the CLI adds, to compare with the library's `compareGitCommits`. */
function withoutProviders({ providerMeasurements, providerTotals, ...delta }) {
  return delta;
}

test("without --precise, only Codex reads get provider counts, taken offline", () => {
  const { repo, put, commit } = fixture();
  try {
    // Claude only: no provider fields at all, so the report shows no provider note.
    const text = "Shared project instructions for every agent.\n";
    put("CLAUDE.md", text);
    const base = commit("Claude only");
    const report = JSON.parse(strata(["analyze", repo, "--format", "json", "-o", "-"]).stdout);
    assert.equal(report.providerMeasurements, undefined);
    assert.ok(report.revisions.every((revision) => revision.providerTokenTotals === undefined));
    const html = strata(["analyze", repo, "-o", "-"]).stdout;
    assert.doesNotMatch(html, /class="muted provider-note"/);
    assert.match(html, /<details class="panel" id="files-panel">/);

    // The same blob moves from CLAUDE.md to AGENTS.md, so the comparison reads it for Claude first;
    // Codex's count is still the o200k_base count of that text, and the files panel stays closed.
    rmSync(join(repo, "CLAUDE.md"));
    put("AGENTS.md", text);
    const head = commit("Move to AGENTS.md");
    const delta = JSON.parse(strata(["diff", repo, "--base", base, "--head", head, "--format", "json"]).stdout);
    const exact = getEncoding("o200k_base").encode(text).length;
    assert.deepEqual(delta.providerTotals, [
      { provider: "codex", beforeTokens: 0, afterTokens: exact, deltaTokens: exact },
    ]);
    const claudeOnly = JSON.parse(strata(["diff", repo, "--base", base, "--head", base, "--format", "json"]).stdout);
    assert.equal(claudeOnly.providerMeasurements, undefined);
    assert.equal(claudeOnly.providerTotals, undefined);
    assert.match(strata(["analyze", repo, "-o", "-"]).stdout, /<details class="panel" id="files-panel">/);

    // A Codex file that is not UTF-8 text makes Codex use the estimate, and the run says why.
    put("AGENTS.md", Buffer.from([0x68, 0x69, 0xff, 0x0a]));
    commit("Not UTF-8");
    const fallback = strata(["analyze", repo, "--format", "json", "-o", "-"]);
    assert.equal(fallback.status, 0, fallback.stderr);
    const measured = JSON.parse(fallback.stdout).providerMeasurements;
    assert.deepEqual(
      measured.map(({ provider, accuracy }) => [provider, accuracy]),
      [["codex", "estimate"]],
    );
    assert.match(measured[0].fallbacks.join(" "), /not valid UTF-8/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

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
    commit("Empty commit", { flags: ["--allow-empty"] });
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
    // Each folder name and file stem is a convention name or an alias, and the extension stays.
    const aliased = (path) =>
      path
        .split("/")
        .every((segment) => shareableConventions.names.has(segment) || /^[df]\d+(\.(md|sh))?$/.test(segment));
    for (const component of shareable.components) assert.ok(aliased(component.path), component.path);
    for (const revision of shareable.revisions) {
      for (const change of revision.changes) {
        assert.ok(aliased(change.path), change.path);
        if (change.previousPath !== undefined) assert.ok(aliased(change.previousPath), change.previousPath);
      }
    }
    assert.doesNotMatch(JSON.stringify(shareable), /style|review|check|audit|side|a\\nb/);
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
    // Limits are named in the main help and listed in full in each command's help.
    assert.match(mainHelp.stdout, /--limit-tokens 50000/);
    const diffHelp = strata(["diff", "--help"]).stdout;
    for (const flag of [
      "--limit-tokens",
      "--limit-increase",
      "--limit-up-front-tokens",
      "--limit-up-front-increase",
      "--on-limit",
      "--limit-annotations",
    ])
      assert.match(diffHelp, new RegExp(`${flag} `));
    assert.match(strata(["analyze", "--help"]).stdout, /--limit-up-front-tokens \[agent=\]<n>/);
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
      [["--frobnicate"], /^strata: Unknown option '--frobnicate'\.\n/],
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
      [["skill", "extra"], /Unexpected argument: extra/],
      [["diff", repo, "--base", base, "--head", head, "--limit-tokens", "10%"], /whole number of tokens/],
      [["diff", repo, "--base", base, "--head", head, "--limit-increase", "1.5"], /whole number of tokens/],
      [["diff", repo, "--base", base, "--head", head, "--limit-tokens", "1234567890123456"], /whole number of tokens/],
      [["diff", repo, "--base", base, "--head", head, "--limit-tokens", "claude=5"], /does not take an agent name/],
      [["diff", repo, "--base", base, "--head", head, "--limit-up-front-tokens", "bob=5"], /Unknown agent bob/],
      [["diff", repo, "--base", base, "--head", head, "--limit-increase", "5", "--limit-increase", "6"], /set twice/],
      [
        [
          "diff",
          repo,
          "--base",
          base,
          "--head",
          head,
          "--limit-up-front-tokens",
          "claude=5",
          "--limit-up-front-tokens",
          "claude=6",
        ],
        /set twice for claude/,
      ],
      [["diff", repo, "--base", base, "--head", head, "--on-limit", "warn"], /--on-limit requires a limit/],
      [["diff", repo, "--base", base, "--head", head, "--limit-annotations"], /--limit-annotations requires a limit/],
      [["diff", repo, "--base", base, "--head", head, "--limit-tokens", "1", "--on-limit", "x"], /fail or warn/],
      [["analyze", repo, "--limit-increase", "5"], /Unknown option '--limit-increase'/],
      [["diff", repo, "--base", base, "--head", head, "--json-output", "-"], /--json-output needs a file path/],
      [["analyze", repo, "--json-output", "x.json"], /Unknown option '--json-output'/],
    ]) {
      const result = strata(args);
      assert.equal(result.status, 2, args.join(" "));
      assert.match(result.stderr, message);
      assert.match(result.stderr, /Run strata --help for usage/);
      assert.equal(result.stdout, "");
    }
    // Node's advice on positionals that start with '-' is left out; a 0.5 option says what replaced it.
    const unknown = strata(["analyze", repo, "--frobnicate"]);
    assert.equal(unknown.stderr, "strata: Unknown option '--frobnicate'.\nRun strata --help for usage.\n");
    for (const removed of ["--tokenizer", "--model", "--codex-model", "--provider-api"]) {
      for (const args of [["analyze", repo, removed], ["diff", repo, `${removed}=x`], [removed]]) {
        const result = strata(args);
        assert.equal(result.status, 2, args.join(" "));
        assert.equal(
          result.stderr,
          `strata: Unknown option '${removed}'. It was removed in 0.6: Codex is now counted exactly by default, and --precise covers Claude and Gemini.\nRun strata --help for usage.\n`,
        );
      }
    }

    // A path outside any repository, a missing directory, or a file is named, without Git's message.
    for (const [path, message] of [
      [outside, `${outside} is not inside a Git repository.`],
      [join(outside, "nope"), `The directory ${join(outside, "nope")} does not exist.`],
      [join(repo, "AGENTS.md"), `${join(repo, "AGENTS.md")} is not a directory.`],
    ]) {
      for (const args of [
        ["analyze", path],
        ["diff", path, "--base", base, "--head", head],
      ]) {
        const result = strata(args);
        assert.equal(result.status, 1, args.join(" "));
        assert.equal(result.stderr, `strata: ${message}\n`);
      }
    }

    // Any revision that names a commit works, and the delta keeps the full IDs.
    const full = JSON.parse(strata(["diff", repo, "--base", base, "--head", head, "-f", "json"]).stdout);
    for (const [from, to] of [
      ["main~1", "main"],
      [base.slice(0, 7), "HEAD"],
      [`${head}~`, `${head}^{commit}`],
    ]) {
      const result = strata(["diff", repo, "--base", from, "--head", to, "-f", "json"]);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), full);
    }
    for (const [args, message] of [
      [["--base", base, "--head", "0".repeat(40)], `Head "${"0".repeat(40)}"`],
      [["--base", "HEAD~5", "--head", head], 'Base "HEAD~5"'],
      // Git reads it as a revision, not as its own option.
      [["--base=--all", "--head", head], 'Base "--all"'],
      [["--base", "nope", "--head", head], 'Base "nope"'],
    ]) {
      const result = strata(["diff", repo, ...args]);
      assert.equal(result.status, 1, args.join(" "));
      assert.equal(
        result.stderr,
        `strata: ${message} does not name a commit in this repository; check it, or fetch it if this clone lacks it\n`,
      );
    }

    // --json-output writes the JSON of the same comparison beside the Markdown.
    const both = join(outside, "both");
    mkdirSync(both);
    const compared = ["diff", repo, "--base", base, "--head", head];
    const markdownAndJson = strata([
      ...compared,
      "-o",
      join(both, "delta.md"),
      "--json-output",
      join(both, "delta.json"),
    ]);
    assert.equal(markdownAndJson.status, 0, markdownAndJson.stderr);
    assert.equal(markdownAndJson.stdout, `Delta: ${join(both, "delta.md")}\nJSON delta: ${join(both, "delta.json")}\n`);
    assert.equal(readFileSync(join(both, "delta.md"), "utf8"), strata(compared).stdout);
    assert.equal(readFileSync(join(both, "delta.json"), "utf8"), strata([...compared, "-f", "json"]).stdout);
    // With the delta on standard output, the JSON path goes to standard error.
    const toStdout = strata([...compared, "--json-output", join(both, "again.json")]);
    assert.equal(toStdout.stdout, strata(compared).stdout);
    assert.equal(toStdout.stderr, `JSON delta: ${join(both, "again.json")}\n`);
    if (process.platform !== "win32") assert.equal(statSync(join(both, "again.json")).mode & 0o777, 0o600);
    const same = strata([...compared, "-o", join(both, "x"), "--json-output", join(both, ".", "x")]);
    assert.equal(same.status, 2);
    assert.match(same.stderr, /--json-output and --output must be different files/);
    // - is standard output, not a file named -.
    const dashFile = strata([...compared, "-o", "-", "--json-output", "./-"], { cwd: both });
    assert.equal(dashFile.status, 0, dashFile.stderr);
    assert.equal(dashFile.stdout, strata(compared).stdout);

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
    assert.deepEqual(withoutProviders(JSON.parse(delta.stdout)), compareGitCommits(repo, base, head));
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
    assert.equal(JSON.parse(none.stdout).schemaVersion, 14);

    const over = diff(
      "--format",
      "json",
      "--limit-tokens",
      String(plain.comparison.afterTokens - 1),
      "--limit-increase",
      "1",
      "--limit-up-front-tokens",
      "100000",
      "--limit-up-front-tokens",
      `claude=${claude.after.tokens - 1}`,
      "--limit-up-front-increase",
      "1",
    );
    assert.equal(over.status, 3, over.stderr);
    const delta = JSON.parse(over.stdout);
    // The CLI adds Codex's local counts to what the library comparison holds.
    assert.deepEqual({ ...withoutProviders(delta), limits: undefined }, { ...plain, limits: undefined });
    assert.deepEqual(
      delta.providerMeasurements.map(({ provider, accuracy }) => [provider, accuracy]),
      [["codex", "encoding-exact"]],
    );
    assert.deepEqual(
      delta.limits.map(({ name, agent, result }) => [name, agent, result]),
      [
        ["limit-tokens", null, "over"],
        ["limit-increase", null, "over"],
        ["limit-up-front-tokens", "claude", "over"],
        ["limit-up-front-tokens", "codex", "within"],
        ["limit-up-front-tokens", "cursor", "within"],
        ["limit-up-front-increase", "claude", "over"],
        ["limit-up-front-increase", "codex", "within"],
        ["limit-up-front-increase", "cursor", "over"],
      ],
    );
    assert.match(
      over.stderr,
      /^Over limit: stored instructional text is \d+ tokens, more than the \d+ set with --limit-tokens\.$/m,
    );
    assert.match(
      over.stderr,
      /^Over limit: stored instructional text grew by \d+ tokens \(\+[\d.]+%\), more than the 1 set/m,
    );
    assert.match(over.stderr, /^Over limit: Claude Code at session start is \d+ tokens/m);
    // Cursor had nothing at the base, so its growth has no percentage.
    assert.match(over.stderr, /^Over limit: Cursor at session start grew by \d+ tokens, more than the 1 set/m);

    const markdown = diff("--limit-increase", "1");
    assert.equal(markdown.status, 3);
    assert.match(markdown.stdout, /\*\*Over 1 of 1 limit set for this run\.\*\*/);
    assert.match(
      markdown.stdout,
      /\| Stored instructional text, increase \| \+\d+ \(\+[\d.]+%\) \| 1 \| \*\*Over\*\* \|/,
    );
    assert.match(markdown.stdout, /not that the configuration got worse/);

    // warn reports the same and exits with 0; a written file still holds the table.
    const file = join(outside, "delta.md");
    const warned = diff("--limit-increase", "1", "--on-limit", "warn", "--output", file);
    assert.equal(warned.status, 0);
    assert.match(warned.stderr, /^Over limit: /m);
    assert.match(readFileSync(file, "utf8"), /Over 1 of 1 limit/);

    // A dry run has taken the local measurement limits use, so it checks them.
    const dry = diff("--precise", "--dry-run", "--no-cache", "--limit-tokens", "1");
    assert.equal(dry.status, 3, dry.stderr);
    assert.match(dry.stdout, /Dry run: nothing was sent[\s\S]*Over 1 of 1 limit set for this run\./);
    assert.match(dry.stderr, /^Over limit: stored instructional text is \d+ tokens/m);
    // --limit-annotations writes GitHub workflow commands next to the lines.
    const annotated = diff("--limit-tokens", "1", "--on-limit", "warn", "--limit-annotations");
    assert.equal(annotated.status, 0);
    assert.match(annotated.stderr, /^::warning title=Strata context limit::stored instructional text is \d+ tokens/m);

    const within = diff("--limit-tokens", "100000");
    assert.equal(within.status, 0);
    assert.equal(within.stderr, "");
    assert.match(within.stdout, /Within the 1 limit set for this run\./);

    // analyze checks the latest revision, after writing the report, even with --quiet.
    const report = join(outside, "report.json");
    const analyzed = strata(["analyze", repo, "-q", "-f", "json", "-o", report, "--limit-up-front-tokens", "cursor=1"]);
    assert.equal(analyzed.status, 3);
    assert.equal(analyzed.stdout, `${report}\n`);
    assert.match(analyzed.stderr, /^Over limit: Cursor at session start is \d+ tokens, more than the 1 set/m);
    assert.equal(JSON.parse(readFileSync(report, "utf8")).revisions.length, 2);
    // A quiet dry run prints no summary on standard output.
    const quietDry = strata(["analyze", repo, "-q", "--precise", "--dry-run", "--no-cache", "--limit-tokens", "1"]);
    assert.equal(quietDry.status, 3);
    assert.doesNotMatch(quietDry.stdout, /limit set for this run/);
    // A viewer that fails to open does not hide a passed limit: the limits come first.
    if (process.platform !== "win32") {
      // PATH holds only Git, so the default viewer command is missing.
      const bin = join(outside, "bin");
      mkdirSync(bin);
      symlinkSync(execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(), join(bin, "git"));
      const opened = strata(["analyze", repo, "-o", join(outside, "open.html"), "--open", "--limit-tokens", "1"], {
        env: { ...process.env, PATH: bin },
      });
      // The failure to open is printed, but the passed limit keeps its status.
      assert.equal(opened.status, 3);
      assert.match(opened.stderr, /^Over limit: stored instructional text[\s\S]*Could not open the report/m);
    }

    // An agent that only reads on demand keeps nothing at session start, so a general
    // session-start limit applies to no agent, and the run says so beside the limits it checked.
    const onDemand = fixture();
    try {
      onDemand.put(".claude/agents/review.md", "Review the change.\n");
      onDemand.commit("Add an agent");
      const unused = strata([
        "analyze",
        onDemand.repo,
        "-o",
        report,
        "--limit-tokens",
        "100000",
        "--limit-up-front-tokens",
        "5",
      ]);
      assert.equal(unused.status, 0, unused.stderr);
      assert.match(unused.stdout, /Within 1 of 2 limits set for this run; 1 applied to no agent\./);
      assert.match(
        unused.stderr,
        /^Limit not applied: --limit-up-front-tokens 5 applied to no agent: none keeps text at session start\.$/m,
      );
    } finally {
      rmSync(onDemand.repo, { recursive: true, force: true });
    }
    const fine = strata(["analyze", repo, "-o", report, "--limit-tokens", "100000"]);
    assert.equal(fine.status, 0);
    assert.match(fine.stdout, /Within the 1 limit set for this run\./);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("limits compare at their boundaries and never drop a limit", () => {
  const figures = (before, after, upFront = new Map()) => ({ total: { before, after }, upFront });
  const result = (flags, before, after) =>
    checkLimits(parseLimits(flags), figures(before, after)).map((check) => check.result);
  assert.deepEqual(result({ "limit-tokens": ["100"] }, 0, 100), ["within"]);
  assert.deepEqual(result({ "limit-tokens": ["100"] }, 0, 101), ["over"]);
  assert.deepEqual(result({ "limit-increase": ["10"] }, 100, 110), ["within"]);
  assert.deepEqual(result({ "limit-increase": ["10"] }, 100, 111), ["over"]);
  assert.deepEqual(result({ "limit-increase": ["0"] }, 200, 150), ["within"]);
  // One token reads as singular, and the share is rounded to a tenth.
  const one = checkLimits(parseLimits({ "limit-increase": ["0"] }), figures(3, 4));
  assert.deepEqual(limitMessages(one), [
    "Over limit: stored instructional text grew by 1 token (+33.3%), more than the 0 set with --limit-increase.",
  ]);
  assert.match(
    limitLines(checkLimits(parseLimits({ "limit-increase": ["10"] }), figures(3, 2))).join("\n"),
    /\| -1 \(-33\.3%\) \| 10 \| Within \|/,
  );
  // An agent's own limit replaces the general one; a general limit left with no agent says so.
  const claudeOnly = new Map([["claude", { before: 0, after: 7000 }]]);
  const replaced = checkLimits(
    parseLimits({ "limit-up-front-tokens": ["5000", "claude=8000"] }),
    figures(0, 7000, claudeOnly),
  );
  assert.deepEqual(
    replaced.map(({ agent, limit, result }) => [agent, limit, result]),
    [
      ["claude", 8000, "within"],
      [null, 5000, "replaced"],
    ],
  );
  assert.equal(limitSummary(replaced), "Within 1 of 2 limits set for this run; 1 applied to no agent.");
  // The overall result counts only the limits that were checked.
  assert.equal(limitResult(replaced), "within");
  assert.equal(limitResult(undefined), "none");
  assert.equal(limitResult(checkLimits(parseLimits({ "limit-up-front-tokens": ["8000"] }), figures(null, 0))), "none");
  assert.equal(
    limitResult(checkLimits(parseLimits({ "limit-up-front-tokens": ["claude=1"] }), figures(0, 7000, claudeOnly))),
    "over",
  );
  assert.match(
    limitLines(replaced).join("\n"),
    /\| Every agent at session start \| — \| 5000 \| Not applied: each agent has its own limit \|/,
  );
  // When every limit applied to no agent, the summary says so rather than "Within 0 of 1".
  assert.equal(
    limitSummary(checkLimits(parseLimits({ "limit-up-front-tokens": ["8000"] }), figures(null, 0))),
    "The 1 limit set for this run applied to no agent.",
  );
  // With no agent at all, the same.
  assert.deepEqual(checkLimits(parseLimits({ "limit-up-front-tokens": ["8000"] }), figures(null, 0)), [
    { name: "limit-up-front-tokens", agent: null, limit: 8000, before: null, after: null, result: "no-agent" },
  ]);
  // A limit for one agent that keeps nothing is checked as zero tokens; the general limit skips absent agents.
  const upFront = checkLimits(parseLimits({ "limit-up-front-tokens": ["5", "gemini=0"] }), {
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
  // Annotations escape what workflow commands require.
  assert.deepEqual(limitAnnotations(one, "error"), [
    "::error title=Strata context limit::stored instructional text grew by 1 token (+33.3%25), more than the 0 set with --limit-increase.",
  ]);
  assert.deepEqual(limitAnnotations(replaced, "error"), [
    "::warning title=Strata context limit not applied::--limit-up-front-tokens 5000 applied to no agent: each agent that keeps text at session start has its own limit.",
  ]);
});

test("the Action writes the summary, then annotates and fails or warns on a passed limit", {
  skip: process.platform === "win32",
}, () => {
  const { repo, put, commit } = fixture();
  const temp = mkdtempSync(join(tmpdir(), "strata-action-"));
  try {
    put("CLAUDE.md", "Root.\n");
    const base = commit("Add instructions");
    put("CLAUDE.md", "Root instructions, grown by a good amount.\n");
    const head = commit("Grow instructions");
    const run = actionRunner(temp, { GITHUB_WORKSPACE: repo, STRATA_BASE: base, STRATA_HEAD: head });

    const plain = run({});
    assert.equal(plain.status, 0, plain.stderr);
    assert.match(plain.summary, /^## Strata configuration delta/);
    assert.doesNotMatch(plain.stdout + plain.stderr, /::/);
    const delta = JSON.parse(readFileSync(plain.outputs["json-file"], "utf8"));
    assert.equal(delta.schemaVersion, 14);
    assert.deepEqual(
      { ...plain.outputs, "json-file": undefined },
      {
        tokens: String(delta.comparison.afterTokens),
        "delta-tokens": String(delta.comparison.deltaTokens),
        "limit-result": "none",
        "summary-file": plain.outputs["summary-file"],
        "json-file": undefined,
      },
    );
    assert.equal(readFileSync(plain.outputs["summary-file"], "utf8"), plain.summary);

    const failed = run({ STRATA_LIMIT_INCREASE: "1", STRATA_LIMIT_UP_FRONT_TOKENS: "claude=1, codex=5" });
    assert.equal(failed.status, 3);
    assert.match(failed.summary, /\*\*Over 2 of 3 limits set for this run\.\*\*/);
    assert.match(
      failed.stderr,
      /^::error title=Strata context limit::stored instructional text grew by \d+ tokens \(\+[\d.]+%25\), more than the 1 set/m,
    );
    assert.match(failed.stderr, /^::error title=Strata context limit::Claude Code at session start is \d+ tokens/m);
    assert.match(failed.stderr, /^Over limit: Claude Code at session start/m);
    assert.equal(failed.outputs["limit-result"], "over");
    // Each run has its own files, so the first run's outputs still hold its results.
    assert.notEqual(failed.outputs["json-file"], plain.outputs["json-file"]);
    assert.equal(JSON.parse(readFileSync(plain.outputs["json-file"], "utf8")).limits, undefined);

    const warned = run({ STRATA_LIMIT_INCREASE: "1", STRATA_ON_LIMIT: "warn" });
    assert.equal(warned.status, 0);
    assert.match(warned.stderr, /^::warning title=Strata context limit::/m);
    assert.match(warned.summary, /Over 1 of 1 limit/);
    assert.equal(warned.outputs["limit-result"], "over");
    assert.equal(run({ STRATA_LIMIT_INCREASE: "100000" }).outputs["limit-result"], "within");

    // A limit that applied to no agent warns without failing the step.
    const unused = run({ STRATA_LIMIT_UP_FRONT_TOKENS: "claude=100000 5" });
    assert.equal(unused.status, 0, unused.stderr);
    assert.match(
      unused.stderr,
      /^::warning title=Strata context limit not applied::--limit-up-front-tokens 5 applied to no agent/m,
    );
    assert.equal(unused.outputs["limit-result"], "within");

    // A real failure fails the step and writes no summary or outputs.
    const invalid = run({ STRATA_LIMIT_TOKENS: "lots" });
    assert.equal(invalid.status, 2);
    assert.equal(invalid.summary, null);
    assert.deepEqual(invalid.outputs, {});
    // on-limit matters only with a limit: Strata validates it then, and ignores it otherwise.
    assert.equal(run({ STRATA_ON_LIMIT: "maybe", STRATA_LIMIT_TOKENS: "100000" }).status, 2);
    assert.equal(run({ STRATA_ON_LIMIT: "" }).status, 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(temp, { recursive: true, force: true });
  }
});

test("the Action compares the event's commits and fetches those a shallow checkout lacks", {
  skip: process.platform === "win32",
}, () => {
  const { repo, put, commit } = fixture();
  const temp = mkdtempSync(join(tmpdir(), "strata-action-"));
  try {
    put("CLAUDE.md", "Root.\n");
    const base = commit("Add instructions");
    put("CLAUDE.md", "Root instructions, grown.\n");
    const head = commit("Grow instructions");
    const run = actionRunner(temp, { GITHUB_WORKSPACE: repo });
    const error = (result) => result.stdout.match(/^::error title=Strata::(.*)$/m)?.[1];

    // Without base and head, the event's commits are compared.
    const event = run({ STRATA_EVENT: "merge_group", STRATA_EVENT_BASE: base, STRATA_EVENT_HEAD: head });
    assert.equal(event.status, 0, event.stdout + event.stderr);
    const delta = JSON.parse(readFileSync(event.outputs["json-file"], "utf8"));
    assert.deepEqual([delta.base, delta.head], [base, head]);
    // Given inputs take precedence over the event's commits.
    const given = run({ STRATA_BASE: head, STRATA_HEAD: base, STRATA_EVENT_BASE: base, STRATA_EVENT_HEAD: head });
    assert.equal(JSON.parse(readFileSync(given.outputs["json-file"], "utf8")).base, head);

    const failures = [
      [{ STRATA_EVENT: "workflow_dispatch" }, /^A workflow_dispatch event has no commits to compare/],
      [{ STRATA_BASE: base }, /^Set both the base and head inputs/],
      // An input cannot add a workflow command of its own.
      [
        { STRATA_BASE: "main\n::warning::x", STRATA_HEAD: head },
        /^Base and head must be full Git commit IDs, not main%0A::warning::x\.$/,
      ],
      [{ STRATA_BASE: base, STRATA_HEAD: head, GITHUB_WORKSPACE: temp }, /^No Git repository at .*actions\/checkout/],
    ];
    for (const [inputs, message] of failures) {
      const result = run(inputs);
      assert.equal(result.status, 1, JSON.stringify(inputs));
      assert.match(error(result) ?? "", message);
      assert.equal(result.summary, null);
    }
    // With no agent keeping text at session start, a session-start limit is not checked, so no limit was.
    const settings = fixture();
    try {
      settings.put(".claude/settings.json", "{}\n");
      const before = settings.commit("Add settings");
      settings.put(".claude/settings.json", '{ "model": "x" }\n');
      const after = settings.commit("Change settings");
      const unchecked = run({
        GITHUB_WORKSPACE: settings.repo,
        STRATA_BASE: before,
        STRATA_HEAD: after,
        STRATA_LIMIT_UP_FRONT_TOKENS: "5",
      });
      assert.equal(unchecked.status, 0, unchecked.stderr);
      assert.equal(unchecked.outputs["limit-result"], "none");
    } finally {
      rmSync(settings.repo, { recursive: true, force: true });
    }
    // A push that creates or deletes a branch or tag has nothing to compare, which is not a failure.
    for (const [before, after] of [
      ["0".repeat(40), head],
      [head, "0".repeat(40)],
    ]) {
      const skipped = run({ STRATA_EVENT: "push", STRATA_EVENT_BASE: before, STRATA_EVENT_HEAD: after });
      assert.equal(skipped.status, 0);
      assert.match(skipped.stdout, /^::notice title=Strata::This push creates or deletes a branch or tag/m);
      assert.equal(skipped.summary, null);
    }

    // A default checkout is shallow and holds neither commit; the Action fetches both and keeps it shallow.
    put("AGENTS.md", "Shared.\n");
    const merge = commit("Merge for the pull request");
    const shallow = join(temp, "shallow");
    execFileSync("git", ["clone", "-q", "--depth=1", `file://${repo}`, shallow]);
    const inShallow = (...args) => spawnSync("git", ["-C", shallow, ...args], { encoding: "utf8" });
    assert.equal(inShallow("rev-parse", "HEAD").stdout.trim(), merge);
    assert.notEqual(inShallow("cat-file", "-e", `${base}^{commit}`).status, 0);
    const fetched = run({ GITHUB_WORKSPACE: shallow, STRATA_BASE: base, STRATA_HEAD: head });
    assert.equal(fetched.status, 0, fetched.stdout + fetched.stderr);
    assert.equal(fetched.summary, event.summary);
    assert.equal(inShallow("rev-parse", "--is-shallow-repository").stdout.trim(), "true");
    assert.equal(inShallow("rev-list", "--count", "HEAD").stdout.trim(), "1");
    assert.equal(inShallow("status", "--porcelain").stdout, "");

    const unknown = run({ GITHUB_WORKSPACE: shallow, STRATA_BASE: "f".repeat(40), STRATA_HEAD: head });
    assert.equal(unknown.status, 1);
    assert.match(error(unknown) ?? "", /^Could not fetch f{40} from origin\. .*fetch-depth: 0/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(temp, { recursive: true, force: true });
  }
});

test("on a pull request the Action compares GitHub's merge commit with the base it merges into", {
  skip: process.platform === "win32",
}, () => {
  const { repo, git, put, commit } = fixture();
  const temp = mkdtempSync(join(tmpdir(), "strata-action-"));
  try {
    put("CLAUDE.md", "Root instructions, long enough to trim later.\n");
    const branchPoint = commit("Add instructions");
    git("checkout", "-q", "-b", "feature");
    put("AGENTS.md", "Shared instructions from the pull request.\n");
    const prHead = commit("Add shared instructions");
    git("checkout", "-q", "main");
    // The base branch moves on after the pull request branched from it.
    put("CLAUDE.md", "Root.\n");
    const baseTip = commit("Trim instructions");
    git("merge", "-q", "--no-ff", "--no-edit", "feature");
    const merge = git("rev-parse", "HEAD");
    // actions/checkout on pull_request: only the merge commit, at depth 1.
    const shallow = join(temp, "shallow");
    execFileSync("git", ["clone", "-q", "--depth=1", `file://${repo}`, shallow]);
    const run = actionRunner(temp, {
      GITHUB_WORKSPACE: shallow,
      STRATA_EVENT: "pull_request",
      STRATA_EVENT_BASE: baseTip,
      STRATA_EVENT_HEAD: prHead,
      STRATA_EVENT_MERGE: merge,
    });
    const changes = (result) => {
      const delta = JSON.parse(readFileSync(result.outputs["json-file"], "utf8"));
      return {
        base: delta.base,
        head: delta.head,
        files: delta.comparison.components.map(({ path, kind }) => [path, kind]),
      };
    };

    // Only the pull request's own change counts, not the base branch's later trim.
    const merged = run({});
    assert.equal(merged.status, 0, merged.stdout + merged.stderr);
    assert.doesNotMatch(merged.stdout, /::warning/);
    assert.deepEqual(changes(merged), { base: baseTip, head: merge, files: [["AGENTS.md", "added"]] });
    // pull_request_target has the merge commit only in its payload, fetched like the others.
    const target = run({ STRATA_EVENT: "pull_request_target", GITHUB_WORKSPACE: repo });
    assert.deepEqual(changes(target), changes(merged));

    // Without a merge commit whose second parent is the head, the tips are compared, with a warning.
    for (const [missing, warning] of [
      ["", /^::warning title=Strata::No commit merging this pull request's head into its base was found, so/m],
      [branchPoint, /^::warning title=Strata::No commit merging this pull request's head into its base was found, so/m],
      // A merge commit that cannot be fetched is named as such, not as missing.
      [
        "e".repeat(40),
        /^::warning title=Strata::Could not fetch e{40}, GitHub's merge commit for this pull request, from origin, so/m,
      ],
    ]) {
      const tips = run({ STRATA_EVENT: "pull_request_target", STRATA_EVENT_MERGE: missing });
      assert.equal(tips.status, 0, tips.stdout + tips.stderr);
      assert.match(tips.stdout, warning);
      const { base, head, files } = changes(tips);
      assert.deepEqual([base, head], [baseTip, prHead]);
      assert.equal(files.length, 2);
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(temp, { recursive: true, force: true });
  }
});

/** Runs the Action's comparison step as GitHub does for `shell: bash`, with each input as its environment variable. */
test("--ignore leaves paths out of analyze and diff, and the report header and summary say so", () => {
  const { repo, put, commit, cleanup } = fixture();
  try {
    put("AGENTS.md", "Root instructions for every agent.\n");
    put("CLAUDE.md", "@examples/notes.md\n");
    put("examples/notes.md", "Example notes.\n");
    put("examples/agent/AGENTS.md", "Example app instructions.\n");
    put("templates/basic/CLAUDE.md", "Template instructions.\n");
    const base = commit("Configuration with example apps and templates");
    put("templates/basic/CLAUDE.md", "Template instructions, grown by a few more words.\n");
    put("AGENTS.md", "Root instructions for every agent, edited.\n");
    const head = commit("Edit a template and the root");
    const ignore = ["--ignore", "examples/**", "--ignore", "templates/"];

    const plain = JSON.parse(strata(["analyze", repo, "-f", "json", "-o", "-"]).stdout);
    assert.equal(plain.ignore, undefined);
    const json = strata(["analyze", repo, "-f", "json", "-o", "-", ...ignore]);
    assert.equal(json.status, 0, json.stderr);
    const report = JSON.parse(json.stdout);
    assert.deepEqual(report.ignore, ["examples/**", "templates/"]);
    assert.deepEqual(
      expandRevisions(report).map((revision) => revision.components.map(({ path }) => path)),
      [
        ["AGENTS.md", "CLAUDE.md"],
        ["AGENTS.md", "CLAUDE.md"],
      ],
    );
    assert.match(
      json.stderr,
      /^Ignoring 2 patterns \(examples\/\*\*, templates\/\): the paths they match are left out of every revision\.$/m,
    );
    // The import of an ignored file is missing.
    assert.match(json.stderr, /1 Claude @path import is unresolved at the last revision \(1 missing\)/);
    // --shareable keeps the patterns, which the user typed.
    const shared = JSON.parse(strata(["analyze", repo, "-f", "json", "-o", "-", "--shareable", ...ignore]).stdout);
    assert.deepEqual(shared.ignore, report.ignore);

    // The header line names how many patterns were ignored, with the patterns in its title.
    const { get } = loadReportUi(strata(["analyze", repo, "-o", "-", ...ignore]).stdout);
    assert.equal(get("repo-ignore").hidden, false);
    assert.equal(get("repo-ignore").textContent, " · ignoring 2 patterns");
    assert.match(get("repo-ignore").title, /examples\/\*\*, templates\/$/);
    const without = loadReportUi(strata(["analyze", repo, "-o", "-"]).stdout).get;
    assert.equal(without("repo-ignore").hidden, true);

    const delta = strata(["diff", repo, "--base", base, "--head", head, "-f", "json", ...ignore]);
    assert.equal(delta.status, 0, delta.stderr);
    const parsed = JSON.parse(delta.stdout);
    assert.deepEqual(parsed.ignore, ["examples/**", "templates/"]);
    assert.deepEqual(
      parsed.comparison.components.map(({ path }) => path),
      ["AGENTS.md"],
    );
    const unfiltered = JSON.parse(strata(["diff", repo, "--base", base, "--head", head, "-f", "json"]).stdout);
    assert.equal(unfiltered.ignore, undefined);
    assert.equal(unfiltered.comparison.components.length, 2);
    assert.match(
      strata(["diff", repo, "--base", base, "--head", head, "--ignore", "templates/"]).stdout,
      /^Left out at both commits: paths matching templates\/ \(`--ignore`\)\./m,
    );

    for (const command of [
      ["analyze", repo],
      ["diff", repo, "--base", base, "--head", head],
    ]) {
      const refused = strata([...command, "--ignore", "!examples/keep.md"]);
      assert.equal(refused.status, 2);
      assert.match(refused.stderr, /--ignore: Ignore patterns cannot re-include paths/);
      assert.equal(strata([...command, "--ignore="]).status, 2);
    }
    assert.match(strata(["help", "analyze"]).stdout, /--ignore <glob>/);
    assert.match(strata(["help", "diff"]).stdout, /--ignore <glob>/);
  } finally {
    cleanup();
  }
});

test("the Action passes its ignore input to strata diff, one pattern per line or comma", {
  skip: process.platform === "win32",
}, () => {
  const { repo, put, commit } = fixture();
  const temp = mkdtempSync(join(tmpdir(), "strata-action-"));
  try {
    put("AGENTS.md", "Root.\n");
    put("examples/app/AGENTS.md", "Example.\n");
    put("my templates/CLAUDE.md", "Template.\n");
    const base = commit("Add instructions");
    put("examples/app/AGENTS.md", "Example, grown.\n");
    put("my templates/CLAUDE.md", "Template, grown.\n");
    put("AGENTS.md", "Root, grown.\n");
    const head = commit("Grow instructions");
    const run = actionRunner(temp, { GITHUB_WORKSPACE: repo, STRATA_BASE: base, STRATA_HEAD: head });
    const changed = (result) =>
      JSON.parse(readFileSync(result.outputs["json-file"], "utf8")).comparison.components.map(({ path }) => path);

    const plain = run({});
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(JSON.parse(readFileSync(plain.outputs["json-file"], "utf8")).ignore, undefined);
    assert.equal(changed(plain).length, 3);

    // Newlines and commas both separate patterns; spaces around one are trimmed, and spaces inside kept.
    const ignored = run({ STRATA_IGNORE: "examples/**,\n  my templates/  \n\n" });
    assert.equal(ignored.status, 0, ignored.stderr);
    const delta = JSON.parse(readFileSync(ignored.outputs["json-file"], "utf8"));
    assert.deepEqual(delta.ignore, ["examples/**", "my templates/"]);
    assert.deepEqual(changed(ignored), ["AGENTS.md"]);
    assert.match(ignored.summary, /Left out at both commits: paths matching examples\/\\\*\\\*, my templates\//);
    // A pattern Strata refuses fails the step.
    assert.equal(run({ STRATA_IGNORE: "!examples/keep.md" }).status, 2);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(temp, { recursive: true, force: true });
  }
});

function actionRunner(temp, defaults) {
  const action = readFileSync("action.yml", "utf8");
  const script = action
    .split("    - name: Compare the commits")[1]
    .split("      run: |\n")[1]
    .split("\n")
    .map((line) => line.slice(8))
    .join("\n");
  return (inputs) => {
    const runner = mkdtempSync(join(temp, "run-"));
    const summary = join(runner, "summary.md");
    const output = join(runner, "output");
    const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_ACTION_PATH: resolve("."),
        RUNNER_TEMP: runner,
        GITHUB_STEP_SUMMARY: summary,
        GITHUB_OUTPUT: output,
        STRATA_BASE: "",
        STRATA_HEAD: "",
        STRATA_EVENT: "pull_request",
        STRATA_EVENT_BASE: "",
        STRATA_EVENT_HEAD: "",
        STRATA_EVENT_MERGE: "",
        STRATA_PRECISE: "false",
        STRATA_IGNORE: "",
        STRATA_LIMIT_TOKENS: "",
        STRATA_LIMIT_INCREASE: "",
        STRATA_LIMIT_UP_FRONT_TOKENS: "",
        STRATA_LIMIT_UP_FRONT_INCREASE: "",
        STRATA_ON_LIMIT: "fail",
        ...defaults,
        ...inputs,
      },
    });
    const read = (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    };
    const outputs = Object.fromEntries(
      (read(output) ?? "")
        .split("\n")
        .filter(Boolean)
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    return { ...result, summary: read(summary), outputs };
  };
}

test("the analyze summary names the method in words and says where Strata looks when it finds nothing", () => {
  const { repo, put, commit } = fixture();
  try {
    put("README.md", "No agent configuration here.\n");
    put("skills/pdf/SKILL.md", "---\nname: pdf\ndescription: Not under a recognized skill folder.\n---\n");
    commit("Skills at the root");
    const empty = strata(["analyze", repo, "-o", "-", "-f", "json"]);
    assert.equal(empty.status, 0, empty.stderr);
    assert.equal(
      empty.stderr,
      [
        `Analyzed 1 revisions of ${JSON.parse(empty.stdout).repository}.`,
        "Latest: 0 tracked components, 0 stored-text tokens (UTF-8 bytes / 4 per file, an estimate).",
        "Strata recognized no agent configuration in this history. It looks for files such as CLAUDE.md, AGENTS.md, GEMINI.md,",
        ".github/copilot-instructions.md, and the .claude/, .codex/, .agents/skills/, and .cursor/rules/ folders.",
        "Everything it recognizes: https://github.com/nabondance/strata/blob/main/docs/analysis-scope.md",
        "",
      ].join("\n"),
    );
    // The JSON keeps the method ID.
    assert.match(JSON.parse(empty.stdout).measurement.method, /^utf8-bytes-divided-by-four-v1: /);
    assert.equal(strata(["analyze", repo, "-q", "-o", "-"]).stderr, "");

    // Once a revision had a recognized file, an empty latest revision is not "nothing recognized".
    put("CLAUDE.md", "Root instructions.\n");
    commit("Add instructions");
    rmSync(join(repo, "CLAUDE.md"));
    commit("Remove instructions");
    const removed = strata(["analyze", repo, "-o", "-", "-f", "json"]);
    assert.match(removed.stderr, /^Latest: 0 tracked components/m);
    assert.doesNotMatch(removed.stderr, /recognized no agent configuration/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("the session-start summary shows the AGENTS.md a provider skips", () => {
  const { repo, put, commit } = fixture();
  try {
    put("CLAUDE.md", "Claude instructions.\n");
    put("AGENTS.md", "x".repeat(400));
    commit("Both root files");
    const result = strata(["analyze", repo, "-o", "-", "-f", "json"]);
    assert.equal(result.status, 0, result.stderr);
    const line = result.stderr.split("\n").find((text) => text.startsWith("At session start:"));
    assert.match(
      line,
      /^At session start: Claude Code 6 tokens \(0 more when needed, 100 skipped: AGENTS\.md, as CLAUDE\.md exists\), /,
    );
    assert.match(line, /, Codex 100 tokens \(0 more when needed\)[,.]/);
    assert.equal(line.match(/skipped/g).length, 1);
    // Without a root Claude file, nothing is skipped and the line says nothing about it.
    rmSync(join(repo, "CLAUDE.md"));
    commit("AGENTS.md only");
    assert.doesNotMatch(strata(["analyze", repo, "-o", "-", "-f", "json"]).stderr, /skipped/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a diff with no changed file prints a line instead of empty tables, and the same JSON", () => {
  const { repo, put, commit } = fixture();
  try {
    put("CLAUDE.md", "Root instructions.\n");
    const base = commit("Add instructions");
    put("README.md", "Not agent configuration.\n");
    const head = commit("Edit the README");
    const markdown = strata(["diff", repo, "--base", base, "--head", head]);
    assert.equal(markdown.status, 0, markdown.stderr);
    assert.match(markdown.stdout, /\n\nNo instruction files changed\.\n\n/);
    assert.doesNotMatch(markdown.stdout, /\| Category |\| File /);
    const delta = JSON.parse(strata(["diff", repo, "--base", base, "--head", head, "-f", "json"]).stdout);
    assert.deepEqual(withoutProviders(delta), compareGitCommits(repo, base, head));
    assert.deepEqual(delta.comparison.components, []);
    // A change keeps both tables and drops the line.
    put("CLAUDE.md", "Root instructions, grown.\n");
    const grown = strata(["diff", repo, "--base", base, "--head", commit("Grow")]).stdout;
    assert.match(grown, /\| Category \| Δ files \| Δ tokens \|/);
    assert.match(grown, /\| CLAUDE\.md \| edited \|/);
    assert.doesNotMatch(grown, /No instruction files changed/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("progress waits two seconds, then rewrites one line on a terminal and appends tenths elsewhere", () => {
  const run = (isTTY, times) => {
    const written = [];
    let clock = 0;
    const report = progressReporter({ isTTY, write: (text) => written.push(text) }, () => clock, 2000);
    for (const [at, completed] of times) {
      clock = at;
      report({ completed, total: 20 });
    }
    return written;
  };
  // A run that ends within the delay prints nothing.
  const quick = Array.from({ length: 21 }, (_, completed) => [completed * 50, completed]);
  assert.deepEqual(run(false, quick), []);
  assert.deepEqual(run(true, quick), []);
  // A slow run prints from the first update after the delay: on a terminal one line, cleared at the end.
  const slow = Array.from({ length: 21 }, (_, completed) => [completed * 200, completed]);
  assert.deepEqual(run(false, slow), [
    "Processed 10/20 revisions.\n",
    "Processed 12/20 revisions.\n",
    "Processed 14/20 revisions.\n",
    "Processed 16/20 revisions.\n",
    "Processed 18/20 revisions.\n",
    "Processed 20/20 revisions.\n",
  ]);
  const terminal = run(true, slow);
  assert.equal(terminal.length, 11);
  assert.ok(terminal.every((text) => text.startsWith("\r\x1b[KAnalyzing revisions ") && !text.includes("\n")));
  assert.equal(terminal.at(-1), "\r\x1b[KAnalyzing revisions 20/20\r\x1b[K");
  // A repeated final update prints nothing more.
  assert.deepEqual(run(false, [...slow, [5000, 20]]), run(false, slow));
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
    assert.match(shareable.stderr, /submodule d1 holds 1 recognized/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("recorded tokenizer version matches the installed dependency", () => {
  const entry = createRequire(import.meta.url).resolve("js-tiktoken");
  const { version } = JSON.parse(readFileSync(join(dirname(entry), "..", "package.json"), "utf8"));
  assert.equal(tiktokenImplementation, `js-tiktoken@${version}`);
});
