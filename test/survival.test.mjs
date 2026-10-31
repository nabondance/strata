import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeRepository } from "../dist/analyze.js";
import {
  instructionAgePeriods,
  instructionAges,
  sharePercent,
  summarizeInstructionAge,
} from "../dist/instruction-age.js";
import { redactReport } from "../dist/privacy.js";
import { renderHtml } from "../dist/report.js";
import { assertLineAgesMatchTrees } from "./line-age-oracle.mjs";

/**
 * Run Strata with a `git` on the PATH that logs every object ID asked of `cat-file --batch`, and
 * check that no command reads a blob's content twice. The fixture holds a Claude import root, a
 * skill manifest, root rules, and a settings file, so every step that reads content takes part.
 */
function assertReadsEachBlobOnce(repo, base, head) {
  const bin = mkdtempSync(join(tmpdir(), "strata-git-shim-"));
  try {
    const log = join(bin, "reads.log");
    const shim = join(bin, "git");
    writeFileSync(
      shim,
      '#!/bin/sh\ncase " $* " in\n  *" cat-file --batch "*) tee -a "$STRATA_READ_LOG" | "$STRATA_REAL_GIT" "$@" ;;\n  *) exec "$STRATA_REAL_GIT" "$@" ;;\nesac\n',
    );
    chmodSync(shim, 0o755);
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      STRATA_READ_LOG: log,
      STRATA_REAL_GIT: execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(),
    };
    const output = join(bin, "out.json");
    for (const args of [
      ["analyze", repo, "--output", output, "--format", "json"],
      ["analyze", repo, "--output", output, "--format", "json", "--tokenizer", "openai-o200k_base"],
      ["analyze", repo, "--output", output, "--format", "json", "--precise", "--dry-run", "--no-cache"],
      ["diff", repo, "--base", base, "--head", head, "--format", "json", "--tokenizer", "openai-o200k_base"],
      ["diff", repo, "--base", base, "--head", head, "--format", "json", "--precise", "--dry-run", "--no-cache"],
    ]) {
      writeFileSync(log, "");
      const run = spawnSync(process.execPath, ["dist/cli.js", ...args], { encoding: "utf8", env });
      assert.equal(run.status, 0, run.stderr);
      const reads = readFileSync(log, "utf8").split("\n").filter(Boolean);
      assert.ok(reads.length, args.join(" "));
      assert.equal(new Set(reads).size, reads.length, `${args.join(" ")} read a blob twice`);
    }
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
}

const bytes = (...lines) => lines.reduce((sum, line) => sum + Buffer.byteLength(line), 0);

/** A repository whose commits get one dated day each, so periods and order are deterministic. */
function fixture(prefix) {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  let day = 0;
  const env = () => {
    const date = new Date(Date.UTC(2026, 0, 1 + day)).toISOString().replace(".000Z", "Z");
    day += 1;
    return { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  };
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: env() }).trim();
  const put = (path, content) => {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), content);
  };
  const commit = (message) => {
    git("add", "-A");
    git("commit", "-q", "-m", message);
  };
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Strata Test");
  git("config", "user.email", "strata-test@example.invalid");
  git("config", "core.autocrlf", "false");
  return { repo, git, put, commit, cleanup: () => rmSync(repo, { recursive: true, force: true }) };
}

