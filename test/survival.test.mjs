import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeRepository } from "../dist/analyze.js";
import { instructionAges, summarizeInstructionAge } from "../dist/instruction-age.js";
import { redactReport } from "../dist/privacy.js";
import { renderHtml } from "../dist/report.js";

test("dates instruction lines by the revision they appeared at and follows them across files", async () => {
  const repo = mkdtempSync(join(tmpdir(), "strata-survival-"));
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  const put = (path, content) => {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), content);
  };
  let day = 1;
  const commit = (message) => {
    git("add", "-A");
    const date = `2026-0${day < 10 ? 1 : 2}-${String(((day - 1) % 9) + 1).padStart(2, "0")}T12:00:00Z`;
    day += 1;
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", message], {
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
  };
  const bytes = (...lines) => lines.reduce((sum, line) => sum + Buffer.byteLength(line), 0);
  const title = "# Project";
  const tests = "Always run the full test suite before committing.";
  const pnpm = "Use pnpm, never npm.";
  const small = "Prefer small, focused pull requests.";
  const smallEdited = "Prefer small, focused pull requests!";
  const keep = "Keep this.";
  const frontmatter = ["---", "name: build", "description: Build steps.", "---"];
  const claude = (...lines) => put("CLAUDE.md", `${lines.join("\n")}\n\n`);
  try {
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Strata Test");
    git("config", "user.email", "strata-test@example.invalid");
    git("config", "core.autocrlf", "false");

    // 0: the baseline. Settings JSON is configuration, so its matching text is not an instruction line.
    claude(title, tests, pnpm, small, keep, keep);
    put(".claude/settings.json", JSON.stringify({ note: pnpm }));
    commit("baseline");
    // 1: a line moves into a skill, indented and with CRLF endings, and keeps its age.
    claude(title, tests, small, keep, keep);
    put(".claude/skills/build/SKILL.md", `${[...frontmatter, `  ${pnpm}`].join("\r\n")}\r\n`);
    commit("move a line into a skill");
    // 2: a near-identical edit is a removal and an addition.
    claude(title, tests, smallEdited, keep, keep);
    commit("edit a line");
    // 3: a third copy of a duplicated line is new; 4: removing one copy drops the newest.
    put(".claude/skills/build/SKILL.md", `${[...frontmatter, pnpm, keep].join("\n")}\n`);
    commit("duplicate a line");
    claude(title, tests, smallEdited, keep);
    commit("remove one copy");
    // 5: a deletion, then 6: its revert, which brings the line back as new.
    claude(title, smallEdited, keep);
    commit("delete a line");
    git("revert", "--no-edit", "HEAD");
    // 7: an unrecognized file, 8: a rename, 9: settings. None moves an instruction line.
    put("README.md", "Readme.\n");
    commit("readme");
    git("mv", "CLAUDE.md", "AGENTS.md");
    commit("rename");
    put(".claude/settings.json", JSON.stringify({ note: "Something else entirely." }));
    commit("settings");

    const report = await analyzeRepository(repo);
    assert.equal(report.schemaVersion, 19);
    assert.equal(report.lineAgeMethod, "exact-trimmed-line-multiset-utf8-bytes-v1");
    assert.equal(report.revisions.length, 10);
    const changes = report.revisions.map((revision) => revision.lineAge);
    assert.deepEqual(changes[0], { added: bytes(title, tests, pnpm, small, keep, keep) });
    assert.deepEqual(changes[1], { added: bytes(...frontmatter) });
    assert.deepEqual(changes[2], { added: bytes(smallEdited), removed: [{ from: 0, bytes: bytes(small) }] });
    assert.deepEqual(changes[3], { added: bytes(keep) });
    assert.deepEqual(changes[4], { added: 0, removed: [{ from: 3, bytes: bytes(keep) }] });
    assert.deepEqual(changes[5], { added: 0, removed: [{ from: 0, bytes: bytes(tests) }] });
    assert.deepEqual(changes[6], { added: bytes(tests) });
    assert.deepEqual(changes.slice(7), [undefined, undefined, undefined]);
    // The rename and settings revisions changed files without moving a line.
    assert.ok(report.revisions[8].changes.length && report.revisions[9].changes.length);

    const ages = instructionAges(report);
    const last = {
      bytes: bytes(title, pnpm, keep, keep, ...frontmatter, smallEdited, tests),
      cohorts: [
        { from: 0, bytes: bytes(title, pnpm, keep, keep) },
        { from: 1, bytes: bytes(...frontmatter) },
        { from: 2, bytes: bytes(smallEdited) },
        { from: 6, bytes: bytes(tests) },
      ],
    };
    assert.deepEqual(ages.at(-1), last);
    assert.equal(ages[7], ages[6], "revisions that move no line share the previous age");
    assert.equal(ages[3].cohorts.find((cohort) => cohort.from === 3)?.bytes, bytes(keep));
    assert.equal(
      ages[4].cohorts.find((cohort) => cohort.from === 3),
      undefined,
    );
    // Every revision's total is the bytes of the instruction lines in its tree.
    for (const [index, age] of ages.entries()) {
      assert.equal(
        age.bytes,
        age.cohorts.reduce((sum, cohort) => sum + cohort.bytes, 0),
        `revision ${index}`,
      );
    }

    const summary = summarizeInstructionAge(report);
    assert.equal(summary.kept, bytes(title, pnpm, keep, keep) / bytes(title, tests, pnpm, small, keep, keep));
    // 49 bytes from revision 0 and 42 from revision 1 pass half of 176.
    assert.equal(summary.medianDate, report.revisions[1].date);

    // Source text stays out of every export, and aliases leave the ages untouched.
    const shareable = redactReport(report);
    assert.deepEqual(
      shareable.revisions.map((revision) => revision.lineAge),
      changes,
    );
    for (const output of [JSON.stringify(report), renderHtml(report), JSON.stringify(shareable)]) {
      for (const line of [tests, pnpm, small, smallEdited]) assert.equal(output.includes(line), false, line);
    }
    assert.match(renderHtml(report), /<h2>Instruction age<\/h2>/);

    const cli = spawnSync(
      process.execPath,
      ["dist/cli.js", "analyze", repo, "--output", join(repo, "r.json"), "--format", "json"],
      {
        encoding: "utf8",
      },
    );
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(
      cli.stdout,
      new RegExp(
        `Instruction age: half of the latest instruction text dates from ${summary.medianDate.slice(0, 10)} or earlier; ${Math.round(summary.kept * 100)}% of the text at the first revision with instructions`,
      ),
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("reports no age for a history without instruction text", async () => {
  const repo = mkdtempSync(join(tmpdir(), "strata-survival-empty-"));
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  try {
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Strata Test");
    git("config", "user.email", "strata-test@example.invalid");
    mkdirSync(join(repo, ".claude"));
    writeFileSync(join(repo, ".claude/settings.json"), "{}\n");
    writeFileSync(join(repo, "CLAUDE.md"), "\n  \n");
    git("add", "-A");
    git("commit", "-q", "-m", "only settings and a blank file");
    const report = await analyzeRepository(repo);
    assert.equal(report.revisions[0].lineAge, undefined);
    assert.deepEqual(instructionAges(report), [{ bytes: 0, cohorts: [] }]);
    assert.equal(summarizeInstructionAge(report), null);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
