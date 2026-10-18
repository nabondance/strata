import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { analyzeRepository } from "../dist/analyze.js";
import { expandRevisions } from "../dist/expand.js";
import { compareGitCommits, renderPullRequestDelta } from "../dist/pr-delta.js";
import { redactReport } from "../dist/privacy.js";
import { viewRevision } from "../dist/provider-view.js";
import { renderHtml } from "../dist/report.js";
import { ruleUpFront } from "../dist/rule-loading.js";
import { upFrontContext } from "../dist/up-front.js";

test("reads from rule frontmatter whether a root rule loads at launch", () => {
  const claude = (text) => ruleUpFront(text, "claude");
  const cursor = (text) => ruleUpFront(text, "cursor");

  // Claude Code loads a rule without `paths` at launch; a `paths` string or list scopes it.
  assert.equal(claude("Always.\n"), "listed");
  assert.equal(claude("---\ndescription: ignored\n---\nAlways.\n"), "listed");
  assert.equal(claude('---\npaths: "src/**/*.ts"\n---\n'), null);
  assert.equal(claude("---\npaths: src/**/*.ts, test/**\n---\n"), null);
  assert.equal(claude('---\npaths: ["src/**", "test/**"]  # both\n---\n'), null);
  assert.equal(claude('---\npaths:\n  - "src/**"\n  # tests too\n  - test/**\n---\n'), null);
  // Frontmatter Strata cannot read, or a `paths` value that is empty or not a list, is unresolved.
  assert.equal(claude("---\npaths: [unclosed\n---\n"), "unresolved");
  assert.equal(claude("---\npaths: []\n---\n"), "unresolved");
  assert.equal(claude("---\npaths:\n---\n"), "unresolved");
  assert.equal(claude("---\npaths:\n  src: yes\n---\n"), "unresolved");
  assert.equal(claude("---\npaths: src\n"), "unresolved");

  // Cursor applies a rule to every chat only with `alwaysApply: true`.
  assert.equal(cursor("---\nalwaysApply: true\n---\n"), "listed");
  assert.equal(cursor("---\nglobs: src/**\nalwaysApply: false\n---\n"), null);
  assert.equal(cursor("---\ndescription: When asked about tests\n---\n"), null);
  assert.equal(cursor("No frontmatter.\n"), null);
  assert.equal(cursor("---\nalwaysApply: sometimes\n---\n"), "unresolved");
  assert.equal(cursor("---\nalwaysApply: [true]\n---\n"), "unresolved");
});