test("dates instruction lines by the revision they appeared at and follows them across files", async () => {
  const { repo, git, put, commit, cleanup } = fixture("strata-survival-");
  const title = "# Project";
  const tests = "Always run the full test suite before committing.";
  const pnpm = "Use pnpm, never npm.";
  const small = "Prefer small, focused pull requests.";
  const smallEdited = "Prefer small, focused pull requests!";
  const keep = "Keep this.";
  const rule = "Shared rule text.";
  const frontmatter = ["---", "name: build", "description: Build steps."];
  const claude = (...lines) => put("CLAUDE.md", `${lines.join("\n")}\n\n`);
  try {
    // 0: the baseline. A skill resource holding the same bytes as CLAUDE.md is the same blob at a
    // source-only path, so its lines are not instruction lines.
    claude(title, tests, pnpm, small, keep, keep);
    put(".claude/skills/build/copy.txt", `${[title, tests, pnpm, small, keep, keep].join("\n")}\n\n`);
    commit("baseline");
    // 1: a line moves into a skill, indented and with CRLF endings, and keeps its age.
    claude(title, tests, small, keep, keep);
    put(".claude/skills/build/SKILL.md", `${[...frontmatter, "---", `  ${pnpm}`].join("\r\n")}\r\n`);
    commit("move a line into a skill");
    // 2: a near-identical edit is a removal and an addition.
    claude(title, tests, smallEdited, keep, keep);
    commit("edit a line");
    // 3: a third copy of a duplicated line is new; 4: removing one copy drops the newest.
    put(".claude/skills/build/SKILL.md", `${[...frontmatter, "---", pnpm, keep].join("\n")}\n`);
    commit("duplicate a line");
    claude(title, tests, smallEdited, keep);
    commit("remove one copy");
    // 5: a deletion, then 6: its revert, which brings the line back as new.
    claude(title, smallEdited, keep);
    commit("delete a line");
    git("revert", "--no-edit", "HEAD");
    // 7: one blob at two instructional paths counts twice; 8: removing one path removes one copy.
    put(".claude/rules/a.md", `${rule}\n`);
    put(".claude/rules/b.md", `${rule}\n`);
    commit("two rules with the same text");
    rmSync(join(repo, ".claude/rules/b.md"));
    commit("remove one rule");
    // 9: an unrecognized file, 10: a rename, 11: settings. None moves an instruction line.
    put("README.md", "Readme.\n");
    commit("readme");
    git("mv", "CLAUDE.md", "AGENTS.md");
    commit("rename");
    put(".claude/settings.json", JSON.stringify({ note: tests }));
    commit("settings");

    const report = await analyzeRepository(repo);
    assertLineAgesMatchTrees(repo, report);
    assert.equal(report.schemaVersion, 19);
    assert.equal(report.lineAgeMethod, "exact-trimmed-line-multiset-stored-bytes-v1");
    assert.equal(report.revisions.length, 12);
    const copy = report.components.find((component) => component.path === ".claude/skills/build/copy.txt");
    const root = report.components.find((component) => component.path === "CLAUDE.md");
    assert.equal(copy.blob, root.blob);
    assert.equal(copy.estimatedTokens, null);
    const changes = report.revisions.map((revision) => revision.lineAge);
    assert.deepEqual(changes, [
      { added: bytes(title, tests, pnpm, small, keep, keep) },
      { added: bytes(...frontmatter, "---") },
      { added: bytes(smallEdited), removed: [{ from: 0, bytes: bytes(small) }] },
      { added: bytes(keep) },
      { added: 0, removed: [{ from: 3, bytes: bytes(keep) }] },
      { added: 0, removed: [{ from: 0, bytes: bytes(tests) }] },
      { added: bytes(tests) },
      { added: bytes(rule, rule) },
      { added: 0, removed: [{ from: 7, bytes: bytes(rule) }] },
      undefined,
      undefined,
      undefined,
    ]);
    // The rename and settings revisions changed files without moving a line.
    assert.ok(report.revisions[10].changes.length && report.revisions[11].changes.length);

    const ages = instructionAges(report);
    const last = [
      { from: 0, bytes: bytes(title, pnpm, keep, keep) },
      { from: 1, bytes: bytes(...frontmatter, "---") },
      { from: 2, bytes: bytes(smallEdited) },
      { from: 6, bytes: bytes(tests) },
      { from: 7, bytes: bytes(rule) },
    ];
    assert.deepEqual(ages.at(11), last);
    assert.equal(ages.bytes[11], bytes(title, pnpm, keep, keep, ...frontmatter, "---", smallEdited, tests, rule));
    // Asking for an earlier revision replays again; revisions that move no line share one array.
    assert.equal(ages.at(3).find((cohort) => cohort.from === 3)?.bytes, bytes(keep));
    assert.equal(
      ages.at(4).find((cohort) => cohort.from === 3),
      undefined,
    );
    assert.equal(ages.at(9), ages.at(10));
    assert.deepEqual(ages.at(11), last);
    for (let index = 0; index < 12; index += 1) {
      const cohorts = ages.at(index);
      assert.equal(
        ages.bytes[index],
        cohorts.reduce((sum, cohort) => sum + cohort.bytes, 0),
        `revision ${index}`,
      );
    }

    const summary = summarizeInstructionAge(report);
    assert.equal(summary.first, 0);
    assert.equal(summary.kept, bytes(title, pnpm, keep, keep) / bytes(title, tests, pnpm, small, keep, keep));
    // 49 bytes from revision 0 and 42 from revision 1 fall short of half of 193; revision 2's 36 pass it.
    assert.equal(summary.median, 2);

    // Source text stays out of every export, and aliases leave the ages untouched.
    const shareable = redactReport(report);
    assert.deepEqual(
      shareable.revisions.map((revision) => revision.lineAge),
      changes,
    );
    for (const output of [JSON.stringify(report), renderHtml(report), JSON.stringify(shareable)]) {
      for (const line of [tests, pnpm, small, smallEdited, rule]) assert.equal(output.includes(line), false, line);
    }
    assert.match(renderHtml(report), /<h2>Instruction age<\/h2>/);

    const cli = spawnSync(
      process.execPath,
      ["dist/cli.js", "analyze", repo, "--output", join(repo, "r.json"), "--format", "json"],
      { encoding: "utf8" },
    );
    assert.equal(cli.status, 0, cli.stderr);
    assert.ok(
      cli.stdout.includes(
        `Instruction age: half of the latest instruction text was in place by revision 3 (${report.revisions[2].date.slice(0, 10)}); ${sharePercent(summary.kept)} of the text at the first revision with instructions (${report.revisions[0].date.slice(0, 10)}) is still present.`,
      ),
      cli.stdout,
    );

    // A tokenizer reads instruction text to count it, and the line ages come from that same read.
    const tokenized = await analyzeRepository(repo, { mode: "openai-o200k_base" });
    assert.deepEqual(
      tokenized.revisions.map((revision) => revision.lineAge),
      changes,
    );
    assertReadsEachBlobOnce(repo, git("rev-parse", "HEAD~11"), git("rev-parse", "HEAD"));
  } finally {
    cleanup();
  }
});

