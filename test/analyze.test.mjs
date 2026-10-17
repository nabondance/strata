import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { getEncoding } from "js-tiktoken";
import { analyzeRepository, categories } from "../dist/analyze.js";
import { compareRevisions } from "../dist/compare.js";
import { expandRevisions } from "../dist/expand.js";
import { createMeasurer } from "../dist/measurement.js";
import { compareGitCommits, renderPullRequestDelta } from "../dist/pr-delta.js";
import { redactReport } from "../dist/privacy.js";
import { viewRevision } from "../dist/provider-view.js";
import { renderHtml } from "../dist/report.js";
import { renderSvg } from "../dist/svg.js";
import { timelineBuckets } from "../dist/timeline.js";
import { layoutTreemap } from "../dist/treemap.js";

/** Run the report's script against a minimal fake DOM and return its elements by ID. */
function loadReportUi(html) {
  const layout = { crampedLabels: false };
  class Element {
    constructor(tag) {
      this.tag = tag;
      this.children = [];
      this.style = {};
      this.listeners = {};
      this.classes = new Set();
      this.classList = {
        add: (name) => this.classes.add(name),
        remove: (name) => this.classes.delete(name),
        toggle() {},
      };
    }
    append(...children) {
      this.children.push(...children);
    }
    prepend(...children) {
      this.children.unshift(...children);
    }
    replaceChildren(...children) {
      this.children = children;
    }
    addEventListener(event, listener) {
      this.listeners[event] = listener;
    }
    setAttribute() {}
    focus() {
      this.focused = true;
    }
    scrollIntoView() {
      this.scrolled = true;
    }
    getBoundingClientRect() {
      if (this.className === "treemap-leaf") return { bottom: 100, right: 180 };
      if (this.className === "leaf-name") return { bottom: 40 };
      if (this.className === "leaf-size")
        return layout.crampedLabels ? { top: 42, bottom: 95, right: 165 } : { top: 60, bottom: 80, right: 150 };
      return { bottom: 0, right: 0 };
    }
    get scrollHeight() {
      return 20;
    }
    get clientHeight() {
      return 20;
    }
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
  const script = html.match(/<script>\n([\s\S]*?)\n {2}<\/script>/)?.[1];
  assert.ok(d3Script);
  assert.ok(script);
  assert.match(html, /Permission to use, copy, modify, and\/or distribute this software/);
  assert.match(html, /d3-hierarchy\/ v3\.1\.2/);
  const timers = new Map();
  const context = {
    document,
    Intl,
    setTimeout: (run) => {
      timers.set(timers.size + 1, run);
      return timers.size;
    },
    clearTimeout: (id) => timers.delete(id),
    getComputedStyle: () => ({ paddingBottom: "9", borderBottomWidth: "2", paddingRight: "9", borderRightWidth: "2" }),
  };
  runInNewContext(d3Script, context);
  runInNewContext(script, context);
  return { get: (id) => elements.get(id), timers, layout };
}

function exerciseReportUi(html, report) {
  const revisions = expandRevisions(report);
  const { get, timers, layout } = loadReportUi(html);
  // The masthead silhouette has a layer for each category holding tokens; the legend also lists source-only ones.
  const tokenCategories = Object.values(revisions.at(-1).categoryTotals).filter((total) => total.estimatedTokens > 0);
  assert.ok(get("silhouette").children.length >= tokenCategories.length);
  assert.ok(get("silhouette").children.length <= get("legend").children.length);
  assert.equal(get("repo").textContent, report.repository);
  // Long lists start with their first rows; the rest of this exercise runs with them expanded.
  assert.equal(get("files").children.length, Math.min(25, revisions.at(-1).components.length) || 1);
  assert.equal(get("files-more").hidden, revisions.at(-1).components.length <= 25);
  for (const id of ["files", "compare-components"]) get(`${id}-more`).onclick();
  assert.equal(get("files").children.length, revisions.at(-1).components.length || 1);
  assert.equal(get("target").value, String(revisions.length - 1));
  assert.equal(get("skill-groups").children.length, Math.min(8, revisions.at(-1).skillGroups.length) || 1);
  if (revisions.at(-1).skillGroups.length > 8) {
    assert.equal(get("skill-toggle").hidden, false);
    assert.match(get("skill-toggle").textContent, /Show all/);
    get("skill-toggle").listeners.click();
    assert.equal(get("skill-groups").children.length, revisions.at(-1).skillGroups.length);
  }
  // The comparison starts against the previous revision, so it lists what the selected revision changed.
  assert.equal(get("baseline").value, "previous");
  assert.equal(
    get("compare-components").children.length,
    compareRevisions(revisions.at(-2) ?? { components: [], estimatedTokens: 0 }, revisions.at(-1)).components.length ||
      1,
  );
  // The legend carries the selected revision's figure for each category, and the two long panels start closed.
  assert.ok(get("legend").children.every((entry) => entry.children.at(-1).tag === "b"));
  assert.equal(get("skills-panel").hidden, !revisions.at(-1).skillGroups.length);
  assert.notEqual(get("files-panel")?.open, true);
  get("baseline").value = "2";
  get("baseline").listeners.change();
  get("target").value = "3";
  get("target").listeners.change();
  assert.equal(get("skill-groups").children.length, revisions[3].skillGroups.length);
  const expected = compareRevisions(revisions[2], revisions[3]);
  assert.match(get("compare-tokens").textContent, new RegExp(String(expected.deltaTokens)));
  assert.equal(get("compare-components").children.length, expected.components.length);
  // Providers and categories that did not move are left out of the comparison.
  assert.equal(
    get("compare-categories").children.length,
    expected.byCategory.filter((group) => group.deltaFiles || group.deltaTokens).length || 1,
  );
  assert.equal(get("slider").value, 3);
  // Rectangles of files this revision added or edited are outlined; removed and source-only files have none.
  const sized = revisions[3].changes.filter(
    (change) => change.component !== null && report.components[change.component].estimatedTokens > 0,
  );
  const outlined = get("treemap").children.filter((child) => child.classes.has("changed"));
  assert.equal(outlined.length, sized.length);
  assert.equal(
    outlined.filter((child) => child.classes.has("edited")).length,
    sized.filter((change) => change.kind !== "added").length,
  );
  if (sized.length) {
    outlined[0].listeners.focus();
    assert.match(get("treemap-hover").textContent, / at this revision/);
    assert.match(get("treemap-hover").textContent, / at this revision/);
  }
  const chartStart = Math.max(
    0,
    revisions.findIndex((revision) => revision.components.length),
  );
  assert.equal(get("chart").children.length, Math.min(100, revisions.length - chartStart));
  assert.equal(get("slider").min, chartStart);
  get("provider-filter").value = "claude";
  get("provider-filter").listeners.change();
  const claudeFiles = revisions[3].components.filter((component) => component.provider === "claude").length;
  assert.equal(get("files").children.length, claudeFiles);
  get("target").value = "4";
  get("target").listeners.change();
  assert.equal(get("provider-filter").value, "claude");
  assert.equal(
    get("files").children.length,
    revisions[4].components.filter((component) => component.provider === "claude").length,
  );
  const fullTokens = get("tokens").textContent;
  get("path-search").value = "does-not-exist";
  get("path-search").listeners.input();
  assert.equal(get("files").children.length, 1);
  assert.equal(get("files").children[0].children[0].textContent, "No files match these filters.");
  assert.match(get("inventory-count").textContent, /Showing 0 of/);
  assert.equal(get("tokens").textContent, fullTokens);
  get("clear-filters").listeners.click();
  assert.equal(get("files").children.length, revisions[4].components.length);
  assert.equal(get("provider-filter").value, "");
  assert.equal(get("path-search").value, "");
  assert.equal(get("path-search").focused, true);
  const firstLeaf = get("treemap").children.find((child) => child.className === "treemap-leaf");
  assert.ok(firstLeaf);
  assert.equal(firstLeaf.title, undefined);
  assert.match(firstLeaf.style.color, /^#(ffffff|10140f)$/);
  firstLeaf.listeners.mouseenter();
  assert.match(get("treemap-hover").textContent, /stored-text tokens/);
  firstLeaf.listeners.mouseleave();
  assert.match(get("treemap-hover").textContent, /source-only/);
  firstLeaf.listeners.click();
  // The path filter is a substring search, so CLAUDE.md also lists .claude/CLAUDE.md.
  assert.equal(get("files-panel").open, true);
  const located = get("files").children.filter((row) => row.scrolled);
  assert.equal(located.length, 1);
  assert.equal(located[0].focused, true);
  assert.ok(get("files").children.length <= 2);
  assert.match(get("treemap-hover").textContent, /source-only/);
  // A provider tab opens on that provider's own counts when the report has them; the switch returns to the estimate.
  const openOnEstimate = (provider) => {
    const measured = report.providerMeasurements?.find(
      (entry) => entry.provider === provider && entry.accuracy !== "estimate",
    );
    assert.equal(get("measure-switch").hidden, !measured);
    if (!measured) return;
    assert.equal(
      get("tokens").textContent,
      new Intl.NumberFormat().format(report.revisions[4].providerTokenTotals[provider] ?? 0),
    );
    assert.match(get("tokens-label").textContent, new RegExp(`^${provider[0].toUpperCase()}${provider.slice(1)} `));
    assert.ok(get("counting-rows").children.some((row) => row.title.includes(measured.model)));
    get("measure-switch")
      .children.find((child) => child.textContent === "Byte estimate")
      .listeners.click();
    assert.match(get("tokens-label").textContent, /^(Estimated|Encoding) tokens$/);
  };
  const claudeTab = get("provider-tabs").children.find((child) => child.textContent === "Claude + shared");
  assert.ok(claudeTab);
  claudeTab.listeners.click();
  openOnEstimate("claude");
  const claudeView = viewRevision(revisions[4], "claude", revisions[3]);
  assert.equal(get("tokens").textContent, new Intl.NumberFormat().format(claudeView.estimatedTokens));
  assert.equal(get("components").textContent, new Intl.NumberFormat().format(claudeView.components.length));
  assert.equal(get("files").children.length, claudeView.components.length);
  assert.equal(get("path-search").value, "");
  assert.match(get("view-note").textContent, /Shared files can appear in more than one provider view/);
  const codexTab = get("provider-tabs").children.find((child) => child.textContent === "Codex + shared");
  assert.ok(codexTab);
  codexTab.listeners.click();
  openOnEstimate("codex");
  const codexView = viewRevision(revisions[4], "codex", revisions[3]);
  assert.equal(get("tokens").textContent, new Intl.NumberFormat().format(codexView.estimatedTokens));
  assert.equal(get("files").children.length, codexView.components.length);
  const geminiTab = get("provider-tabs").children.find((child) => child.textContent === "Gemini + shared");
  assert.ok(geminiTab);
  geminiTab.listeners.click();
  openOnEstimate("gemini");
  const geminiView = viewRevision(revisions[4], "gemini", revisions[3]);
  assert.equal(get("tokens").textContent, new Intl.NumberFormat().format(geminiView.estimatedTokens));
  assert.equal(get("files").children.length, geminiView.components.length);
  const allTab = get("provider-tabs").children.find((child) => child.textContent === "All files");
  allTab.listeners.click();
  assert.equal(get("tokens").textContent, new Intl.NumberFormat().format(revisions[4].estimatedTokens));
  // Dragging the slider updates the summary at once and the file table once it settles.
  assert.notEqual(revisions[2].components, revisions[4].components);
  get("slider").value = "2";
  get("slider").listeners.input();
  assert.equal(get("tokens").textContent, new Intl.NumberFormat().format(revisions[2].estimatedTokens));
  assert.equal(get("files").children.length, revisions[4].components.length);
  const comparedRows = get("compare-components").children.length;
  assert.equal(timers.size, 1);
  for (const run of timers.values()) run();
  assert.equal(get("files").children.length, revisions[2].components.length);
  assert.equal(
    get("compare-components").children.length,
    compareRevisions(revisions[2], revisions[2]).components.length || 1,
  );
  assert.notEqual(get("compare-components").children.length, comparedRows);
  get("slider").value = "3";
  get("slider").listeners.input();
  get("slider").listeners.change();
  assert.equal(get("files").children.length, revisions[3].components.length);
  layout.crampedLabels = true;
  get("target").value = "4";
  get("target").listeners.change();
  const fittedLeaf = get("treemap").children.find(
    (child) => child.className === "treemap-leaf" && child.children.length === 2,
  );
  assert.ok(fittedLeaf);
  assert.equal(fittedLeaf.children[0].hidden, false);
  assert.equal(fittedLeaf.children[1].hidden, true);
  return get;
}

test("tracks configuration across first-parent history without reading untracked files", async () => {
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
    await assert.rejects(analyzeRepository(repo), /no commits to analyze/);

    put("CLAUDE.md", "Root instructions.\n");
    put("GEMINI.md", "Gemini project instructions.\n");
    put(".claude/CLAUDE.md", "Claude-specific project instructions.\n");
    put("AGENTS.md", "Shared project instructions.\n");
    put("packages/app/GEMINI.md", "Nested Gemini instructions.\n");
    put("packages/app/AGENTS.override.md", "Codex override for this package.\n");
    put(
      ".agents/skills/release/SKILL.md",
      "---\nname: release\ndescription: Prepare a release\n---\nCheck the changelog.\n",
    );
    put(".agents/skills/release/references/checklist.md", "Supporting checklist.\n");
    put(".agents/skills/release/scripts/run.sh", "#!/bin/sh\nprintf 'ready\\n'\n");
    put(".agents/skills/release/assets/icon.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    put(".claude/skills/orphan/references/note.md", "No manifest yet.\n");
    put(".codex/config.toml", 'model = "gpt-6-sol"\n');
    put(".codex/agents/reviewer.toml", 'name = "reviewer"\ndeveloper_instructions = "Review the diff."\n');
    put(".codex/rules/permissions.rules", 'prefix_rule(pattern = ["git", "status"], decision = "allow")\n');
    put(".gemini/settings.json", '{"context":{"fileName":"GEMINI.md"}}\n');
    put(
      ".gemini/agents/reviewer.md",
      "---\nname: reviewer\ndescription: Review changes\n---\nReview the diff carefully.\n",
    );
    put(".gemini/commands/review.toml", 'prompt = "Review this change"\n');
    put(".gemini/system.md", "Replace the default system prompt.\n");
    put(
      ".gemini/skills/release/SKILL.md",
      "---\nname: release\ndescription: Release safely\n---\nVerify the package.\n",
    );
    put(".gemini/skills/release/references/checklist.md", "Release checklist.\n");
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
    put(
      ".claude/agents/code-reviewer.md",
      "You review code. Follow project conventions. Be precise and concise. Flag regressions.\n",
    );
    commit("Rename and edit agent");

    rmSync(join(repo, ".claude/agents/code-reviewer.md"));
    rmSync(join(repo, ".gemini/agents/reviewer.md"));
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
    const report = await analyzeRepository(repo);
    const revisions = expandRevisions(report);
    const providerRequests = [];
    const providerApiReport = await analyzeRepository(repo, {
      providerCounts: {
        claudeModel: "claude-test-model",
        geminiModel: "gemini-test-model",
        codexModel: "gpt-4o",
        anthropicApiKey: "anthropic-test-key",
        geminiApiKey: "gemini-test-key",
        fetchImpl: async (url, init) => {
          const body = JSON.parse(init.body);
          providerRequests.push({ url, headers: init.headers, body });
          return new Response(JSON.stringify(url.includes("anthropic") ? { input_tokens: 7 } : { totalTokens: 9 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      },
    });
    assert.equal(providerApiReport.schemaVersion, 13);
    assert.equal(providerApiReport.measurement.accuracy, "estimate");
    assert.deepEqual(
      providerApiReport.providerMeasurements.map(({ provider, model, accuracy }) => [provider, model, accuracy]),
      [
        ["claude", "claude-test-model", "api-counted"],
        ["gemini", "gemini-test-model", "api-counted"],
        ["codex", "gpt-4o", "encoding-exact"],
      ],
    );
    const providerApiRevisions = expandRevisions(providerApiReport);
    const sharedMeasured = providerApiRevisions[0].components.find((component) => component.path === "AGENTS.md");
    assert.equal(sharedMeasured.providerTokenCounts.claude.tokens, 7);
    // The fixture's Gemini settings keep the default context file, so Gemini does not read AGENTS.md.
    assert.equal(sharedMeasured.providerTokenCounts.gemini, undefined);
    const sharedSkill = providerApiRevisions[0].components.find(
      (component) => component.path === ".agents/skills/release/SKILL.md",
    );
    assert.deepEqual(Object.keys(sharedSkill.providerTokenCounts), ["gemini", "codex"]);
    assert.equal(
      sharedMeasured.providerTokenCounts.codex.tokens,
      getEncoding("o200k_base").encode("Shared project instructions.\n").length,
    );
    assert.equal(providerApiRevisions[0].components.filter((component) => component.path === "AGENTS.md").length, 1);
    assert.equal(
      providerApiRevisions[0].providerTokenTotals.claude,
      providerApiRevisions[0].components.reduce(
        (sum, component) => sum + (component.providerTokenCounts?.claude?.tokens ?? 0),
        0,
      ),
    );
    const sharedRequests = providerRequests.filter(({ body }) =>
      JSON.stringify(body).includes("Shared project instructions."),
    );
    assert.equal(sharedRequests.length, 1);
    assert.ok(sharedRequests.some(({ url }) => url.includes("anthropic.com")));
    assert.ok(providerRequests.some(({ body }) => JSON.stringify(body).includes("Root instructions.")));
    assert.ok(!providerRequests.some(({ body }) => JSON.stringify(body).includes("settings.json")));
    const providerJson = JSON.stringify(providerApiReport);
    assert.ok(!providerJson.includes("anthropic-test-key"));
    assert.ok(!providerJson.includes("gemini-test-key"));
    assert.ok(!providerJson.includes("Shared project instructions."));
    assert.match(
      renderHtml(providerApiReport),
      /Text sent to: api\.anthropic\.com \(Claude\), generativelanguage\.googleapis\.com \(Gemini\)/,
    );
    // The per-provider columns are the point of this mode, so their table starts open.
    assert.match(renderHtml(providerApiReport), /<details class="panel" id="files-panel" open>/);
    assert.match(renderHtml(report), /<details class="panel" id="files-panel">/);
    const providerApiUi = exerciseReportUi(renderHtml(providerApiReport), providerApiReport);
    assert.equal(providerApiUi("files").children[0].children.length, 8);
    const sharedRow = providerApiUi("files").children.find((row) => row.children[0].textContent === "AGENTS.md");
    assert.equal(sharedRow.children[5].textContent, "7");
    assert.equal(sharedRow.children[6].textContent, "—");
    assert.ok(
      providerApiUi("files").children.some((row) =>
        row.children.some((cell) => cell.title?.includes("claude-test-model")),
      ),
    );
    const claudeView = viewRevision(revisions[0], "claude");
    const codexView = viewRevision(revisions[0], "codex");
    const geminiView = viewRevision(revisions[0], "gemini");
    const sharedView = viewRevision(revisions[0], "shared");
    assert.ok(
      claudeView.components.every((component) => component.provider === "claude" || component.provider === "shared"),
    );
    assert.ok(
      codexView.components.every((component) => component.provider === "codex" || component.provider === "shared"),
    );
    assert.equal(sharedView.components.filter((component) => component.path === "AGENTS.md").length, 1);
    assert.equal(geminiView.components.filter((component) => component.path === "AGENTS.md").length, 0);
    assert.ok(geminiView.components.some((component) => component.path === ".agents/skills/release/SKILL.md"));
    assert.ok(codexView.components.some((component) => component.path === ".agents/skills/release/SKILL.md"));
    assert.ok(!claudeView.components.some((component) => component.path.startsWith(".agents/")));
    assert.ok(geminiView.components.some((component) => component.path === "GEMINI.md"));
    assert.ok(geminiView.components.some((component) => component.path === "packages/app/GEMINI.md"));
    assert.ok(claudeView.components.some((component) => component.path === "AGENTS.md"));
    assert.ok(codexView.components.some((component) => component.path === "AGENTS.md"));
    assert.equal(revisions[0].components.filter((component) => component.path === "AGENTS.md").length, 1);
    assert.equal(revisions.length, 9);
    assert.equal(revisions[0].id, first);
    assert.equal(revisions.at(-1).id, merge);
    assert.equal(revisions.at(-1).firstParent, beforeMerge);
    const prDelta = compareGitCommits(repo, first, merge);
    assert.equal(prDelta.schemaVersion, 6);
    assert.deepEqual(prDelta.comparison, compareRevisions(revisions[0], revisions.at(-1)));
    const prMarkdown = renderPullRequestDelta(prDelta);
    assert.match(prMarkdown, /Strata configuration delta/);
    assert.ok(!prMarkdown.includes("Root instructions."));
    const hostileDelta = {
      ...prDelta,
      comparison: {
        ...prDelta.comparison,
        components: [{ ...prDelta.comparison.components[0], path: "<img src=x onerror=alert(1)>|bad" }],
      },
    };
    const safeMarkdown = renderPullRequestDelta(hostileDelta);
    assert.ok(!safeMarkdown.includes("<img"));
    assert.match(safeMarkdown, /&lt;img/);
    assert.match(safeMarkdown, /\\\|bad/);
    assert.throws(() => compareGitCommits(repo, "main", merge), /full Git commit IDs/);
    assert.equal(report.schemaVersion, 13);
    // Each distinct file version is stored once, in path order; revisions carry changes, not inventories.
    assert.equal(
      new Set(report.components.map((component) => `${component.path}\0${component.blob}`)).size,
      report.components.length,
    );
    assert.deepEqual(
      report.components.map((component) => component.path),
      report.components.map((component) => component.path).sort(new Intl.Collator().compare),
    );
    assert.equal(report.components.filter((component) => component.path === "CLAUDE.md").length, 3);
    assert.ok(report.components.length < revisions.reduce((sum, revision) => sum + revision.components.length, 0) / 4);
    for (const revision of report.revisions) {
      assert.ok(!("components" in revision) && !("skillGroups" in revision));
      for (const change of revision.changes) {
        assert.equal(change.component === null, change.kind === "removed");
        if (change.component !== null) assert.equal(report.components[change.component].path, change.path);
      }
    }
    assert.deepEqual(expandRevisions(JSON.parse(JSON.stringify(report))), revisions);
    assert.equal(report.privacy.mode, "local");
    assert.equal(report.measurement.accuracy, "estimate");
    assert.equal(revisions[0].categoryTotals.settings.count, 3);
    assert.equal(revisions[0].categoryTotals.settings.sourceOnlyCount, 3);
    assert.equal(revisions[0].categoryTotals.settings.estimatedTokens, 0);
    assert.equal(revisions[0].categoryTotals.skills.count, 7);
    assert.equal(revisions[0].categoryTotals.skills.sourceOnlyCount, 5);
    assert.equal(revisions[0].categoryTotals.rules.sourceOnlyCount, 1);
    assert.equal(revisions[0].categoryTotals.agents.sourceOnlyCount, 1);
    assert.equal(
      revisions[0].components.find((component) => component.path === ".gemini/settings.json")?.estimatedTokens,
      null,
    );
    assert.equal(
      revisions[0].components.find((component) => component.path === ".gemini/commands/review.toml")?.estimatedTokens,
      null,
    );
    assert.equal(
      revisions[0].components.find((component) => component.path === ".gemini/agents/reviewer.md")?.provider,
      "gemini",
    );
    assert.equal(
      revisions[0].components.find((component) => component.path === ".gemini/system.md")?.category,
      "instructions",
    );
    const geminiSkill = revisions[0].components.find(
      (component) => component.path === ".gemini/skills/release/references/checklist.md",
    );
    assert.equal(geminiSkill?.provider, "gemini");
    assert.equal(geminiSkill?.estimatedTokens, null);
    assert.equal(
      revisions[0].components.find((component) => component.path === ".claude/rules/empty.md")?.estimatedTokens,
      0,
    );
    assert.ok(revisions[0].components.some((component) => component.path === ".claude/rules/odd\tname.md"));
    assert.ok(!revisions[0].components.some((component) => component.path === ".claude/rules/linked.md"));
    assert.equal(
      revisions[0].components.find((component) => component.path === ".agents/skills/release/SKILL.md")?.provider,
      "shared",
    );
    const checklist = revisions[0].components.find(
      (component) => component.path === ".agents/skills/release/references/checklist.md",
    );
    assert.equal(checklist?.provider, "shared");
    assert.deepEqual(checklist?.readers, ["codex", "gemini"]);
    assert.equal(checklist?.category, "skills");
    assert.equal(checklist?.estimatedTokens, null);
    assert.deepEqual(checklist?.skill, { root: ".agents/skills/release", role: "resource" });
    const releaseResources = revisions[0].components.filter(
      (component) => component.skill?.root === ".agents/skills/release" && component.skill.role === "resource",
    );
    assert.equal(releaseResources.find((component) => component.path.endsWith("icon.png"))?.bytes, 4);
    assert.deepEqual(revisions[0].skillGroups, [
      {
        root: ".agents/skills/release",
        provider: "shared",
        readers: ["codex", "gemini"],
        manifestPath: ".agents/skills/release/SKILL.md",
        manifestEstimatedTokens: revisions[0].components.find(
          (component) => component.path === ".agents/skills/release/SKILL.md",
        )?.estimatedTokens,
        listing: { status: "listed", tokens: Math.ceil(Buffer.byteLength("release\nPrepare a release") / 4) },
        resourceCount: 3,
        resourceBytes: releaseResources.reduce((sum, component) => sum + component.bytes, 0),
      },
      {
        root: ".claude/skills/orphan",
        provider: "claude",
        manifestPath: null,
        manifestEstimatedTokens: 0,
        listing: null,
        resourceCount: 1,
        resourceBytes: Buffer.byteLength("No manifest yet.\n"),
      },
      {
        root: ".gemini/skills/release",
        provider: "gemini",
        manifestPath: ".gemini/skills/release/SKILL.md",
        manifestEstimatedTokens: revisions[0].components.find(
          (component) => component.path === ".gemini/skills/release/SKILL.md",
        )?.estimatedTokens,
        listing: { status: "listed", tokens: Math.ceil(Buffer.byteLength("release\nRelease safely") / 4) },
        resourceCount: 1,
        resourceBytes: Buffer.byteLength("Release checklist.\n"),
      },
    ]);
    assert.equal(
      revisions[0].components.find((component) => component.path === "packages/app/AGENTS.override.md")?.provider,
      "codex",
    );
    assert.ok(!revisions[0].components.some((component) => component.path === "notes/SKILL.md"));
    assert.equal(revisions[1].categoryTotals.skills.count, 9);
    assert.ok(revisions[2].estimatedTokens > revisions[1].estimatedTokens);
    assert.ok(revisions[3].estimatedTokens < revisions[2].estimatedTokens);
    assert.ok(
      revisions[4].changes.some(
        (change) =>
          change.kind === "renamed" &&
          change.previousPath === ".claude/skills/review/SKILL.md" &&
          change.path === ".claude/skills/code-review/SKILL.md",
      ),
    );
    assert.ok(
      revisions[5].changes.some(
        (change) =>
          change.kind === "renamed" &&
          change.previousPath === ".claude/agents/reviewer.md" &&
          change.path === ".claude/agents/code-reviewer.md",
      ),
    );
    assert.ok(
      revisions[6].changes.some(
        (change) => change.kind === "removed" && change.path === ".claude/agents/code-reviewer.md",
      ),
    );
    assert.ok(
      revisions[6].changes.some((change) => change.kind === "removed" && change.path === ".gemini/agents/reviewer.md"),
    );
    assert.equal(revisions.at(-1).categoryTotals.rules.count, 4);
    assert.equal(revisions.at(-1).categoryTotals.commands.count, 2);
    assert.ok(!revisions.at(-1).components.some((component) => component.path.includes("untracked")));
    for (const revision of revisions) {
      assert.equal(revision.componentCount, revision.components.length);
      assert.equal(
        revision.componentCount,
        categories.reduce((sum, category) => sum + revision.categoryTotals[category].count, 0),
      );
      assert.equal(
        revision.estimatedTokens,
        categories.reduce((sum, category) => sum + revision.categoryTotals[category].estimatedTokens, 0),
      );
      for (const category of categories) {
        const components = revision.components.filter((component) => component.category === category);
        assert.equal(
          revision.categoryTotals[category].sourceOnlyCount,
          components.filter((component) => component.estimatedTokens === null).length,
        );
      }
      assert.equal(
        revision.skillGroups.reduce((sum, group) => sum + group.manifestEstimatedTokens, 0),
        revision.components
          .filter((component) => component.skill?.role === "manifest")
          .reduce((sum, component) => sum + (component.estimatedTokens ?? 0), 0),
      );
      assert.equal(
        revision.skillGroups.reduce((sum, group) => sum + group.resourceCount, 0),
        revision.components.filter((component) => component.skill?.role === "resource").length,
      );
    }
    const html = renderHtml(report);
    exerciseReportUi(html, report);
    // The masthead's font and icon are inlined, so the policy admits data: URLs and nothing remote.
    assert.match(html, /font-src data:; img-src data:"/);
    assert.match(html, /@font-face \{ font-family: "Strata Display"[^}]*url\(data:font\/woff2;base64,/);
    assert.match(html, /<link rel="icon" href="data:image\/svg\+xml,/);
    assert.doesNotMatch(html, /url\((?!data:|#|%23)/);
    // The only outbound links are the Strata name, to its npm page, opened without a referrer.
    const links = html.match(/<a [^>]*>/g);
    assert.equal(links.length, 2);
    for (const link of links) {
      assert.match(
        link,
        /href="https:\/\/www\.npmjs\.com\/package\/context-strata" target="_blank" rel="noopener noreferrer"/,
      );
    }
    const manySkills = structuredClone(report);
    for (let index = 0; index < 12; index += 1) {
      const root = `.claude/skills/zz-example-${index}`;
      const component = manySkills.components.push({
        path: `${root}/SKILL.md`,
        provider: "claude",
        category: "skills",
        blob: `example-${index}`,
        bytes: 40,
        estimatedTokens: 10,
        skill: { root, role: "manifest" },
      });
      manySkills.revisions.at(-1).changes.push({
        kind: "added",
        path: `${root}/SKILL.md`,
        previousTokens: null,
        estimatedTokens: 10,
        deltaTokens: 10,
        component: component - 1,
      });
    }
    assert.ok(expandRevisions(manySkills).at(-1).skillGroups.length > 12);
    exerciseReportUi(renderHtml(manySkills), manySkills);
    const longHistory = {
      ...report,
      revisions: [
        ...report.revisions,
        ...Array.from({ length: 96 }, (_, index) => ({
          ...report.revisions.at(-1),
          id: index.toString(16).padStart(40, "0"),
          changes: [],
        })),
      ],
    };
    const longUi = exerciseReportUi(renderHtml(longHistory), longHistory);
    assert.equal(longUi("chart").children.length, 100);
    // A grouped bar names the revisions it covers.
    assert.ok(longUi("chart").children.some((bar) => /^Revisions \d+–\d+ · /.test(bar.title)));
    // History before the first tracked file is left off the chart and stays selectable.
    const nothingTracked = {
      ...report.revisions[0],
      componentCount: 0,
      estimatedTokens: 0,
      changes: [],
      categoryTotals: Object.fromEntries(
        categories.map((category) => [category, { count: 0, bytes: 0, estimatedTokens: 0, sourceOnlyCount: 0 }]),
      ),
    };
    const lateStart = {
      ...report,
      revisions: [
        { ...nothingTracked, id: "a".repeat(40) },
        { ...nothingTracked, id: "b".repeat(40) },
        ...report.revisions,
      ],
    };
    const lateUi = exerciseReportUi(renderHtml(lateStart), lateStart);
    assert.equal(lateUi("chart").children.length, report.revisions.length);
    assert.equal(lateUi("slider").min, 2);
    assert.equal(lateUi("baseline").children.length, lateStart.revisions.length + 1);
    assert.match(lateUi("chart").children[0].title, /^Revision 3 · /);
    assert.ok(!html.includes("Follow the project conventions."));
    const shareable = redactReport(report);
    const shareableJson = JSON.stringify(shareable);
    assert.deepEqual(redactReport(report), shareable);
    assert.equal(shareable.privacy.mode, "shareable");
    assert.equal(report.privacy.mode, "local");
    const shareableRevisions = expandRevisions(shareable);
    assert.match(shareable.components[0].path, /^file-\d{5}$/);
    assert.match(shareableRevisions[0].skillGroups[0].root, /^skill-\d{5}$/);
    assert.match(shareableRevisions[0].skillGroups[0].manifestPath, /^file-\d{5}$/);
    for (const revision of revisions) {
      assert.ok(!shareableJson.includes(revision.id));
      for (const component of revision.components) {
        assert.ok(!shareableJson.includes(component.path));
        assert.ok(!shareableJson.includes(component.blob));
      }
    }
    assert.ok(!shareableJson.includes(report.repository));
    assert.equal(shareable.revisions.at(-1).estimatedTokens, revisions.at(-1).estimatedTokens);
    assert.equal(
      compareRevisions(shareableRevisions[0], shareableRevisions.at(-1)).deltaTokens,
      compareRevisions(revisions[0], revisions.at(-1)).deltaTokens,
    );
    exerciseReportUi(renderHtml(shareable), shareable);

    // The SVG image draws stored totals only: no script, links, paths, or commit IDs.
    const svg = renderSvg(report);
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="800" height="\d+"/);
    assert.doesNotMatch(svg, /<script|<foreignObject|href=|on\w+=/i);
    for (const component of report.components) assert.ok(!svg.includes(component.path), component.path);
    for (const revision of report.revisions) assert.ok(!svg.includes(revision.id));
    assert.ok(svg.includes(`${report.repository} / ${report.branch}`));
    for (const category of categories) {
      const present = report.revisions.some((revision) => revision.categoryTotals[category].estimatedTokens > 0);
      assert.equal(svg.includes(`>${category}</text>`), present, category);
    }
    assert.match(svg, new RegExp(`<text[^>]*>${report.revisions.at(-1).date.slice(0, 10)}</text>`));
    assert.doesNotMatch(svg, /steps;|chart starts/);
    assert.match(
      renderSvg(longHistory),
      /revisions shown as 100 steps; each step shows the last revision in its group\./,
    );
    assert.equal(
      renderSvg(longHistory)
        .match(/<polygon points="([^"]*)"/)[1]
        .split(" ").length,
      400,
    );
    assert.doesNotMatch(svg, /<polyline/);
    // A category or peak inside a group still sets the legend and scale, as in the HTML timeline.
    const hidden = timelineBuckets(longHistory.revisions.length, 100).find((bucket) => bucket.start < bucket.end).start;
    const peaked = structuredClone(longHistory);
    peaked.revisions[hidden].categoryTotals.commands.estimatedTokens = 100000;
    peaked.revisions[hidden].estimatedTokens += 100000;
    const peakedSvg = renderSvg(peaked);
    assert.ok(peakedSvg.includes(">commands</text>"));
    assert.ok(peakedSvg.includes(">100K</text>"));
    assert.match(peakedSvg, /each step shows the last revision in its group\./);
    // Token counts are whole, so a small scale never gets fractional ticks.
    const small = structuredClone(nothingTracked);
    small.componentCount = 1;
    small.estimatedTokens = 9;
    small.categoryTotals.instructions.estimatedTokens = 9;
    const smallTicks = [
      ...renderSvg({ ...report, revisions: [small] }).matchAll(/text-anchor="end"[^>]*font-size="10"[^>]*>([^<]+)</g),
    ];
    assert.deepEqual(
      smallTicks.map((match) => match[1]),
      ["0", "5", "10"],
    );
    const lateSvg = renderSvg(lateStart);
    assert.match(lateSvg, /The chart starts at revision 3: the 2 earlier revisions have no tracked configuration\./);
    assert.ok(lateSvg.includes(`Since ${report.revisions[0].date.slice(0, 10)}`.toUpperCase()));
    assert.match(lateSvg, new RegExp(`>REVISIONS</text>\\n<text[^>]*>${lateStart.revisions.length}</text>`));
    // The minimal image is the layers alone: the same shapes count, nothing else visible, no names or dates.
    const minimalSvg = renderSvg(report, { minimal: true });
    assert.match(minimalSvg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="800" height="200"/);
    assert.equal(minimalSvg.match(/<polygon/g).length, svg.match(/<polygon/g).length);
    assert.doesNotMatch(minimalSvg, /<text|<line|<rect|<polyline|<script|<foreignObject|href=|on\w+=/i);
    assert.ok(!minimalSvg.includes(report.repository) && !minimalSvg.includes(report.branch));
    assert.ok(!minimalSvg.includes(report.revisions.at(-1).date.slice(0, 10)));
    for (const [, points] of minimalSvg.matchAll(/points="([^"]+)"/g)) {
      for (const point of points.split(" ")) {
        const [pointX, pointY] = point.split(",").map(Number);
        assert.ok(pointX >= 0 && pointX <= 800 && pointY >= 0 && pointY <= 200, point);
      }
    }
    assert.ok(minimalSvg.includes(",0 "), "the tallest revision reaches the top edge");
    assert.doesNotMatch(renderSvg({ ...report, revisions: [] }, { minimal: true }), /<polygon|<text/);
    const shareableSvg = renderSvg(shareable);
    assert.ok(!shareableSvg.includes(report.repository));
    assert.ok(shareableSvg.includes("redacted repository / redacted branch"));
    const hostileSvg = renderSvg({ ...report, repository: '<script>&"\u0001x' });
    assert.ok(hostileSvg.includes("&lt;script&gt;&amp;&quot;x"));
    assert.ok(!hostileSvg.includes("<script") && !hostileSvg.includes("\u0001"));
    const emptySvg = renderSvg({ ...report, revisions: [nothingTracked] });
    assert.match(emptySvg, /No instructional text is tracked yet\./);
    assert.doesNotMatch(emptySvg, /<polygon|<polyline/);
    assert.match(renderSvg({ ...report, revisions: [] }), /No instructional text is tracked yet\./);

    const hostileName = "<img onerror=alert(1)>.md";
    report.components[0].path = hostileName;
    assert.ok(!renderHtml(report).includes(hostileName));

    const output = join(repo, "strata-report.json");
    const cli = spawnSync(process.execPath, ["dist/cli.js", "analyze", repo, "--output", output, "--format", "json"], {
      encoding: "utf8",
    });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stderr, /Analyzing 9 revisions/);
    assert.match(cli.stderr, /Processed 9\/9 revisions/);
    const cliReport = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(cliReport.revisions.length, 9);
    assert.equal(cliReport.revisions.at(-1).id, merge);
    const diffOutput = join(repo, "pr-delta.md");
    const diffCli = spawnSync(
      process.execPath,
      ["dist/cli.js", "diff", repo, "--base", first, "--head", merge, "--output", diffOutput],
      { encoding: "utf8" },
    );
    assert.equal(diffCli.status, 0, diffCli.stderr);
    assert.match(readFileSync(diffOutput, "utf8"), /Strata configuration delta/);
    const openAiReport = await analyzeRepository(repo, { mode: "openai-o200k_base" });
    assert.equal(openAiReport.schemaVersion, 13);
    assert.deepEqual(
      [
        openAiReport.measurement.family,
        openAiReport.measurement.accuracy,
        openAiReport.measurement.encoding,
        openAiReport.measurement.model,
        openAiReport.measurement.implementation,
      ],
      ["openai", "encoding-exact", "o200k_base", null, "js-tiktoken@1.0.21"],
    );
    const openAiRevisions = expandRevisions(openAiReport);
    const openAiInstruction = openAiRevisions[0].components.find((component) => component.path === "AGENTS.md");
    assert.equal(
      openAiInstruction?.estimatedTokens,
      getEncoding("o200k_base").encode("Shared project instructions.\n").length,
    );
    assert.equal(
      openAiRevisions[0].components.find((component) => component.path === ".agents/skills/release/assets/icon.png")
        ?.estimatedTokens,
      null,
    );
    assert.notEqual(openAiReport.revisions[0].estimatedTokens, revisions[0].estimatedTokens);
    const openAiOutput = join(repo, "openai-report.json");
    const openAiCli = spawnSync(
      process.execPath,
      [
        "dist/cli.js",
        "analyze",
        repo,
        "--tokenizer",
        "openai-cl100k_base",
        "--output",
        openAiOutput,
        "--format",
        "json",
      ],
      { encoding: "utf8" },
    );
    assert.equal(openAiCli.status, 0, openAiCli.stderr);
    assert.equal(JSON.parse(readFileSync(openAiOutput, "utf8")).measurement.encoding, "cl100k_base");
    const modelOutput = join(repo, "model-report.json");
    const modelCli = spawnSync(
      process.execPath,
      ["dist/cli.js", "analyze", repo, "--model", "gpt-4o", "--output", modelOutput, "--format", "json"],
      { encoding: "utf8" },
    );
    assert.equal(modelCli.status, 0, modelCli.stderr);
    const modelReport = JSON.parse(readFileSync(modelOutput, "utf8"));
    assert.deepEqual(
      [modelReport.measurement.model, modelReport.measurement.encoding, modelReport.schemaVersion],
      ["gpt-4o", "o200k_base", 13],
    );
    assert.equal(
      expandRevisions(modelReport)[0].components.find((component) => component.path === "AGENTS.md")?.estimatedTokens,
      getEncoding("o200k_base").encode("Shared project instructions.\n").length,
    );
    const badModel = spawnSync(
      process.execPath,
      ["dist/cli.js", "analyze", repo, "--model", "claude", "--format", "json"],
      { encoding: "utf8" },
    );
    assert.equal(badModel.status, 2);
    assert.match(badModel.stderr, /Unsupported model/);
    const conflictingMode = spawnSync(
      process.execPath,
      ["dist/cli.js", "analyze", repo, "--model", "gpt-4o", "--tokenizer", "estimate"],
      { encoding: "utf8" },
    );
    assert.equal(conflictingMode.status, 2);
    assert.match(conflictingMode.stderr, /either --model or --tokenizer/);
    const badTokenizer = spawnSync(
      process.execPath,
      ["dist/cli.js", "analyze", repo, "--tokenizer", "claude", "--format", "json"],
      { encoding: "utf8" },
    );
    assert.equal(badTokenizer.status, 2);
    assert.match(badTokenizer.stderr, /--tokenizer must be/);
    const missingProviderModel = spawnSync(
      process.execPath,
      ["dist/cli.js", "analyze", repo, "--provider-api", "--claude-model", "claude-test", "--format", "json"],
      { encoding: "utf8" },
    );
    assert.equal(missingProviderModel.status, 2);
    assert.match(missingProviderModel.stderr, /requires explicit --claude-model and --gemini-model/);
    const missingProviderKey = spawnSync(
      process.execPath,
      [
        "dist/cli.js",
        "analyze",
        repo,
        "--provider-api",
        "--claude-model",
        "claude-test",
        "--gemini-model",
        "gemini-test",
        "--format",
        "json",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, ANTHROPIC_API_KEY: "", GEMINI_API_KEY: "", GOOGLE_API_KEY: "" },
      },
    );
    assert.equal(missingProviderKey.status, 2);
    assert.match(missingProviderKey.stderr, /requires ANTHROPIC_API_KEY/);
    assert.throws(() => createMeasurer("openai-o200k_base").count(Buffer.from([0xff])), /encoded data was not valid/);
    const shareableOutput = join(repo, "shareable.json");
    const shareableCli = spawnSync(
      process.execPath,
      ["dist/cli.js", "analyze", repo, "--shareable", "--output", shareableOutput, "--format", "json"],
      { encoding: "utf8" },
    );
    assert.equal(shareableCli.status, 0, shareableCli.stderr);
    const cliSharedReport = JSON.parse(readFileSync(shareableOutput, "utf8"));
    assert.equal(cliSharedReport.privacy.mode, "shareable");
    assert.ok(!JSON.stringify(cliSharedReport).includes(merge));

    const renamedComparison = compareRevisions(revisions[3], revisions[4]);
    assert.equal(renamedComparison.deltaFiles, 0);
    assert.equal(renamedComparison.deltaTokens, 0);
    assert.ok(
      renamedComparison.components.some(
        (component) => component.kind === "removed" && component.path === ".claude/skills/review/SKILL.md",
      ),
    );
    assert.ok(
      renamedComparison.components.some(
        (component) => component.kind === "added" && component.path === ".claude/skills/code-review/SKILL.md",
      ),
    );
    const identicalComparison = compareRevisions(revisions[4], revisions[4]);
    assert.deepEqual(identicalComparison.components, []);
    assert.equal(identicalComparison.deltaTokens, 0);
    const reverseComparison = compareRevisions(revisions[2], revisions[0]);
    assert.ok(reverseComparison.deltaTokens < 0);
    assert.equal(reverseComparison.deltaTokens, revisions[0].estimatedTokens - revisions[2].estimatedTokens);

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
    const installedSkill = spawnSync(process.execPath, ["dist/cli.js", "skill", "--output", skillPath], {
      encoding: "utf8",
    });
    assert.equal(installedSkill.status, 0, installedSkill.stderr);
    assert.equal(readFileSync(skillPath, "utf8"), skill.stdout);
    assert.equal(statSync(skillPath).mode & 0o777, 0o600);
    const duplicateSkill = spawnSync(process.execPath, ["dist/cli.js", "skill", "--output", skillPath], {
      encoding: "utf8",
    });
    assert.equal(duplicateSkill.status, 1);
    assert.match(duplicateSkill.stderr, /Refusing to overwrite/);

    const badOpen = spawnSync(process.execPath, ["dist/cli.js", "analyze", repo, "--format", "json", "--open"], {
      encoding: "utf8",
    });
    assert.equal(badOpen.status, 2);
    assert.match(badOpen.stderr, /--open requires HTML or SVG output/);
    if (process.platform !== "win32") {
      const openDir = mkdtempSync(join(tmpdir(), "strata-open-"));
      try {
        const opener = join(openDir, process.platform === "darwin" ? "open" : "xdg-open");
        const openLog = join(openDir, "opened-url");
        writeFileSync(opener, '#!/bin/sh\nprintf "%s" "$1" > "$STRATA_OPEN_LOG"\n');
        chmodSync(opener, 0o700);
        const opened = spawnSync(process.execPath, ["dist/cli.js", "analyze", repo, "--open"], {
          encoding: "utf8",
          env: { ...process.env, PATH: `${openDir}:${process.env.PATH}`, STRATA_OPEN_LOG: openLog },
        });
        assert.equal(opened.status, 0, opened.stderr);
        const openedPath = opened.stdout.match(/^Report: (.+)$/m)?.[1];
        assert.ok(openedPath);
        assert.equal(readFileSync(openLog, "utf8"), pathToFileURL(openedPath).href);
        rmSync(join(openedPath, ".."), { recursive: true, force: true });
        const openedSvg = spawnSync(process.execPath, ["dist/cli.js", "analyze", repo, "-f", "svg", "--open", "-q"], {
          encoding: "utf8",
          env: { ...process.env, PATH: `${openDir}:${process.env.PATH}`, STRATA_OPEN_LOG: openLog },
        });
        assert.equal(openedSvg.status, 0, openedSvg.stderr);
        const svgPath = openedSvg.stdout.trim();
        assert.match(svgPath, /report\.svg$/);
        assert.match(readFileSync(svgPath, "utf8"), /^<svg /);
        assert.equal(readFileSync(openLog, "utf8"), pathToFileURL(svgPath).href);
        rmSync(join(svgPath, ".."), { recursive: true, force: true });
      } finally {
        rmSync(openDir, { recursive: true, force: true });
      }
    }

    put("CLAUDE.md", "Root.\nFollow project conventions and review every change.\n");
    commit("Grow root guidance before split");
    put("CLAUDE.md", "Root.\n");
    put(
      ".claude/skills/project-review/SKILL.md",
      "---\nname: project-review\ndescription: Review project changes\n---\nFollow project conventions and review every change.\n",
    );
    commit("Split guidance into a skill");
    const splitReport = await analyzeRepository(repo);
    const [beforeSplit, afterSplit] = expandRevisions(splitReport).slice(-2);
    const split = compareRevisions(beforeSplit, afterSplit);
    const treemap = layoutTreemap(afterSplit.components);
    assert.equal(treemap.totalTokens, afterSplit.estimatedTokens);
    assert.equal(
      treemap.sourceOnlyCount,
      afterSplit.components.filter((component) => component.estimatedTokens === null).length,
    );
    const leaves = treemap.groups.flatMap((group) => group.leaves);
    assert.ok(leaves.length > 0);
    for (const leaf of leaves) {
      assert.ok(Math.abs((leaf.width * leaf.height) / 10000 - leaf.estimatedTokens / treemap.totalTokens) < 1e-9);
    }
    assert.ok(Math.abs(treemap.groups.reduce((sum, group) => sum + group.width * group.height, 0) - 10000) < 1e-8);
    const withEmpty = layoutTreemap([
      ...afterSplit.components,
      { path: "empty.md", provider: "shared", category: "instructions", blob: "empty", bytes: 0, estimatedTokens: 0 },
    ]);
    assert.equal(withEmpty.zeroTokenCount, treemap.zeroTokenCount + 1);
    assert.equal(withEmpty.totalTokens, treemap.totalTokens);
    assert.equal(splitReport.revisions.length, 11);
    assert.equal(split.deltaFiles, 1);
    assert.ok(split.byCategory.find((item) => item.key === "instructions")?.deltaTokens < 0);
    assert.ok(split.byCategory.find((item) => item.key === "skills")?.deltaTokens > 0);
    assert.ok(split.components.some((component) => component.kind === "edited" && component.path === "CLAUDE.md"));
    assert.ok(
      split.components.some(
        (component) => component.kind === "added" && component.path === ".claude/skills/project-review/SKILL.md",
      ),
    );
    assert.equal(
      split.byProvider.reduce((sum, item) => sum + item.deltaTokens, 0),
      split.deltaTokens,
    );
    assert.equal(
      split.byCategory.reduce((sum, item) => sum + item.deltaFiles, 0),
      split.deltaFiles,
    );
    const reverseSplit = compareRevisions(afterSplit, beforeSplit);
    assert.equal(reverseSplit.deltaTokens, -split.deltaTokens);
    assert.equal(reverseSplit.deltaFiles, -split.deltaFiles);

    const blank = { ...beforeSplit, components: [], estimatedTokens: 0 };
    const fromBlank = compareRevisions(blank, afterSplit);
    assert.equal(fromBlank.percentChange, null);
    assert.ok(
      fromBlank.components.some(
        (component) =>
          component.path === ".claude/settings.json" &&
          component.beforeTokens === null &&
          component.afterTokens === null,
      ),
    );

    const shallow = mkdtempSync(join(tmpdir(), "strata-shallow-"));
    try {
      execFileSync("git", ["clone", "--quiet", "--depth", "1", `file://${repo}`, shallow]);
      const shallowReport = await analyzeRepository(shallow);
      assert.equal(shallowReport.shallow, true);
      assert.equal(shallowReport.revisions.length, 1);
    } finally {
      rmSync(shallow, { recursive: true, force: true });
    }
    git("checkout", "--detach");
    const detached = await analyzeRepository(repo);
    assert.equal(detached.branch, "detached HEAD");
    assert.equal(detached.revisions.length, splitReport.revisions.length);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("follows Gemini context.fileName for AGENTS.md and GEMINI.md, and Gemini's agent and skill discovery", async () => {
  const repo = mkdtempSync(join(tmpdir(), "strata-gemini-"));
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  const put = (path, content) => {
    const fullPath = join(repo, path);
    mkdirSync(join(fullPath, ".."), { recursive: true });
    writeFileSync(fullPath, content);
  };
  const commit = (message) => {
    git("add", "-A");
    git("commit", "-m", message);
  };
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Strata Test");
    git("config", "user.email", "strata-test@example.invalid");
    put("AGENTS.md", "Shared project instructions.\n");
    put("packages/app/AGENTS.md", "Nested shared instructions.\n");
    put("GEMINI.md", "Gemini project instructions.\n");
    put(".gemini/settings.json", "{}\n");
    put(".gemini/agents/reviewer.md", "---\nname: reviewer\n---\nReview the diff.\n");
    put(".gemini/agents/_draft.md", "Not loaded by Gemini CLI.\n");
    put(".gemini/agents/nested/helper.md", "Not loaded by Gemini CLI either.\n");
    put(".gemini/skills/SKILL.md", "---\nname: single\n---\nA single workspace skill.\n");
    put(".agents/skills/SKILL.md", "---\nname: alias\n---\nA single skill in the shared alias directory.\n");
    commit("Default Gemini context");

    put(
      ".gemini/settings.json",
      '{\n  // Read the shared file too.\n  "context": { "fileName": ["AGENTS.md", "GEMINI.md", "TEAM.md"] } /* trailing */\n}\n',
    );
    commit("Name AGENTS.md as a Gemini context file");

    put(".gemini/settings.json", '{"contextFileName":"AGENTS.md"}\n');
    commit("Legacy settings key, without GEMINI.md");

    put(".gemini/settings.json", '{"context":{"fileName":"GEMINI.md"},"contextFileName":"AGENTS.md"}\n');
    put("AGENTS.md", "Edited while Gemini does not read it.\n");
    commit("Current key wins over the legacy one");

    rmSync(join(repo, ".gemini/settings.json"));
    commit("Remove Gemini settings");

    const geminiBodies = [];
    const report = await analyzeRepository(repo, {
      providerCounts: {
        claudeModel: "claude-test-model",
        geminiModel: "gemini-test-model",
        anthropicApiKey: "anthropic-test-key",
        geminiApiKey: "gemini-test-key",
        fetchImpl: async (url, init) => {
          if (!url.includes("anthropic")) geminiBodies.push(init.body);
          return new Response(JSON.stringify(url.includes("anthropic") ? { input_tokens: 7 } : { totalTokens: 9 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      },
    });
    assert.deepEqual(
      report.revisions.map((revision) => revision.geminiContextFiles ?? null),
      [null, ["agents-md", "gemini-md"], ["agents-md"], ["gemini-md"], null],
    );
    assert.ok(!JSON.stringify(report).includes("TEAM.md"));
    const revisions = expandRevisions(report);
    const geminiPaths = (source, table) => {
      const expanded = expandRevisions(source);
      return expanded.map((revision, index) =>
        viewRevision(revision, "gemini", expanded[index - 1], table).components.map((component) => component.path),
      );
    };
    const contextPaths = geminiPaths(report).map((paths) =>
      paths.filter((path) => path.endsWith("AGENTS.md") || path === "GEMINI.md"),
    );
    assert.deepEqual(contextPaths, [
      ["GEMINI.md"],
      ["AGENTS.md", "GEMINI.md", "packages/app/AGENTS.md"],
      ["AGENTS.md", "packages/app/AGENTS.md"],
      ["GEMINI.md"],
      ["GEMINI.md"],
    ]);
    // Paths are aliased in a shareable report; the Gemini view must still find the same files.
    const shareable = redactReport(report);
    assert.deepEqual(
      geminiPaths(shareable).map((paths) => paths.length),
      geminiPaths(report).map((paths) => paths.length),
    );
    assert.ok(
      revisions.every((revision) => viewRevision(revision, "claude").components.some((c) => c.path === "AGENTS.md")),
    );

    // A settings-only change lists the context files it brings into or out of the Gemini view.
    const settingsChange = viewRevision(revisions[1], "gemini", revisions[0], report.components);
    assert.deepEqual(
      settingsChange.changes.map((change) => [change.kind, change.path]),
      [
        ["modified", ".gemini/settings.json"],
        ["added", "AGENTS.md"],
        ["added", "packages/app/AGENTS.md"],
      ],
    );
    const added = settingsChange.changes.find((change) => change.path === "AGENTS.md");
    assert.equal(
      report.components[added.component],
      revisions[1].components.find((c) => c.path === "AGENTS.md"),
    );
    assert.deepEqual(
      viewRevision(revisions[2], "gemini", revisions[1], report.components).changes.map((change) => [
        change.kind,
        change.path,
      ]),
      [
        ["modified", ".gemini/settings.json"],
        ["removed", "GEMINI.md"],
      ],
    );

    // Gemini totals follow the configured context files; Claude's do not depend on Gemini settings.
    assert.deepEqual(
      report.revisions.map((revision) => revision.providerTokenTotals.gemini),
      [36, 54, 45, 36, 36],
    );
    assert.deepEqual(
      report.revisions.map((revision) => revision.providerTokenTotals.claude),
      [14, 14, 14, 14, 14],
    );
    // Only versions Gemini reads somewhere are sent to it: not the AGENTS.md edit made while unread.
    assert.ok(geminiBodies.some((body) => body.includes("Shared project instructions.")));
    assert.ok(!geminiBodies.some((body) => body.includes("Edited while Gemini does not read it.")));
    const edited = revisions[3].components.find((component) => component.path === "AGENTS.md");
    assert.equal(edited.providerTokenCounts.gemini, undefined);
    assert.equal(revisions[2].components.find((c) => c.path === "GEMINI.md").providerTokenCounts.gemini.tokens, 9);

    const byPath = new Map(revisions[0].components.map((component) => [component.path, component]));
    assert.equal(byPath.get(".gemini/agents/reviewer.md")?.category, "agents");
    for (const path of [".gemini/agents/_draft.md", ".gemini/agents/nested/helper.md"]) {
      assert.deepEqual([byPath.get(path)?.category, byPath.get(path)?.estimatedTokens], ["other", null]);
    }
    assert.deepEqual(
      revisions[0].skillGroups.map(({ root, provider, manifestPath }) => [root, provider, manifestPath]),
      [
        [".agents/skills", "gemini", ".agents/skills/SKILL.md"],
        [".gemini/skills", "gemini", ".gemini/skills/SKILL.md"],
      ],
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("names submodules that hold agent configuration it did not analyze", async () => {
  const repo = mkdtempSync(join(tmpdir(), "strata-submodules-"));
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  // A submodule entry records a commit from another repository; `nested` makes that repository in place.
  const link = (path, commit) => git("update-index", "--add", "--cacheinfo", `160000,${commit},${path}`);
  const missing = "1".repeat(40);
  const nested = (path, files) => {
    const dir = join(repo, path);
    const sub = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
    mkdirSync(dir, { recursive: true });
    sub("init", "-q", "-b", "main");
    sub("config", "user.name", "Strata Test");
    sub("config", "user.email", "strata-test@example.invalid");
    sub("config", "commit.gpgsign", "false");
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(join(dir, file, ".."), { recursive: true });
      writeFileSync(join(dir, file), content);
    }
    sub("add", "-A");
    sub("commit", "-q", "-m", "Submodule content");
    return sub("rev-parse", "HEAD");
  };
  try {
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Strata Test");
    git("config", "user.email", "strata-test@example.invalid");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(repo, "CLAUDE.md"), "Root instructions.\n");
    git("add", "CLAUDE.md");
    git("commit", "-q", "-m", "No submodules");
    const plain = await analyzeRepository(repo);
    assert.equal("submodules" in plain, false);
    assert.equal(loadReportUi(renderHtml(plain)).get("submodules").hidden, true);

    const template = nested(".claude-template", {
      "CLAUDE.md": "Template instructions.\n",
      ".claude/settings.json": "{}\n",
      ".claude/agents/review.md": "Review.\n",
      "README.md": "Not configuration.\n",
    });
    link(".claude-template", template);
    link("vendor/lib", nested("vendor/lib", { "index.js": "export {};\n" }));
    // A skill kept as its own repository is recognized by where it is mounted.
    link(
      ".claude/skills/review",
      nested(".claude/skills/review", { "SKILL.md": "Review.\n", "references/checklist.md": "Check.\n" }),
    );
    link("vendor/old-lib", missing);
    link("tools/agents", missing);
    git("commit", "-q", "-m", "Add submodules");
    // A stale checkout lacks the recorded commit; an absent one has no repository at all.
    nested("vendor/stale", { "AGENTS.md": "Newer than the record.\n" });
    link("vendor/stale", missing);
    link("vendor/absent", missing);
    git("rm", "-q", "--cached", "vendor/old-lib", "tools/agents");
    mkdirSync(join(repo, "tools"));
    writeFileSync(join(repo, "tools/agents"), "A file where a submodule was.\n");
    git("add", "tools/agents");
    git("commit", "-q", "-m", "Remove one submodule, replace another with a file, add two");
    // Only the commit the parent records is read, not the submodule's working tree.
    writeFileSync(join(repo, ".claude-template/AGENTS.md"), "Uncommitted.\n");

    // Configuration that hides submodules from diffs does not hide them from analysis.
    git("config", "diff.ignoreSubmodules", "all");
    const report = await analyzeRepository(repo);
    assert.deepEqual(report.submodules, [
      { path: ".claude-template", configFiles: 3 },
      { path: ".claude/skills/review", configFiles: 2 },
      { path: "vendor/absent", configFiles: null },
      { path: "vendor/lib", configFiles: 0 },
      { path: "vendor/stale", configFiles: null },
    ]);
    assert.deepEqual(new Set(report.components.map((component) => component.path)), new Set(["CLAUDE.md"]));
    const notice = loadReportUi(renderHtml(report)).get("submodules");
    assert.equal(notice.hidden, false);
    assert.equal(
      notice.textContent,
      "Not analyzed: 2 Git submodules hold recognized agent configuration files: .claude-template (3), .claude/skills/review (2). " +
        "Run Strata on one to see its history. " +
        "2 Git submodules were not checked for agent configuration because they are not checked out at the recorded commit.",
    );

    const shareable = redactReport(report);
    assert.deepEqual(
      shareable.submodules.map(({ path }) => path),
      ["submodule-00001", "submodule-00002", "submodule-00003", "submodule-00004", "submodule-00005"],
    );
    assert.doesNotMatch(JSON.stringify(shareable), /claude-template|vendor/);

    // Submodules without agent configuration are left out of the notice.
    const quiet = { ...report, submodules: [{ path: "vendor/lib", configFiles: 0 }] };
    assert.equal(loadReportUi(renderHtml(quiet)).get("submodules").hidden, true);
    const many = {
      ...report,
      submodules: Array.from({ length: 7 }, (_, index) => ({ path: `lib/${index + 1}`, configFiles: index + 1 })),
    };
    assert.equal(
      loadReportUi(renderHtml(many)).get("submodules").textContent,
      "Not analyzed: 7 Git submodules hold recognized agent configuration files: " +
        "lib/1 (1), lib/2 (2), lib/3 (3), lib/4 (4), lib/5 (5), and 2 more. Run Strata on one to see its history.",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