test("separates what each agent lists up front from what it reads on demand", async () => {
  const repo = mkdtempSync(join(tmpdir(), "strata-up-front-"));
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  const put = (path, content) => {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), content);
  };
  const commit = (message) => {
    git("add", "-A");
    git("commit", "-m", message);
    return git("rev-parse", "HEAD");
  };
  const estimate = (text) => Math.ceil(Buffer.byteLength(text) / 4);
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Strata Test");
    git("config", "user.email", "strata-test@example.invalid");
    const body = "Steps that load only when the skill runs.\n".repeat(20);
    put("CLAUDE.md", "Root instructions.\n@docs/guide.md\n");
    put("docs/guide.md", "Guide imported at launch.\n");
    put("AGENTS.md", "Shared agent instructions.\n");
    put(".claude/rules/always.md", "A rule with no paths.\n");
    put(".claude/rules/scoped.md", '---\npaths:\n  - "src/**"\n---\nScoped rule.\n');
    put(".claude/rules/broken.md", "---\npaths: [unclosed\n---\nUnreadable rule.\n");
    put("pkg/CLAUDE.md", "Nested instructions.\n");
    put("pkg/.claude/rules/nested.md", "A nested rule.\n");
    put(".claude/skills/review/SKILL.md", `---\nname: review\ndescription: Review a diff\n---\n${body}`);
    put(".claude/commands/ship.md", "Ship it.\n");
    put(".claude/agents/helper.md", "A helper agent.\n");
    put("REVIEW.md", "Review guidance.\n");
    const first = commit("Claude and Codex");
    git("rm", "-q", "CLAUDE.md");
    put("AGENTS.md", "Shared agent instructions.\n@docs/guide.md\n");
    put("AGENTS.override.md", "Codex override.\n");
    commit("AGENTS.md only, with a Codex override");
    put("AGENTS.override.md", "");
    commit("Empty the override");
    put(".cursor/rules/always.mdc", "---\nalwaysApply: true\n---\nCursor always.\n");
    put(".cursor/rules/globbed.mdc", "---\nglobs: src/**\nalwaysApply: false\n---\nGlobbed.\n");
    put(".cursorrules", "Legacy rules.\n");
    put("GEMINI.md", "Gemini root.\n");
    put("pkg/GEMINI.md", "Gemini nested.\n");
    put(".gemini/system.md", "System prompt override.\n");
    put(".github/copilot-instructions.md", "Copilot root.\n");
    put(".github/instructions/ts.instructions.md", "---\napplyTo: '**/*.ts'\n---\nTypeScript.\n");
    const last = commit("Cursor, Gemini CLI, and Copilot");

    const report = await analyzeRepository(repo);
    const label = (path) => report.components.filter((component) => component.path === path).map((c) => c.upFront);
    assert.deepEqual(label("CLAUDE.md"), ["listed"]);
    assert.deepEqual(label(".claude/rules/always.md"), ["listed"]);
    assert.deepEqual(label(".claude/rules/scoped.md"), [undefined]);
    assert.deepEqual(label(".claude/rules/broken.md"), ["unresolved"]);
    assert.deepEqual(label("pkg/CLAUDE.md"), [undefined]);
    assert.deepEqual(label("pkg/.claude/rules/nested.md"), [undefined]);
    assert.deepEqual(label("REVIEW.md"), [undefined]);
    assert.deepEqual(label("docs/guide.md"), [undefined]);
    assert.deepEqual(label(".cursorrules"), ["unresolved"]);
    assert.deepEqual(label(".cursor/rules/always.mdc"), ["listed"]);
    assert.deepEqual(label(".cursor/rules/globbed.mdc"), [undefined]);
    assert.deepEqual(label(".gemini/system.md"), [undefined]);

    const revisions = expandRevisions(report);
    const at = (index, provider) =>
      upFrontContext(revisions[index].components, provider, revisions[index].geminiContextFiles);
    const paths = (context) => context.files.map((component) => component.path).sort();
    const listing = estimate("review\nReview a diff");

    // With a root CLAUDE.md, Claude Code reads it, what it imports, and rules without paths, not AGENTS.md.
    const claude = at(0, "claude");
    assert.deepEqual(paths(claude), [".claude/rules/always.md", "CLAUDE.md", "docs/guide.md"]);
    assert.equal(claude.listingTokens, listing);
    assert.equal(
      claude.fileTokens,
      claude.files.reduce((sum, component) => sum + component.estimatedTokens, 0),
    );
    assert.equal(claude.tokens, claude.fileTokens + listing);
    assert.equal(claude.unresolved, 1);
    // Up-front files and on-demand files partition what the Claude view counts.
    const claudeView = viewRevision(revisions[0], "claude");
    // AGENTS.md is skipped beside CLAUDE.md, so it is in neither figure; the three add up to the view.
    assert.equal(claude.skipped, 1);
    assert.equal(claude.skippedTokens, estimate("Shared agent instructions.\n"));
    assert.equal(claude.fileTokens + claude.onDemandTokens + claude.skippedTokens, claudeView.estimatedTokens);
    assert.ok(claude.onDemandTokens > estimate(body));
    assert.deepEqual(paths(at(0, "codex")), ["AGENTS.md"]);
    assert.equal(at(0, "codex").listingTokens, 0);
    for (const provider of ["copilot", "cursor", "gemini"]) assert.equal(at(0, provider).files.length, 0);

    // Without a root Claude file, Claude Code reads AGENTS.md and expands its imports; a nested CLAUDE.md does not count.
    assert.deepEqual(paths(at(1, "claude")), [".claude/rules/always.md", "AGENTS.md", "docs/guide.md"]);
    // Codex reads a non-empty override instead of AGENTS.md, and AGENTS.md again once the override is empty.
    assert.deepEqual(paths(at(1, "codex")), ["AGENTS.override.md"]);
    assert.equal(at(1, "codex").skipped, 1);
    assert.equal(at(1, "claude").skipped, 0);
    assert.deepEqual(paths(at(2, "codex")), ["AGENTS.md", "AGENTS.override.md"]);
    assert.equal(at(2, "codex").fileTokens, estimate("Shared agent instructions.\n@docs/guide.md\n"));

    const cursor = at(3, "cursor");
    assert.deepEqual(paths(cursor), [".cursor/rules/always.mdc", "AGENTS.md"]);
    assert.equal(cursor.unresolved, 1);
    assert.equal(cursor.listingTokens, listing);
    assert.deepEqual(paths(at(3, "gemini")), ["GEMINI.md"]);
    // Copilot reads Claude's rules with its own rules, so they are on demand for it and not unresolved.
    const copilot = at(3, "copilot");
    assert.deepEqual(paths(copilot), [".github/copilot-instructions.md", "AGENTS.md", "GEMINI.md"]);
    assert.equal(copilot.unresolved, 0);
    assert.equal(copilot.listingTokens, listing);

    // Labels, not paths, decide, so a shareable report gives the same totals.
    const shareable = expandRevisions(redactReport(report)).at(-1);
    for (const provider of ["claude", "codex", "copilot", "cursor", "gemini"]) {
      const { files, ...totals } = upFrontContext(shareable.components, provider, shareable.geminiContextFiles);
      const { files: localFiles, ...local } = at(3, provider);
      assert.deepEqual(totals, local);
      assert.equal(files.length, localFiles.length);
    }

    const html = renderHtml(report);
    assert.match(html, /<h2>At session start<\/h2>/);
    assert.match(html, /const upFrontContext = function upFrontContext\(/);
    assert.doesNotMatch(html, /Root instructions\.|Guide imported/);

    const delta = compareGitCommits(repo, first, last);
    const entry = (provider) => delta.upFront.find((item) => item.provider === provider);
    assert.deepEqual(
      delta.upFront.map(({ provider }) => provider),
      ["claude", "codex", "copilot", "cursor", "gemini"],
    );
    assert.equal(entry("claude").before.tokens, claude.tokens);
    assert.equal(entry("claude").after.tokens, at(3, "claude").tokens);
    assert.equal(entry("cursor").before.tokens, 0);
    assert.equal(entry("cursor").after.unresolved, 1);
    assert.equal(entry("codex").deltaTokens, at(3, "codex").tokens - at(0, "codex").tokens);
    const markdown = renderPullRequestDelta(delta);
    assert.match(markdown, /\| Agent \| Up front \| Δ up front \| On demand \| Δ on demand \|/);
    assert.match(markdown, new RegExp(`\\| Cursor \\| 0 → ${cursor.tokens} \\| \\+${cursor.tokens} \\|`));
    assert.match(
      markdown,
      /Not counted up front because Strata could not tell whether they load: Claude Code 1 → 1, Cursor 0 → 1/,
    );
    assert.match(renderPullRequestDelta(compareGitCommits(repo, last, last)), /billing tokens: unchanged\./);

    const cli = spawnSync(
      process.execPath,
      [resolve("dist/cli.js"), "analyze", repo, "--format", "json", "--output", "-"],
      {
        encoding: "utf8",
      },
    );
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(
      cli.stderr,
      new RegExp(
        `Up front: Claude Code ${at(3, "claude").tokens} tokens, ${at(3, "claude").onDemandTokens} more on demand; Codex `,
      ),
    );
    assert.match(cli.stderr, /2 rules whose loading Strata could not tell are counted on demand\./);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("follows Claude imports up front and skips AGENTS.md beside any root Claude file", async () => {
  const repo = mkdtempSync(join(tmpdir(), "strata-up-front-imports-"));
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  const put = (path, content) => {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), content);
  };
  const commit = (message) => {
    git("add", "-A");
    git("commit", "-m", message);
  };
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Strata Test");
    git("config", "user.email", "strata-test@example.invalid");
    put("AGENTS.md", "Shared.\n");
    put("CLAUDE.local.md", "Personal notes.\n");
    commit("A local Claude file alone");
    git("rm", "-q", "CLAUDE.local.md");
    put(".claude/CLAUDE.md", "@../AGENTS.md\n@../GEMINI.md\n");
    put("GEMINI.md", "Gemini context.\n");
    commit("Import AGENTS.md and GEMINI.md");

    const revisions = expandRevisions(await analyzeRepository(repo));
    const at = (index) => upFrontContext(revisions[index].components, "claude", revisions[index].geminiContextFiles);
    const paths = (context) => context.files.map((component) => component.path).sort();
    // CLAUDE.local.md counts as a root Claude file, so AGENTS.md is skipped.
    assert.deepEqual(paths(at(0)), ["CLAUDE.local.md"]);
    assert.equal(at(0).skipped, 1);
    // An imported AGENTS.md is up front through the import; so is GEMINI.md, which Claude does not otherwise read.
    assert.deepEqual(paths(at(1)), [".claude/CLAUDE.md", "AGENTS.md", "GEMINI.md"]);
    assert.equal(at(1).skipped, 0);
    assert.equal(at(1).onDemandTokens, 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