test("an imported file's text leaves and returns with its import", async () => {
  const { put, commit, repo, cleanup } = fixture("strata-survival-import-");
  const importLine = "@docs/guide.md";
  const guide = ["Guide line one.", "Guide line two."];
  try {
    put("CLAUDE.md", `${importLine}\nRoot line.\n`);
    put("docs/guide.md", `${guide.join("\n")}\n`);
    commit("import a guide");
    put("CLAUDE.md", "Root line.\n");
    commit("drop the import");
    put("CLAUDE.md", `${importLine}\nRoot line.\n`);
    commit("restore the import");
    const report = await analyzeRepository(repo);
    assertLineAgesMatchTrees(repo, report);
    assert.ok(report.components.some((component) => component.path === "docs/guide.md" && component.imported));
    assert.deepEqual(
      report.revisions.map((revision) => revision.lineAge),
      [
        { added: bytes(importLine, "Root line.", ...guide) },
        { added: 0, removed: [{ from: 0, bytes: bytes(importLine, ...guide) }] },
        { added: bytes(importLine, ...guide) },
      ],
    );
  } finally {
    cleanup();
  }
});

test("a merge adds its branch's lines at the merge, and a shallow clone starts its baseline at the boundary", async () => {
  const { git, put, commit, repo, cleanup } = fixture("strata-survival-merge-");
  const clone = mkdtempSync(join(tmpdir(), "strata-survival-shallow-"));
  try {
    put("CLAUDE.md", "Root line.\n");
    commit("root");
    git("checkout", "-q", "-b", "topic");
    put("CLAUDE.md", "Root line.\nBranch line.\n");
    commit("branch work");
    git("checkout", "-q", "main");
    put("README.md", "Readme.\n");
    commit("main work");
    git("merge", "-q", "--no-ff", "-m", "merge topic", "topic");
    const report = await analyzeRepository(repo);
    assertLineAgesMatchTrees(repo, report);
    assert.deepEqual(
      report.revisions.map((revision) => revision.lineAge),
      [{ added: bytes("Root line.") }, undefined, { added: bytes("Branch line.") }],
    );

    execFileSync("git", ["clone", "-q", "--depth", "2", `file://${repo}`, clone]);
    const shallow = await analyzeRepository(clone);
    assert.equal(shallow.shallow, true);
    assert.equal(shallow.revisions.length, 2);
    // The text before the boundary is all attributed to its first revision.
    assert.deepEqual(shallow.revisions[0].lineAge, { added: bytes("Root line.") });
    assertLineAgesMatchTrees(clone, shallow);
    assert.equal(summarizeInstructionAge(shallow).first, 0);
    // The command line says the text dated at the clone's first revision may be older.
    const cli = spawnSync(
      process.execPath,
      ["dist/cli.js", "analyze", clone, "--output", join(clone, "r.json"), "--format", "json"],
      { encoding: "utf8" },
    );
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(
      cli.stdout,
      /is still present\. This shallow clone starts at revision 1, so text dated there may be older\./,
    );
  } finally {
    cleanup();
    rmSync(clone, { recursive: true, force: true });
  }
});

