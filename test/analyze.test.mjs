import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeRepository, categories } from "../dist/analyze.js";
import { renderHtml } from "../dist/report.js";

test("tracks configuration across first-parent history without reading untracked files", () => {
  const repo = mkdtempSync(join(tmpdir(), "strata-history-"));
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  const put = (path, content) => {
    const fullPath = join(repo, path);
    mkdirSync(join(fullPath, ".."), { recursive: true });
    writeFileSync(fullPath, content);
  };
  const commit = (message) => {
    git("add", "-A");
    git("commit", "-m", message);
    return git("rev-parse", "HEAD");
  };

  try {
    git("init", "-b", "main");
    git("config", "user.name", "Strata Test");
    git("config", "user.email", "strata-test@example.invalid");

    put("CLAUDE.md", "Root instructions.\n");
    put(".claude/CLAUDE.md", "Claude-specific project instructions.\n");
    put("AGENTS.md", "Shared project instructions.\n");
    put("packages/app/AGENTS.override.md", "Codex override for this package.\n");
    put(".agents/skills/release/SKILL.md", "---\nname: release\ndescription: Prepare a release\n---\nCheck the changelog.\n");
    put(".agents/skills/release/references/checklist.md", "Supporting checklist.\n");
    put(".codex/config.toml", "model = \"gpt-6-sol\"\n");
    put(".codex/agents/reviewer.toml", "name = \"reviewer\"\ndeveloper_instructions = \"Review the diff.\"\n");
    put(".codex/rules/permissions.rules", "prefix_rule(pattern = [\"git\", \"status\"], decision = \"allow\")\n");
    put("notes/SKILL.md", "Unrelated Markdown.\n");
    put(".claude/settings.json", '{"hooks":{}}\n');
    const first = commit("Initial configuration");

    put(".claude/skills/review/SKILL.md", "Review this project carefully.\n");
    put(".claude/agents/reviewer.md", "You review code. Follow project conventions. Be precise and concise.\n");
    commit("Add skill and agent");

    put("CLAUDE.md", "Root instructions.\nFollow the project conventions.\n");
    commit("Grow root instructions");

    put("CLAUDE.md", "Root.\n");
    commit("Reduce root instructions");

    git("mv", ".claude/skills/review", ".claude/skills/code-review");
    commit("Rename skill");

    git("mv", ".claude/agents/reviewer.md", ".claude/agents/code-reviewer.md");
    put(".claude/agents/code-reviewer.md", "You review code. Follow project conventions. Be precise and concise. Flag regressions.\n");
    commit("Rename and edit agent");

    rmSync(join(repo, ".claude/agents/code-reviewer.md"));
    commit("Remove agent");

    git("checkout", "-b", "feature");
    put(".claude/rules/testing.md", "Test behavior, not implementation.\n");
    commit("Add rule on feature branch");

    git("checkout", "main");
    put(".claude/commands/hello.md", "Say hello.\n");
    const beforeMerge = commit("Add command on main");
    git("merge", "--no-ff", "feature", "-m", "Merge configuration rule");
    const merge = git("rev-parse", "HEAD");

    put(".claude/skills/untracked/SKILL.md", "This is not in Git.\n");
    const report = analyzeRepository(repo);
    assert.equal(report.revisions.length, 9);
    assert.equal(report.revisions[0].id, first);
    assert.equal(report.revisions.at(-1).id, merge);
    assert.equal(report.revisions.at(-1).firstParent, beforeMerge);
    assert.equal(report.schemaVersion, 2);
    assert.equal(report.revisions[0].categoryTotals.settings.count, 2);
    assert.equal(report.revisions[0].categoryTotals.settings.sourceOnlyCount, 2);
    assert.equal(report.revisions[0].categoryTotals.settings.estimatedTokens, 0);
    assert.equal(report.revisions[0].categoryTotals.other.count, 1);
    assert.equal(report.revisions[0].categoryTotals.other.sourceOnlyCount, 1);
    assert.equal(report.revisions[0].categoryTotals.rules.sourceOnlyCount, 1);
    assert.equal(report.revisions[0].categoryTotals.agents.sourceOnlyCount, 1);
    assert.equal(report.revisions[0].components.find((component) => component.path === ".agents/skills/release/SKILL.md")?.provider, "codex");
    assert.equal(report.revisions[0].components.find((component) => component.path === ".agents/skills/release/references/checklist.md")?.provider, "unknown");
    assert.equal(report.revisions[0].components.find((component) => component.path === "packages/app/AGENTS.override.md")?.provider, "codex");
    assert.ok(!report.revisions[0].components.some((component) => component.path === "notes/SKILL.md"));
    assert.equal(report.revisions[1].categoryTotals.skills.count, 2);
    assert.ok(report.revisions[2].estimatedTokens > report.revisions[1].estimatedTokens);
    assert.ok(report.revisions[3].estimatedTokens < report.revisions[2].estimatedTokens);
    assert.ok(report.revisions[4].changes.some((change) =>
      change.kind === "renamed" && change.previousPath === ".claude/skills/review/SKILL.md" && change.path === ".claude/skills/code-review/SKILL.md"));
    assert.ok(report.revisions[5].changes.some((change) =>
      change.kind === "renamed" && change.previousPath === ".claude/agents/reviewer.md" && change.path === ".claude/agents/code-reviewer.md"));
    assert.ok(report.revisions[6].changes.some((change) =>
      change.kind === "removed" && change.path === ".claude/agents/code-reviewer.md"));
    assert.equal(report.revisions.at(-1).categoryTotals.rules.count, 2);
    assert.equal(report.revisions.at(-1).categoryTotals.commands.count, 1);
    assert.ok(!report.revisions.at(-1).components.some((component) => component.path.includes("untracked")));
    for (const revision of report.revisions) {
      assert.equal(revision.estimatedTokens, categories.reduce((sum, category) =>
        sum + revision.categoryTotals[category].estimatedTokens, 0));
      for (const category of categories) {
        const components = revision.components.filter((component) => component.category === category);
        assert.equal(revision.categoryTotals[category].sourceOnlyCount,
          components.filter((component) => component.estimatedTokens === null).length);
      }
    }
    const html = renderHtml(report);
    assert.ok(!html.includes("Follow the project conventions."));
    const hostileName = "<img onerror=alert(1)>.md";
    report.revisions[0].components[0].path = hostileName;
    assert.ok(!renderHtml(report).includes(hostileName));

    const output = join(repo, "strata-report.json");
    const cli = spawnSync(process.execPath, ["dist/cli.js", "analyze", repo, "--output", output, "--format", "json"], { encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stderr, /Analyzing 9 revisions/);
    assert.match(cli.stderr, /Processed 9\/9 revisions/);
    const cliReport = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(cliReport.revisions.length, 9);
    assert.equal(cliReport.revisions.at(-1).id, merge);

    const shallow = mkdtempSync(join(tmpdir(), "strata-shallow-"));
    try {
      execFileSync("git", ["clone", "--quiet", "--depth", "1", `file://${repo}`, shallow]);
      const shallowReport = analyzeRepository(shallow);
      assert.equal(shallowReport.shallow, true);
      assert.equal(shallowReport.revisions.length, 1);
    } finally {
      rmSync(shallow, { recursive: true, force: true });
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
