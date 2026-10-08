import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { analyzeRepository, categories } from "../dist/analyze.js";
import { compareRevisions } from "../dist/compare.js";
import { renderHtml } from "../dist/report.js";
import { layoutTreemap } from "../dist/treemap.js";

function exerciseReportUi(html, report) {
  class Element {
    constructor(tag) {
      this.tag = tag;
      this.children = [];
      this.style = {};
      this.listeners = {};
      this.classList = { add() {}, toggle() {} };
    }
    append(...children) { this.children.push(...children); }
    prepend(...children) { this.children.unshift(...children); }
    replaceChildren(...children) { this.children = children; }
    addEventListener(event, listener) { this.listeners[event] = listener; }
    setAttribute() {}
    focus() { this.focused = true; }
    scrollIntoView() { this.scrolled = true; }
  }
  const elements = new Map();
  const document = {
    createElement: (tag) => new Element(tag),
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, new Element(id));
      return elements.get(id);
    },
  };
  const d3Script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  const script = html.match(/<script>\n([\s\S]*?)\n  <\/script>/)?.[1];
  assert.ok(d3Script);
  assert.ok(script);
  assert.match(html, /Permission to use, copy, modify, and\/or distribute this software/);
  assert.match(html, /d3-hierarchy\/ v3\.1\.2/);
  const context = { document, Intl };
  runInNewContext(d3Script, context);
  runInNewContext(script, context);
  const get = (id) => elements.get(id);
  assert.equal(get("target").value, String(report.revisions.length - 1));
  assert.equal(get("skill-groups").children.length, report.revisions.at(-1).skillGroups.length || 1);
  assert.equal(get("baseline").value, "0");
  assert.equal(get("compare-components").children.length, compareRevisions(report.revisions[0], report.revisions.at(-1)).components.length);
  get("baseline").value = "2";
  get("baseline").listeners.change();
  get("target").value = "3";
  get("target").listeners.change();
  assert.equal(get("skill-groups").children.length, report.revisions[3].skillGroups.length);
  const expected = compareRevisions(report.revisions[2], report.revisions[3]);
  assert.match(get("compare-tokens").textContent, new RegExp(String(expected.deltaTokens)));
  assert.equal(get("compare-components").children.length, expected.components.length);
  assert.equal(get("slider").value, 3);
  get("provider-filter").value = "claude";
  get("provider-filter").listeners.change();
  const claudeFiles = report.revisions[3].components.filter((component) => component.provider === "claude").length;
  assert.equal(get("files").children.length, claudeFiles);
  get("target").value = "4";
  get("target").listeners.change();
  assert.equal(get("provider-filter").value, "claude");
  assert.equal(get("files").children.length, report.revisions[4].components.filter((component) => component.provider === "claude").length);
  const fullTokens = get("tokens").textContent;
  get("path-search").value = "does-not-exist";
  get("path-search").listeners.input();
  assert.equal(get("files").children.length, 1);
  assert.equal(get("files").children[0].children[0].textContent, "No files match these filters.");
  assert.match(get("inventory-count").textContent, /Showing 0 of/);
  assert.equal(get("tokens").textContent, fullTokens);
  get("clear-filters").listeners.click();
  assert.equal(get("files").children.length, report.revisions[4].components.length);
  assert.equal(get("provider-filter").value, "");
  assert.equal(get("path-search").value, "");
  assert.equal(get("path-search").focused, true);
  const firstLeaf = get("treemap").children.find((child) => child.className === "treemap-leaf");
  assert.ok(firstLeaf);
  firstLeaf.listeners.click();
  assert.equal(get("files").children.length, 1);
  assert.equal(get("files").children[0].scrolled, true);
  assert.equal(get("files").children[0].focused, true);
  assert.match(get("treemap-note").textContent, /source-only files/);
}

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
    put(".agents/skills/release/scripts/run.sh", "#!/bin/sh\nprintf 'ready\\n'\n");
    put(".agents/skills/release/assets/icon.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    put(".claude/skills/orphan/references/note.md", "No manifest yet.\n");
    put(".codex/config.toml", "model = \"gpt-6-sol\"\n");
    put(".codex/agents/reviewer.toml", "name = \"reviewer\"\ndeveloper_instructions = \"Review the diff.\"\n");
    put(".codex/rules/permissions.rules", "prefix_rule(pattern = [\"git\", \"status\"], decision = \"allow\")\n");
    put("notes/SKILL.md", "Unrelated Markdown.\n");
    put(".claude/settings.json", '{"hooks":{}}\n');
    const first = commit("Initial configuration");

    put(".claude/skills/review/SKILL.md", "Review this project carefully.\n");
    put(".claude/skills/review/references/example.md", "Example review checklist.\n");
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
    assert.equal(report.schemaVersion, 3);
    assert.equal(report.revisions[0].categoryTotals.settings.count, 2);
    assert.equal(report.revisions[0].categoryTotals.settings.sourceOnlyCount, 2);
    assert.equal(report.revisions[0].categoryTotals.settings.estimatedTokens, 0);
    assert.equal(report.revisions[0].categoryTotals.skills.count, 5);
    assert.equal(report.revisions[0].categoryTotals.skills.sourceOnlyCount, 4);
    assert.equal(report.revisions[0].categoryTotals.rules.sourceOnlyCount, 1);
    assert.equal(report.revisions[0].categoryTotals.agents.sourceOnlyCount, 1);
    assert.equal(report.revisions[0].components.find((component) => component.path === ".agents/skills/release/SKILL.md")?.provider, "codex");
    const checklist = report.revisions[0].components.find((component) => component.path === ".agents/skills/release/references/checklist.md");
    assert.equal(checklist?.provider, "codex");
    assert.equal(checklist?.category, "skills");
    assert.equal(checklist?.estimatedTokens, null);
    assert.deepEqual(checklist?.skill, { root: ".agents/skills/release", role: "resource" });
    const releaseResources = report.revisions[0].components.filter((component) => component.skill?.root === ".agents/skills/release" && component.skill.role === "resource");
    assert.equal(releaseResources.find((component) => component.path.endsWith("icon.png"))?.bytes, 4);
    assert.deepEqual(report.revisions[0].skillGroups, [{
      root: ".agents/skills/release", provider: "codex", manifestPath: ".agents/skills/release/SKILL.md",
      manifestEstimatedTokens: report.revisions[0].components.find((component) => component.path === ".agents/skills/release/SKILL.md")?.estimatedTokens,
      resourceCount: 3, resourceBytes: releaseResources.reduce((sum, component) => sum + component.bytes, 0),
    }, {
      root: ".claude/skills/orphan", provider: "claude", manifestPath: null,
      manifestEstimatedTokens: 0, resourceCount: 1, resourceBytes: Buffer.byteLength("No manifest yet.\n"),
    }]);
    assert.equal(report.revisions[0].components.find((component) => component.path === "packages/app/AGENTS.override.md")?.provider, "codex");
    assert.ok(!report.revisions[0].components.some((component) => component.path === "notes/SKILL.md"));
    assert.equal(report.revisions[1].categoryTotals.skills.count, 7);
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
      assert.equal(revision.skillGroups.reduce((sum, group) => sum + group.manifestEstimatedTokens, 0),
        revision.components.filter((component) => component.skill?.role === "manifest").reduce((sum, component) => sum + (component.estimatedTokens ?? 0), 0));
      assert.equal(revision.skillGroups.reduce((sum, group) => sum + group.resourceCount, 0),
        revision.components.filter((component) => component.skill?.role === "resource").length);
    }
    const html = renderHtml(report);
    exerciseReportUi(html, report);
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

    const renamedComparison = compareRevisions(report.revisions[3], report.revisions[4]);
    assert.equal(renamedComparison.deltaFiles, 0);
    assert.equal(renamedComparison.deltaTokens, 0);
    assert.ok(renamedComparison.components.some((component) => component.kind === "removed" && component.path === ".claude/skills/review/SKILL.md"));
    assert.ok(renamedComparison.components.some((component) => component.kind === "added" && component.path === ".claude/skills/code-review/SKILL.md"));
    const identicalComparison = compareRevisions(report.revisions[4], report.revisions[4]);
    assert.deepEqual(identicalComparison.components, []);
    assert.equal(identicalComparison.deltaTokens, 0);
    const reverseComparison = compareRevisions(report.revisions[2], report.revisions[0]);
    assert.ok(reverseComparison.deltaTokens < 0);
    assert.equal(reverseComparison.deltaTokens, report.revisions[0].estimatedTokens - report.revisions[2].estimatedTokens);

    const defaultCli = spawnSync(process.execPath, ["dist/cli.js", "analyze", repo], { encoding: "utf8" });
    assert.equal(defaultCli.status, 0, defaultCli.stderr);
    const defaultPath = defaultCli.stdout.match(/^Report: (.+)$/m)?.[1];
    assert.ok(defaultPath);
    assert.ok(defaultPath.startsWith(tmpdir()));
    assert.match(readFileSync(defaultPath, "utf8"), /<html/);
    assert.equal(statSync(defaultPath).mode & 0o777, 0o600);
    rmSync(join(defaultPath, ".."), { recursive: true, force: true });

    const skill = spawnSync(process.execPath, ["dist/cli.js", "skill"], { encoding: "utf8" });
    assert.equal(skill.status, 0, skill.stderr);
    assert.match(skill.stdout, /^---\nname: strata-interpret\n/);
    const skillPath = join(repo, "installed-skill", "SKILL.md");
    const installedSkill = spawnSync(process.execPath, ["dist/cli.js", "skill", "--output", skillPath], { encoding: "utf8" });
    assert.equal(installedSkill.status, 0, installedSkill.stderr);
    assert.equal(readFileSync(skillPath, "utf8"), skill.stdout);
    assert.equal(statSync(skillPath).mode & 0o777, 0o600);
    const duplicateSkill = spawnSync(process.execPath, ["dist/cli.js", "skill", "--output", skillPath], { encoding: "utf8" });
    assert.equal(duplicateSkill.status, 2);

    const badOpen = spawnSync(process.execPath, ["dist/cli.js", "analyze", repo, "--format", "json", "--open"], { encoding: "utf8" });
    assert.equal(badOpen.status, 2);
    assert.match(badOpen.stderr, /--open requires HTML output/);
    if (process.platform !== "win32") {
      const openDir = mkdtempSync(join(tmpdir(), "strata-open-"));
      try {
        const opener = join(openDir, process.platform === "darwin" ? "open" : "xdg-open");
        const openLog = join(openDir, "opened-url");
        writeFileSync(opener, '#!/bin/sh\nprintf "%s" "$1" > "$STRATA_OPEN_LOG"\n');
        chmodSync(opener, 0o700);
        const opened = spawnSync(process.execPath, ["dist/cli.js", "analyze", repo, "--open"], {
          encoding: "utf8", env: { ...process.env, PATH: `${openDir}:${process.env.PATH}`, STRATA_OPEN_LOG: openLog },
        });
        assert.equal(opened.status, 0, opened.stderr);
        const openedPath = opened.stdout.match(/^Report: (.+)$/m)?.[1];
        assert.ok(openedPath);
        assert.equal(readFileSync(openLog, "utf8"), pathToFileURL(openedPath).href);
        rmSync(join(openedPath, ".."), { recursive: true, force: true });
      } finally {
        rmSync(openDir, { recursive: true, force: true });
      }
    }

    put("CLAUDE.md", "Root.\nFollow project conventions and review every change.\n");
    commit("Grow root guidance before split");
    put("CLAUDE.md", "Root.\n");
    put(".claude/skills/project-review/SKILL.md", "---\nname: project-review\ndescription: Review project changes\n---\nFollow project conventions and review every change.\n");
    commit("Split guidance into a skill");
    const splitReport = analyzeRepository(repo);
    const beforeSplit = splitReport.revisions.at(-2);
    const afterSplit = splitReport.revisions.at(-1);
    const split = compareRevisions(beforeSplit, afterSplit);
    const treemap = layoutTreemap(afterSplit.components);
    assert.equal(treemap.totalTokens, afterSplit.estimatedTokens);
    assert.equal(treemap.sourceOnlyCount, afterSplit.components.filter((component) => component.estimatedTokens === null).length);
    const leaves = treemap.groups.flatMap((group) => group.leaves);
    assert.ok(leaves.length > 0);
    for (const leaf of leaves) {
      assert.ok(Math.abs(leaf.width * leaf.height / 10000 - leaf.estimatedTokens / treemap.totalTokens) < 1e-9);
    }
    assert.ok(Math.abs(treemap.groups.reduce((sum, group) => sum + group.width * group.height, 0) - 10000) < 1e-8);
    const withEmpty = layoutTreemap([...afterSplit.components, { path: "empty.md", provider: "shared", category: "instructions", blob: "empty", bytes: 0, estimatedTokens: 0 }]);
    assert.equal(withEmpty.zeroTokenCount, 1);
    assert.equal(withEmpty.totalTokens, treemap.totalTokens);
    assert.equal(splitReport.revisions.length, 11);
    assert.equal(split.deltaFiles, 1);
    assert.ok(split.byCategory.find((item) => item.key === "instructions")?.deltaTokens < 0);
    assert.ok(split.byCategory.find((item) => item.key === "skills")?.deltaTokens > 0);
    assert.ok(split.components.some((component) => component.kind === "edited" && component.path === "CLAUDE.md"));
    assert.ok(split.components.some((component) => component.kind === "added" && component.path === ".claude/skills/project-review/SKILL.md"));
    assert.equal(split.byProvider.reduce((sum, item) => sum + item.deltaTokens, 0), split.deltaTokens);
    assert.equal(split.byCategory.reduce((sum, item) => sum + item.deltaFiles, 0), split.deltaFiles);
    const reverseSplit = compareRevisions(afterSplit, beforeSplit);
    assert.equal(reverseSplit.deltaTokens, -split.deltaTokens);
    assert.equal(reverseSplit.deltaFiles, -split.deltaFiles);

    const blank = { ...beforeSplit, components: [], estimatedTokens: 0 };
    const fromBlank = compareRevisions(blank, afterSplit);
    assert.equal(fromBlank.percentChange, null);
    assert.ok(fromBlank.components.some((component) => component.path === ".claude/settings.json" && component.beforeTokens === null && component.afterTokens === null));

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