test("a rename with an edit keeps the unchanged lines, and a source-only copy of a removed file is not instruction text", async () => {
  const { git, put, commit, repo, cleanup } = fixture("strata-survival-rename-");
  try {
    put("CLAUDE.md", "Kept line.\nOld line.\n");
    put(".claude/rules/style.md", "Rule line.\n");
    // The same blob at a skill resource path, which is source-only.
    put(".claude/skills/build/copy.txt", "Rule line.\n");
    commit("baseline");
    git("mv", "CLAUDE.md", "AGENTS.md");
    put("AGENTS.md", "Kept line.\nNew line.\n");
    commit("rename and edit");
    rmSync(join(repo, ".claude/rules/style.md"));
    commit("remove the rule, keep its copy");
    const report = await analyzeRepository(repo);
    assertLineAgesMatchTrees(repo, report);
    assert.deepEqual(
      report.revisions.map((revision) => revision.lineAge),
      [
        { added: bytes("Kept line.", "Old line.", "Rule line.") },
        { added: bytes("New line."), removed: [{ from: 0, bytes: bytes("Old line.") }] },
        { added: 0, removed: [{ from: 0, bytes: bytes("Rule line.") }] },
      ],
    );
    assert.deepEqual(instructionAges(report).at(2), [
      { from: 0, bytes: bytes("Kept line.") },
      { from: 1, bytes: bytes("New line.") },
    ]);
  } finally {
    cleanup();
  }
});

