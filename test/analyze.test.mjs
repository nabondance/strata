import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { analyzeRepository, categories } from "../dist/analyze.js";
import { getEncoding } from "js-tiktoken";
import { createMeasurer } from "../dist/measurement.js";
import { compareGitCommits, renderPullRequestDelta } from "../dist/pr-delta.js";
import { compareRevisions } from "../dist/compare.js";
import { renderHtml } from "../dist/report.js";
import { redactReport } from "../dist/privacy.js";
import { layoutTreemap } from "../dist/treemap.js";
import { viewRevision } from "../dist/provider-view.js";

function exerciseReportUi(html, report) {
  let crampedLabels = false;
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
    getBoundingClientRect() {
      if (this.className === "treemap-leaf") return { bottom: 100, right: 180 };
      if (this.className === "leaf-name") return { bottom: 40 };
      if (this.className === "leaf-size") return crampedLabels ? { top: 42, bottom: 95, right: 165 } : { top: 60, bottom: 80, right: 150 };
      return { bottom: 0, right: 0 };
    }
    get scrollHeight() { return 20; }
    get clientHeight() { return 20; }
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
  const context = { document, Intl, getComputedStyle: () => ({ paddingBottom: "9", borderBottomWidth: "2", paddingRight: "9", borderRightWidth: "2" }) };
  runInNewContext(d3Script, context);
  runInNewContext(script, context);
  const get = (id) => elements.get(id);
  assert.equal(get("target").value, String(report.revisions.length - 1));
  assert.equal(get("skill-groups").children.length, Math.min(8, report.revisions.at(-1).skillGroups.length) || 1);
  if (report.revisions.at(-1).skillGroups.length > 8) {
    assert.equal(get("skill-toggle").hidden, false);
    assert.match(get("skill-toggle").textContent, /Show all/);
    get("skill-toggle").listeners.click();
    assert.equal(get("skill-groups").children.length, report.revisions.at(-1).skillGroups.length);
  }
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
  assert.equal(get("chart").children.length, Math.min(100, report.revisions.length));
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
  firstLeaf.listeners.mouseenter();
  assert.match(get("treemap-hover").textContent, /stored-text tokens/);
  firstLeaf.listeners.mouseleave();
  assert.match(get("treemap-hover").textContent, /Hover or focus/);
  firstLeaf.listeners.click();
  assert.equal(get("files").children.length, 1);
  assert.equal(get("files").children[0].scrolled, true);
  assert.equal(get("files").children[0].focused, true);
  assert.match(get("treemap-note").textContent, /source-only files/);
  const claudeTab = get("provider-tabs").children.find((child) => child.textContent === "Claude + shared");
  assert.ok(claudeTab);
  claudeTab.listeners.click();
  const claudeView = viewRevision(report.revisions[4], "claude", report.revisions[3]);
  assert.equal(get("tokens").textContent, new Intl.NumberFormat().format(claudeView.estimatedTokens));
  assert.equal(get("components").textContent, new Intl.NumberFormat().format(claudeView.components.length));
  assert.equal(get("files").children.length, claudeView.components.length);
  assert.equal(get("path-search").value, "");
  assert.match(get("view-note").textContent, /Shared files can appear in more than one provider view/);
  const codexTab = get("provider-tabs").children.find((child) => child.textContent === "Codex + shared");
  assert.ok(codexTab);
  codexTab.listeners.click();
  const codexView = viewRevision(report.revisions[4], "codex", report.revisions[3]);
  assert.equal(get("tokens").textContent, new Intl.NumberFormat().format(codexView.estimatedTokens));
  assert.equal(get("files").children.length, codexView.components.length);
  const allTab = get("provider-tabs").children.find((child) => child.textContent === "All files");
  allTab.listeners.click();
  assert.equal(get("tokens").textContent, new Intl.NumberFormat().format(report.revisions[4].estimatedTokens));
  crampedLabels = true;
  get("target").value = "4";
  get("target").listeners.change();
  const fittedLeaf = get("treemap").children.find((child) => child.className === "treemap-leaf" && child.children.length === 2);
  assert.ok(fittedLeaf);
  assert.equal(fittedLeaf.children[0].hidden, false);
  assert.equal(fittedLeaf.children[1].hidden, true);
  return get;
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
    assert.throws(() => analyzeRepository(repo), /no commits to analyze/);

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
    put(".claude/rules/empty.md", "");
    put(".claude/rules/odd\tname.md", "Handle unusual Git paths.\n");
    symlinkSync("missing.md", join(repo, ".claude/rules/linked.md"));
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
    const claudeView = viewRevision(report.revisions[0], "claude");
    const codexView = viewRevision(report.revisions[0], "codex");
    const sharedView = viewRevision(report.revisions[0], "shared");
    assert.ok(claudeView.components.every((component) => component.provider === "claude" || component.provider === "shared"));
    assert.ok(codexView.components.every((component) => component.provider === "codex" || component.provider === "shared"));
    assert.equal(sharedView.components.filter((component) => component.path === "AGENTS.md").length, 1);
    assert.ok(claudeView.components.some((component) => component.path === "AGENTS.md"));
    assert.ok(codexView.components.some((component) => component.path === "AGENTS.md"));
    assert.equal(report.revisions[0].components.filter((component) => component.path === "AGENTS.md").length, 1);
    assert.equal(report.revisions.length, 9);
    assert.equal(report.revisions[0].id, first);
    assert.equal(report.revisions.at(-1).id, merge);
    assert.equal(report.revisions.at(-1).firstParent, beforeMerge);
    const prDelta = compareGitCommits(repo, first, merge);
    assert.equal(prDelta.schemaVersion, 2);
    assert.deepEqual(prDelta.comparison, compareRevisions(report.revisions[0], report.revisions.at(-1)));
    const prMarkdown = renderPullRequestDelta(prDelta);
    assert.match(prMarkdown, /Strata configuration delta/);
    assert.ok(!prMarkdown.includes("Root instructions."));
    const hostileDelta = { ...prDelta, comparison: { ...prDelta.comparison,
      components: [{ ...prDelta.comparison.components[0], path: "<img src=x onerror=alert(1)>|bad" }] } };
    const safeMarkdown = renderPullRequestDelta(hostileDelta);
    assert.ok(!safeMarkdown.includes("<img"));
    assert.match(safeMarkdown, /&lt;img/);
    assert.match(safeMarkdown, /\\\|bad/);
    assert.throws(() => compareGitCommits(repo, "main", merge), /full Git commit IDs/);
    assert.equal(report.schemaVersion, 6);
    assert.equal(report.privacy.mode, "local");
    assert.equal(report.measurement.accuracy, "estimate");
    assert.equal(report.revisions[0].categoryTotals.settings.count, 2);
    assert.equal(report.revisions[0].categoryTotals.settings.sourceOnlyCount, 2);
    assert.equal(report.revisions[0].categoryTotals.settings.estimatedTokens, 0);
    assert.equal(report.revisions[0].categoryTotals.skills.count, 5);
    assert.equal(report.revisions[0].categoryTotals.skills.sourceOnlyCount, 4);
    assert.equal(report.revisions[0].categoryTotals.rules.sourceOnlyCount, 1);
    assert.equal(report.revisions[0].categoryTotals.agents.sourceOnlyCount, 1);
    assert.equal(report.revisions[0].components.find((component) => component.path === ".claude/rules/empty.md")?.estimatedTokens, 0);
    assert.ok(report.revisions[0].components.some((component) => component.path === ".claude/rules/odd\tname.md"));
    assert.ok(!report.revisions[0].components.some((component) => component.path === ".claude/rules/linked.md"));
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
    assert.equal(report.revisions.at(-1).categoryTotals.rules.count, 4);
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
    const manySkills = structuredClone(report);
    manySkills.revisions.at(-1).skillGroups = Array.from({ length: 12 }, (_, index) => ({
      ...report.revisions.at(-1).skillGroups[0], root: `.claude/skills/example-${index}`,
    }));
    exerciseReportUi(renderHtml(manySkills), manySkills);
    const longHistory = { ...report, revisions: Array.from({ length: 105 }, (_, index) => ({
      ...report.revisions[index % report.revisions.length], id: index.toString(16).padStart(40, "0"),
    })) };
    const longUi = exerciseReportUi(renderHtml(longHistory), longHistory);
    assert.equal(longUi("chart").children.length, 100);
    assert.match(longUi("timeline-note").textContent, /grouped into 100 bars/);
    assert.ok(!html.includes("Follow the project conventions."));
    const shareable = redactReport(report);
    const shareableJson = JSON.stringify(shareable);
    assert.deepEqual(redactReport(report), shareable);
    assert.equal(shareable.privacy.mode, "shareable");
    assert.equal(report.privacy.mode, "local");
    assert.match(shareable.revisions[0].components[0].path, /^file-\d{5}$/);
    for (const revision of report.revisions) {
      assert.ok(!shareableJson.includes(revision.id));
      for (const component of revision.components) {
        assert.ok(!shareableJson.includes(component.path));
        assert.ok(!shareableJson.includes(component.blob));
      }
    }
    assert.ok(!shareableJson.includes(report.repository));
    assert.equal(shareable.revisions.at(-1).estimatedTokens, report.revisions.at(-1).estimatedTokens);
    assert.equal(compareRevisions(shareable.revisions[0], shareable.revisions.at(-1)).deltaTokens,
      compareRevisions(report.revisions[0], report.revisions.at(-1)).deltaTokens);
    exerciseReportUi(renderHtml(shareable), shareable);
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
    const diffOutput = join(repo, "pr-delta.md");
    const diffCli = spawnSync(process.execPath, ["dist/cli.js", "diff", repo, "--base", first, "--head", merge, "--output", diffOutput], { encoding: "utf8" });
    assert.equal(diffCli.status, 0, diffCli.stderr);
    assert.match(readFileSync(diffOutput, "utf8"), /Strata configuration delta/);
    const openAiReport = analyzeRepository(repo, undefined, "openai-o200k_base");
    assert.equal(openAiReport.schemaVersion, 6);
    assert.deepEqual([openAiReport.measurement.family, openAiReport.measurement.accuracy, openAiReport.measurement.encoding, openAiReport.measurement.model, openAiReport.measurement.implementation],
      ["openai", "encoding-exact", "o200k_base", null, "js-tiktoken@1.0.21"]);
    const openAiInstruction = openAiReport.revisions[0].components.find((component) => component.path === "AGENTS.md");
    assert.equal(openAiInstruction?.estimatedTokens, getEncoding("o200k_base").encode("Shared project instructions.\n").length);
    assert.equal(openAiReport.revisions[0].components.find((component) => component.path === ".agents/skills/release/assets/icon.png")?.estimatedTokens, null);
    assert.notEqual(openAiReport.revisions[0].estimatedTokens, report.revisions[0].estimatedTokens);
    const openAiOutput = join(repo, "openai-report.json");
    const openAiCli = spawnSync(process.execPath, ["dist/cli.js", "analyze", repo, "--tokenizer", "openai-cl100k_base", "--output", openAiOutput, "--format", "json"], { encoding: "utf8" });
    assert.equal(openAiCli.status, 0, openAiCli.stderr);
    assert.equal(JSON.parse(readFileSync(openAiOutput, "utf8")).measurement.encoding, "cl100k_base");
    const modelOutput = join(repo, "model-report.json");
    const modelCli = spawnSync(process.execPath, ["dist/cli.js", "analyze", repo, "--model", "gpt-4o", "--output", modelOutput, "--format", "json"], { encoding: "utf8" });
    assert.equal(modelCli.status, 0, modelCli.stderr);
    const modelReport = JSON.parse(readFileSync(modelOutput, "utf8"));
    assert.deepEqual([modelReport.measurement.model, modelReport.measurement.encoding, modelReport.schemaVersion], ["gpt-4o", "o200k_base", 6]);
    assert.equal(modelReport.revisions[0].components.find((component) => component.path === "AGENTS.md")?.estimatedTokens,
      getEncoding("o200k_base").encode("Shared project instructions.\n").length);
    const badModel = spawnSync(process.execPath, ["dist/cli.js", "analyze", repo, "--model", "claude", "--format", "json"], { encoding: "utf8" });
    assert.equal(badModel.status, 2);
    assert.match(badModel.stderr, /Unsupported model/);
    const conflictingMode = spawnSync(process.execPath, ["dist/cli.js", "analyze", repo, "--model", "gpt-4o", "--tokenizer", "estimate"], { encoding: "utf8" });
    assert.equal(conflictingMode.status, 2);
    assert.match(conflictingMode.stderr, /either --model or --tokenizer/);
    const badTokenizer = spawnSync(process.execPath, ["dist/cli.js", "analyze", repo, "--tokenizer", "claude", "--format", "json"], { encoding: "utf8" });
    assert.equal(badTokenizer.status, 2);
    assert.match(badTokenizer.stderr, /--tokenizer must be/);
    assert.throws(() => createMeasurer("openai-o200k_base").count(Buffer.from([0xff])), /encoded data was not valid/);
    const shareableOutput = join(repo, "shareable.json");
    const shareableCli = spawnSync(process.execPath, ["dist/cli.js", "analyze", repo, "--shareable", "--output", shareableOutput, "--format", "json"], { encoding: "utf8" });
    assert.equal(shareableCli.status, 0, shareableCli.stderr);
    const cliSharedReport = JSON.parse(readFileSync(shareableOutput, "utf8"));
    assert.equal(cliSharedReport.privacy.mode, "shareable");
    assert.ok(!JSON.stringify(cliSharedReport).includes(merge));

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
    assert.equal(withEmpty.zeroTokenCount, treemap.zeroTokenCount + 1);
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
    git("checkout", "--detach");
    const detached = analyzeRepository(repo);
    assert.equal(detached.branch, "detached HEAD");
    assert.equal(detached.revisions.length, splitReport.revisions.length);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