test("matches and weighs lines by their stored bytes, including text that is not valid UTF-8", async () => {
  const { put, commit, repo, cleanup } = fixture("strata-survival-bytes-");
  try {
    // Latin-1 é and è are each one invalid byte; decoded, both would become the same replacement character.
    put(
      "CLAUDE.md",
      Buffer.concat([Buffer.from("caf"), Buffer.from([0xe9]), Buffer.from("\n\u00a0D\u00e9j\u00e0 vu.\u00a0\n")]),
    );
    commit("latin-1 line and a padded UTF-8 line");
    put("CLAUDE.md", Buffer.concat([Buffer.from("caf"), Buffer.from([0xe8]), Buffer.from("\nD\u00e9j\u00e0 vu.\n")]));
    commit("another latin-1 line");
    const report = await analyzeRepository(repo);
    assert.notEqual(report.components[0].estimatedTokens, null);
    // No-break spaces are trimmed like any whitespace, and the line keeps its age.
    assert.deepEqual(
      report.revisions.map((revision) => revision.lineAge),
      [{ added: 4 + bytes("D\u00e9j\u00e0 vu.") }, { added: 4, removed: [{ from: 0, bytes: 4 }] }],
    );
  } finally {
    cleanup();
  }
});

test("reports no age for a history without instruction text", async () => {
  const { put, commit, repo, cleanup } = fixture("strata-survival-empty-");
  try {
    put(".claude/settings.json", "{}\n");
    put("CLAUDE.md", "\n  \n");
    commit("only settings and a blank file");
    const report = await analyzeRepository(repo);
    assert.equal(report.revisions[0].lineAge, undefined);
    assert.deepEqual(instructionAges(report).bytes, [0]);
    assert.deepEqual(instructionAges(report).at(0), []);
    assert.equal(summarizeInstructionAge(report), null);
  } finally {
    cleanup();
  }
});

test("groups text into the finest period that gives few layers, by the date as written", () => {
  const history = (dates, added = dates.map(() => 1)) => ({
    revisions: dates.map((date, index) => ({ date, ...(added[index] ? { lineAge: { added: added[index] } } : {}) })),
  });
  // Weeks start on Monday: Sunday 2026-10-18 is in the week of 2026-10-12.
  const weeks = instructionAgePeriods(
    history(["2026-10-12T09:00:00Z", "2026-10-18T09:00:00Z", "2026-10-19T09:00:00Z"]),
  );
  assert.equal(weeks.kind, "week");
  assert.deepEqual(
    weeks.periods.map((period) => period.label),
    ["Week of 2026-10-12", "Week of 2026-10-19"],
  );
  assert.deepEqual(
    [...weeks.periodOf],
    [
      [0, 0],
      [1, 0],
      [2, 1],
    ],
  );
  // A revision that added nothing has no period.
  const sparse = instructionAgePeriods(history(["2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"], [1, 0]));
  assert.deepEqual([...sparse.periodOf], [[0, 0]]);
  // The author's local date decides: late on March 31 in UTC-5 is March, not April. Eight weeks exceed three layers.
  const spread = Array.from(
    { length: 10 },
    (_, index) => `2026-0${(index % 3) + 1}-${String(index + 10)}T23:30:00-05:00`,
  );
  const local = instructionAgePeriods(history([...spread, "2026-03-31T23:30:00-05:00"]), 3);
  assert.equal(local.kind, "month");
  assert.deepEqual(
    local.periods.map((period) => period.key),
    ["2026-01", "2026-02", "2026-03"],
  );
  const months = Array.from({ length: 12 }, (_, month) => `2026-${String(month + 1).padStart(2, "0")}-15T12:00:00Z`);
  const quarters = instructionAgePeriods(history(months));
  assert.equal(quarters.kind, "quarter");
  assert.deepEqual(
    quarters.periods.map((period) => period.label),
    ["2026 Q1", "2026 Q2", "2026 Q3", "2026 Q4"],
  );
  // More than eight years keeps one layer per year.
  const yearly = instructionAgePeriods(
    history(Array.from({ length: 12 }, (_, index) => `${2010 + index}-06-01T12:00:00Z`)),
  );
  assert.equal(yearly.kind, "year");
  assert.equal(yearly.periods.length, 12);
});

test("shows shares as whole percentages that never round a part to 0% or 100%", () => {
  assert.deepEqual([0, 0.004, 0.5, 0.994, 0.996, 1].map(sharePercent), ["0%", "<1%", "50%", ">99%", ">99%", "100%"]);
});
