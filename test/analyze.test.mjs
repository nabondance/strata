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
import { configMap } from "../dist/config-map.js";
import { expandRevisions } from "../dist/expand.js";
import { instructionAgePeriods, instructionAges, sharePercent } from "../dist/instruction-age.js";
import { createMeasurer } from "../dist/measurement.js";
import { compareGitCommits, renderPullRequestDelta } from "../dist/pr-delta.js";
import { redactReport } from "../dist/privacy.js";
import { viewRevision } from "../dist/provider-view.js";
import { renderHtml } from "../dist/report.js";
import { renderSvg } from "../dist/svg.js";
import { timelineBuckets } from "../dist/timeline.js";
import { layoutTreemap } from "../dist/treemap.js";
import { assertLineAgesMatchTrees } from "./line-age-oracle.mjs";

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
        toggle: (name, force = !this.classes.has(name)) => {
          if (force) this.classes.add(name);
          else this.classes.delete(name);
          return force;
        },
      };
    }
    append(...children) {
      for (const child of children) if (child instanceof Element) child.parentElement = this;
      this.children.push(...children);
    }
    closest(selector) {
      const name = selector.slice(1);
      for (let at = this; at; at = at.parentElement) if (at.className?.split(" ").includes(name)) return at;
      return null;
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
      document.activeElement = this;
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
  // Instruction age: one bar per charted revision, a legend entry per period present, and the text kept from the baseline.
  const ages = instructionAges(report);
  const ageStart = ages.bytes.findIndex((amount) => amount > 0);
  assert.equal(get("age-panel").hidden, ageStart < 0);
  if (ageStart >= 0) {
    const periods = instructionAgePeriods(report);
    assert.equal(get("age-chart").children.length, Math.min(100, ages.bytes.length - ageStart));
    const presentPeriods = new Set(ages.at(3).map((cohort) => periods.periodOf.get(cohort.from)));
    assert.equal(get("age-legend").children.length, presentPeriods.size);
    assert.ok(get("age-legend").children.every((entry) => /%$/.test(entry.children.at(-1).textContent)));
    assert.match(
      get("age-count").textContent,
      ages.bytes[3] ? /^half added by \d{4}-\d{2}-\d{2} · / : /no instruction text/,
    );
    const kept = (from, to) =>
      sharePercent(
        ages.at(to).reduce((sum, cohort) => sum + (cohort.from <= from ? cohort.bytes : 0), 0) / ages.bytes[from],
      );
    assert.equal(get("compare-kept-wrap").hidden, !ages.bytes[2]);
    if (ages.bytes[2])
      assert.equal(
        get("compare-kept").textContent,
        `${kept(2, 3)} of ${new Intl.NumberFormat().format(ages.bytes[2])} bytes`,
      );
    assert.equal(get("compare-kept-label").textContent, "Instruction text kept");
    // A baseline after the target has nothing to keep.
    get("baseline").value = "4";
    get("baseline").listeners.change();
    assert.equal(get("compare-kept-wrap").hidden, true);
    // The previous revision is the default baseline.
    get("baseline").value = "previous";
    get("baseline").listeners.change();
    get("target").value = "4";
    get("target").listeners.change();
    assert.equal(get("compare-kept-wrap").hidden, !ages.bytes[3]);
    if (ages.bytes[3])
      assert.match(get("compare-kept").textContent, new RegExp(`^${kept(3, 4).replace(/[<>]/, "\\$&")} of `));
    // A bar selects the last revision it covers, like the history chart.
    get("age-chart").children[0].listeners.click();
    const firstBucket = timelineBuckets(ages.bytes.length, 100, ageStart)[0];
    assert.equal(get("target").value, String(firstBucket.end));
    get("baseline").value = "2";
    get("baseline").listeners.change();
    get("target").value = "3";
    get("target").listeners.change();
  }
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
  // Kept text covers all files, and says so outside the All files view.
  assert.equal(get("compare-kept-label").textContent, "Instruction text kept (all files)");
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
    assertLineAgesMatchTrees(repo, report);
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
    assert.equal(providerApiReport.schemaVersion, 19);
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
    assert.equal(prDelta.schemaVersion, 12);
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
    assert.equal(report.schemaVersion, 19);
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
    assert.equal(openAiReport.schemaVersion, 19);
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
      ["gpt-4o", "o200k_base", 19],
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
    // A full clone that fetched another branch shallowly is a shallow repository, but this history is complete.
    const partly = mkdtempSync(join(tmpdir(), "strata-partly-shallow-"));
    try {
      execFileSync("git", ["clone", "--quiet", `file://${repo}`, partly]);
      // Return to the same branch, or the same commit when detached, without relying on the reflog.
      const branch = git("rev-parse", "--abbrev-ref", "HEAD");
      const back = branch === "HEAD" ? git("rev-parse", "HEAD") : branch;
      execFileSync("git", ["-C", repo, "checkout", "--quiet", "-b", "side"]);
      for (const step of ["one", "two"]) {
        writeFileSync(join(repo, "side.txt"), `${step}\n`);
        execFileSync("git", ["-C", repo, "add", "side.txt"]);
        execFileSync("git", ["-C", repo, "commit", "--quiet", "-m", `side ${step}`]);
      }
      execFileSync("git", ["-C", repo, "checkout", "--quiet", back]);
      execFileSync("git", ["-C", partly, "fetch", "--quiet", "--depth", "1", "origin", "side"]);
      assert.equal(
        execFileSync("git", ["-C", partly, "rev-parse", "--is-shallow-repository"], { encoding: "utf8" }).trim(),
        "true",
      );
      const partlyReport = await analyzeRepository(partly);
      assert.equal(partlyReport.shallow, false);
      assert.equal(
        partlyReport.revisions.length,
        Number(
          execFileSync("git", ["-C", partly, "rev-list", "--count", "--first-parent", "HEAD"], { encoding: "utf8" }),
        ),
      );
    } finally {
      rmSync(partly, { recursive: true, force: true });
    }
    // A depth limit that reaches the root commit cuts nothing, though Git lists the root as shallow.
    const single = mkdtempSync(join(tmpdir(), "strata-single-"));
    const singleClone = mkdtempSync(join(tmpdir(), "strata-single-clone-"));
    try {
      execFileSync("git", ["-C", single, "init", "--quiet", "-b", "main"]);
      writeFileSync(join(single, "CLAUDE.md"), "Only commit.\n");
      execFileSync("git", ["-C", single, "add", "CLAUDE.md"]);
      execFileSync("git", [
        "-C",
        single,
        "-c",
        "user.name=Strata Test",
        "-c",
        "user.email=strata-test@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "root",
      ]);
      execFileSync("git", ["clone", "--quiet", "--depth", "1", `file://${single}`, singleClone]);
      assert.equal(
        execFileSync("git", ["-C", singleClone, "rev-parse", "--is-shallow-repository"], { encoding: "utf8" }).trim(),
        "true",
      );
      assert.equal((await analyzeRepository(singleClone)).shallow, false);
    } finally {
      rmSync(single, { recursive: true, force: true });
      rmSync(singleClone, { recursive: true, force: true });
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
    assertLineAgesMatchTrees(repo, report);
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

test("recognizes Cursor configuration, and has Cursor read other tools' files only where Cursor is configured", async () => {
  const repo = mkdtempSync(join(tmpdir(), "strata-cursor-"));
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
  const cursorFiles = {
    ".cursorrules": "Legacy Cursor rules for the whole project.\n",
    ".cursorignore": "secrets/\n",
    ".cursor/rules/style.mdc": "---\ndescription: Code style\nalwaysApply: true\n---\nUse two spaces.\n",
    "packages/web/.cursor/rules/react/components.mdc":
      "---\nglobs: src/**/*.tsx\nalwaysApply: false\n---\nPrefer function components.\n",
    ".cursor/rules/notes.md": "Plain Markdown that Cursor ignores as a rule.\n",
    ".cursor/commands/review.md": "Review the staged changes.\n",
    ".cursor/commands/drafts/old.md": "Not a top-level command.\n",
    ".cursor/mcp.json": '{"mcpServers":{"docs":{"url":"https://example.invalid/mcp"}}}\n',
    ".cursor/hooks.json": '{"version":1,"hooks":{}}\n',
    ".cursor/skills/opam/SKILL.md": "---\nname: opam\ndescription: Manage opam switches\n---\nSteps.\n",
    ".cursor/skills/opam/documentation.md": "Reference.\n",
    ".cursor/skills/draft/SKILL.md": "No frontmatter, so Cursor cannot list it.\n",
    ".cursor/skills/manual/SKILL.md":
      "---\nname: manual\ndescription: Run only on request\ndisable-model-invocation: true\n---\nBody.\n",
    // A manifest directly in a skill directory is not a skill for Cursor.
    ".cursor/skills/SKILL.md": "---\nname: loose\ndescription: Loose\n---\n",
  };
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Strata Test");
    git("config", "user.email", "strata-test@example.invalid");
    put("AGENTS.md", "Shared project instructions.\n");
    put(".claude/skills/review/SKILL.md", "Review the change.\n");
    put(".claude/skills/SKILL.md", "---\nname: loose\ndescription: Loose\n---\n");
    put(".agents/skills/release/SKILL.md", "---\nname: release\ndescription: Cut a release\n---\nBody.\n");
    // Cursor loads .codex/skills for compatibility, but Codex no longer documents it: it stays Codex `other`.
    put(".codex/skills/legacy/SKILL.md", "---\nname: legacy\ndescription: Old Codex skill\n---\nBody.\n");
    // Notes kept under .cursor/ and a nested .cursorrules are not Cursor configuration.
    put(".cursor/NOTES.md", "Scratch notes.\n");
    put(".cursor/docs/reports/benchmark.md", "A benchmark report.\n");
    put("packages/web/.cursorrules", "Not read: only the root file is.\n");
    commit("Claude and Codex only");

    // A history without Cursor configuration never mentions Cursor.
    const claudeOnly = await analyzeRepository(repo);
    assert.ok(!JSON.stringify([claudeOnly.components, claudeOnly.revisions]).includes("cursor"));
    const onlyRevision = expandRevisions(claudeOnly)[0];
    const review = onlyRevision.components.find((c) => c.path === ".claude/skills/review/SKILL.md");
    assert.deepEqual([review.provider, review.readers], ["claude", undefined]);
    assert.deepEqual(onlyRevision.components.find((c) => c.path === "AGENTS.md").readers, ["claude", "codex"]);
    const claudeOnlyUi = loadReportUi(renderHtml(claudeOnly)).get;
    assert.ok(!claudeOnlyUi("provider-tabs").children.some((tab) => tab.textContent.startsWith("Cursor")));

    for (const [path, content] of Object.entries(cursorFiles)) put(path, content);
    // Editing AGENTS.md in the adoption commit takes the ordinary change path, not a settings flip.
    put("AGENTS.md", "Shared project instructions, now for Cursor too.\n");
    const added = commit("Adopt Cursor");

    // Git detects both moves as renames; the second turns an ignored file into a counted rule.
    git("mv", ".cursorrules", ".cursor/rules/project.mdc");
    git("mv", ".cursor/rules/notes.md", ".cursor/rules/notes.mdc");
    put(".claude/skills/review/SKILL.md", "Review the change and its tests.\n");
    put(".cursor/rules/testing.mdc", "---\ndescription: Tests\n---\nRun the suite before committing.\n");
    put(
      ".cursor/rules/style.mdc",
      "---\ndescription: Code style\nalwaysApply: true\n---\nUse two spaces, never tabs.\n",
    );
    const migrated = commit("Move legacy rules into .cursor/rules");

    rmSync(join(repo, ".cursor/commands/review.md"));
    commit("Remove the review command");

    rmSync(join(repo, ".cursor"), { recursive: true, force: true });
    rmSync(join(repo, ".cursorignore"));
    rmSync(join(repo, "packages/web/.cursor"), { recursive: true, force: true });
    commit("Stop using Cursor");

    const sentBodies = [];
    const report = await analyzeRepository(repo, {
      providerCounts: {
        claudeModel: "claude-test-model",
        geminiModel: "gemini-test-model",
        anthropicApiKey: "anthropic-test-key",
        geminiApiKey: "gemini-test-key",
        fetchImpl: async (url, init) => {
          sentBodies.push(init.body);
          return new Response(JSON.stringify(url.includes("anthropic") ? { input_tokens: 7 } : { totalTokens: 9 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      },
    });
    assertLineAgesMatchTrees(repo, report);
    assert.equal(report.schemaVersion, 19);
    const revisions = expandRevisions(report);
    const labels = (revision) =>
      Object.fromEntries(
        revision.components.map((component) => [
          component.path,
          [component.provider, component.category, component.estimatedTokens === null ? "source" : "text"],
        ]),
      );
    assert.deepEqual(labels(revisions[1]), {
      ".agents/skills/release/SKILL.md": ["shared", "skills", "text"],
      ".claude/skills/SKILL.md": ["claude", "other", "source"],
      ".claude/skills/review/SKILL.md": ["claude", "skills", "text"],
      ".codex/skills/legacy/SKILL.md": ["codex", "other", "source"],
      ".cursor/commands/drafts/old.md": ["cursor", "other", "source"],
      ".cursor/commands/review.md": ["cursor", "commands", "text"],
      ".cursor/hooks.json": ["cursor", "other", "source"],
      ".cursor/mcp.json": ["cursor", "tools", "source"],
      ".cursor/rules/notes.md": ["cursor", "other", "source"],
      ".cursor/rules/style.mdc": ["cursor", "rules", "text"],
      ".cursor/skills/SKILL.md": ["cursor", "other", "source"],
      ".cursor/skills/draft/SKILL.md": ["cursor", "skills", "text"],
      ".cursor/skills/manual/SKILL.md": ["cursor", "skills", "text"],
      ".cursor/skills/opam/SKILL.md": ["cursor", "skills", "text"],
      ".cursor/skills/opam/documentation.md": ["cursor", "skills", "source"],
      ".cursorignore": ["cursor", "settings", "source"],
      ".cursorrules": ["cursor", "rules", "text"],
      "AGENTS.md": ["shared", "instructions", "text"],
      "packages/web/.cursor/rules/react/components.mdc": ["cursor", "rules", "text"],
    });
    const byPath = new Map(revisions[1].components.map((component) => [component.path, component]));
    assert.equal(byPath.get(".cursorrules").legacy, true);
    assert.ok(revisions[1].components.every((component) => component.path === ".cursorrules" || !component.legacy));
    assert.deepEqual(byPath.get("AGENTS.md").readers, ["claude", "codex", "cursor"]);
    assert.deepEqual(byPath.get(".agents/skills/release/SKILL.md").readers, ["codex", "cursor", "gemini"]);
    assert.deepEqual(byPath.get(".claude/skills/review/SKILL.md").readers, ["claude", "cursor"]);

    // Cursor reads AGENTS.md, .agents/skills, and .claude/skills only while the revision tracks Cursor files.
    const borrowed = (index) =>
      viewRevision(revisions[index], "cursor", revisions[index - 1], report.components)
        .components.filter((component) => component.provider !== "cursor")
        .map((component) => component.path);
    assert.deepEqual(borrowed(0), []);
    assert.deepEqual(borrowed(1), [".agents/skills/release/SKILL.md", ".claude/skills/review/SKILL.md", "AGENTS.md"]);
    assert.deepEqual(borrowed(4), []);
    const adoption = viewRevision(revisions[1], "cursor", revisions[0], report.components).changes;
    for (const path of ["AGENTS.md", ".agents/skills/release/SKILL.md", ".claude/skills/review/SKILL.md"]) {
      assert.ok(adoption.some((change) => change.kind === "added" && change.path === path));
    }
    const dropped = viewRevision(revisions[4], "cursor", revisions[3], report.components).changes;
    assert.ok(dropped.some((change) => change.kind === "removed" && change.path === "AGENTS.md"));
    // The same answer from aliased paths.
    const shareableRevisions = expandRevisions(redactReport(report));
    assert.deepEqual(
      shareableRevisions.map((revision) => viewRevision(revision, "cursor").components.length),
      revisions.map((revision) => viewRevision(revision, "cursor").components.length),
    );

    // .claude/skills stays Claude's: in the Claude view, not in Shared only.
    assert.deepEqual(
      viewRevision(revisions[1], "claude").components.map((component) => component.path),
      [".claude/skills/review/SKILL.md", ".claude/skills/SKILL.md", "AGENTS.md"],
    );
    assert.deepEqual(
      viewRevision(revisions[1], "shared").components.map((component) => component.path),
      [".agents/skills/release/SKILL.md", "AGENTS.md"],
    );

    // Cursor needs name and description and honors disable-model-invocation; .claude/skills keeps Claude's rules.
    const listing = (path) => byPath.get(path).skill.listing;
    assert.deepEqual(listing(".cursor/skills/opam/SKILL.md"), {
      status: "listed",
      tokens: Math.ceil(Buffer.byteLength("opam\nManage opam switches") / 4),
    });
    assert.equal(listing(".cursor/skills/draft/SKILL.md").status, "unresolved");
    assert.deepEqual(listing(".cursor/skills/manual/SKILL.md"), { status: "hidden", tokens: 0 });
    assert.deepEqual(listing(".claude/skills/review/SKILL.md"), {
      status: "listed",
      tokens: Math.ceil(Buffer.byteLength("review\nReview the change.") / 4),
    });
    assert.deepEqual(
      revisions[1].skillGroups.map(({ root, provider, resourceCount }) => [root, provider, resourceCount]),
      [
        [".agents/skills/release", "shared", 0],
        [".claude/skills/review", "claude", 0],
        [".cursor/skills/draft", "cursor", 0],
        [".cursor/skills/manual", "cursor", 0],
        [".cursor/skills/opam", "cursor", 1],
      ],
    );
    const cursorView = viewRevision(revisions[1], "cursor");
    const cursorManifests = cursorView.components.filter((component) => component.skill?.role === "manifest");
    assert.equal(cursorManifests.length, 5);
    assert.equal(
      cursorView.skillListingTokens,
      cursorManifests.reduce((sum, component) => sum + (component.skill.listing?.tokens ?? 0), 0),
    );
    assert.equal(cursorView.skillListingUnresolved, 1);

    assert.equal(revisions[1].components.filter((component) => component.path === "AGENTS.md").length, 1);
    assert.equal(revisions[1].categoryTotals.rules.count, 3);
    assert.equal(revisions[1].categoryTotals.skills.count, 6);
    assert.equal(revisions[1].categoryTotals.tools.sourceOnlyCount, 1);
    assert.equal(revisions[1].categoryTotals.settings.sourceOnlyCount, 1);
    assert.equal(revisions[1].categoryTotals.other.sourceOnlyCount, 6);

    assert.deepEqual(report.revisions[2].changes.map((change) => [change.kind, change.path]).sort(), [
      ["added", ".cursor/rules/testing.mdc"],
      ["modified", ".claude/skills/review/SKILL.md"],
      ["modified", ".cursor/rules/style.mdc"],
      ["renamed", ".cursor/rules/notes.mdc"],
      ["renamed", ".cursor/rules/project.mdc"],
    ]);
    const renamed = new Map(report.revisions[2].changes.map((change) => [change.path, change]));
    assert.equal(renamed.get(".cursor/rules/project.mdc").previousPath, ".cursorrules");
    assert.equal(renamed.get(".cursor/rules/notes.mdc").previousTokens, null);
    assert.ok(renamed.get(".cursor/rules/notes.mdc").estimatedTokens > 0);
    const project = revisions[2].components.find((component) => component.path === ".cursor/rules/project.mdc");
    assert.equal(project.blob, byPath.get(".cursorrules").blob);
    assert.equal(project.legacy, undefined);
    assert.deepEqual(
      report.revisions[3].changes.map((change) => [change.kind, change.path]),
      [["removed", ".cursor/commands/review.md"]],
    );
    assert.equal(revisions[3].categoryTotals.commands.count, 0);
    assert.equal(revisions[3].categoryTotals.rules.count, 5);
    assert.equal(revisions[3].categoryTotals.other.sourceOnlyCount, 5);

    // `strata diff` uses the same labels; a .claude/skills change stays in Claude's row.
    const delta = compareGitCommits(repo, added, migrated);
    assert.equal(delta.schemaVersion, 12);
    const legacyDelta = delta.comparison.components.find((component) => component.path === ".cursorrules");
    assert.deepEqual([legacyDelta.kind, legacyDelta.category, legacyDelta.legacy], ["removed", "rules", true]);
    const skillDelta = delta.comparison.components.find((c) => c.path === ".claude/skills/review/SKILL.md");
    assert.equal(skillDelta.provider, "claude");
    const row = (key) => delta.comparison.byProvider.find((group) => group.key === key);
    assert.equal(row("claude").deltaTokens, skillDelta.deltaTokens);
    assert.ok(row("cursor"));

    // Cursor has no count endpoint: its files keep the estimate and their text is never sent.
    // Gemini is counted only for the .agents/skills manifest.
    assert.deepEqual(
      report.providerMeasurements.map((measured) => measured.provider),
      ["claude", "gemini"],
    );
    assert.ok(report.revisions.every((revision) => !("cursor" in (revision.providerTokenTotals ?? {}))));
    assert.ok(sentBodies.some((body) => body.includes("Shared project instructions.")));
    assert.ok(sentBodies.some((body) => body.includes("Review the change.")));
    assert.ok(
      !sentBodies.some((body) =>
        /two spaces|function components|Legacy Cursor|staged changes|opam switches|Run only on request/.test(body),
      ),
    );
    const counted = report.components.filter((component) => component.providerTokenCounts);
    assert.deepEqual(
      [
        ...new Set(
          counted.map((component) => `${component.path},${Object.keys(component.providerTokenCounts).join()}`),
        ),
      ].sort(),
      [".agents/skills/release/SKILL.md,gemini", ".claude/skills/review/SKILL.md,claude", "AGENTS.md,claude"],
    );

    // The legacy label is not a path, so a shareable report keeps it.
    const shareable = redactReport(report);
    assert.equal(shareable.components.filter((component) => component.legacy).length, 1);
    assert.ok(!JSON.stringify(shareable).includes(".cursorrules"));

    const { get } = loadReportUi(renderHtml(report));
    const cursorTab = get("provider-tabs").children.find((child) => child.textContent === "Cursor + shared");
    assert.ok(cursorTab);
    cursorTab.listeners.click();
    const paths = (id) => get(id).children.map((row) => row.children[0]?.textContent);
    get("target").value = "0";
    get("target").listeners.change();
    assert.ok(!paths("files").includes("AGENTS.md"));
    get("target").value = "1";
    get("target").listeners.change();
    assert.ok(paths("files").includes("AGENTS.md"));
    assert.match(
      get("listing-note").textContent,
      /Cursor may summarize skills from \.claude\/skills or \.agents\/skills differently/,
    );
    assert.ok(get("files").children.some((row) => row.children[2]?.textContent === "rules (legacy)"));
    // The comparison that migrates the file names it legacy too.
    get("target").value = "2";
    get("target").listeners.change();
    assert.ok(get("compare-components").children.some((row) => row.children[2]?.textContent === "rules (legacy)"));
    // Removing the last Cursor file lists the files Cursor stops reading as removed.
    get("target").value = "4";
    get("target").listeners.change();
    assert.ok(!paths("files").includes("AGENTS.md"));
    assert.ok(
      get("compare-components").children.some(
        (row) => row.children[0]?.textContent === "AGENTS.md" && row.children[3]?.textContent === "removed",
      ),
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("recognizes GitHub Copilot configuration, and has Copilot read other tools' files only where Copilot is configured", async () => {
  const repo = mkdtempSync(join(tmpdir(), "strata-copilot-"));
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
  const copilotFiles = {
    ".github/copilot-instructions.md": "Answer in British English.\n",
    ".github/instructions/frontend/react.instructions.md":
      '---\napplyTo: "src/**/*.tsx"\nexcludeAgent: "code-review"\n---\nPrefer hooks over classes.\n',
    ".github/instructions/README.md": "How the team writes instruction files.\n",
    ".github/prompts/release.prompt.md": "---\ndescription: Cut a release\n---\nDraft the release notes.\n",
    // VS Code reads prompt files directly in the folder only.
    ".github/prompts/drafts/old.prompt.md": "An unfinished prompt.\n",
    ".github/agents/reviewer.agent.md": "---\ndescription: Reviews changes\n---\nReview like a maintainer.\n",
    ".github/agents/team/planner.md": "---\ndescription: Plans work\n---\nBreak the task down.\n",
    ".github/agents/README.md": "Index of our agents.\n",
    ".github/agents/legacy.chatmode.md": "---\ndescription: Old chat mode\n---\nAnswer tersely.\n",
    ".github/chatmodes/old.chatmode.md": "---\ndescription: Not read any more\n---\nUnused.\n",
    ".github/skills/webapp-testing/SKILL.md":
      "---\nname: webapp-testing\ndescription: Test the web app in a browser\n---\nSteps.\n",
    ".github/skills/webapp-testing/run.sh": "#!/bin/sh\nnpm test\n",
    ".github/skills/draft/SKILL.md": "No frontmatter, so Copilot cannot list it.\n",
    ".github/skills/SKILL.md": "---\nname: loose\ndescription: Loose\n---\n",
    // Copilot CLI's namespaced skills are grouped under their first folder, as resources.
    ".github/skills/web/e2e/SKILL.md": "---\nname: e2e\ndescription: End-to-end tests\n---\n",
    "REVIEW.md": "Flag missing tests in every review.\n",
    ".github/hooks/policy.json": '{"version":1,"hooks":{"preToolUse":[]}}\n',
    ".github/copilot/settings.json": '{"hooks":{}}\n',
    ".github/mcp.json": '{"mcpServers":{"docs":{"url":"https://example.invalid/mcp"}}}\n',
    ".vscode/mcp.json": '{"servers":{"docs":{"url":"https://example.invalid/mcp"}}}\n',
    ".github/workflows/copilot-setup-steps.yml": "jobs:\n  copilot-setup-steps:\n    runs-on: ubuntu-latest\n",
    ".github/workflows/copilot-code-review.yml": "jobs:\n  copilot-setup-steps:\n    runs-on: ubuntu-latest\n",
    "packages/web/.github/copilot-instructions.md": "Web package conventions.\n",
    // Hooks are read from the repository root only.
    "packages/web/.github/hooks/local.json": '{"version":1,"hooks":{}}\n',
  };
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Strata Test");
    git("config", "user.email", "strata-test@example.invalid");
    put("AGENTS.md", "Shared project instructions.\n");
    put("CLAUDE.md", "Claude project memory.\n");
    put("GEMINI.md", "Gemini project context.\n");
    put(".claude/skills/review/SKILL.md", "Review the change.\n");
    put(".claude/rules/style.md", "Use two spaces.\n");
    put(".claude/agents/reviewer.md", "---\nname: reviewer\ndescription: Reviews\n---\nReview.\n");
    put(".agents/skills/release/SKILL.md", "---\nname: release\ndescription: Cut a release\n---\nBody.\n");
    put(".mcp.json", '{"mcpServers":{}}\n');
    // Claude Code's Code Review reads REVIEW.md at any depth; VS Code skips a rules README.
    put("docs/REVIEW.md", "Review checks for the docs folder.\n");
    put(".claude/rules/README.md", "How we write rules.\n");
    // Ordinary GitHub and editor files are not Copilot configuration.
    put(".github/workflows/ci.yml", "jobs:\n  test:\n    runs-on: ubuntu-latest\n");
    put(".github/ISSUE_TEMPLATE/bug.md", "Describe the bug.\n");
    put(".github/pull_request_template.md", "What changed?\n");
    put(".vscode/settings.json", "{}\n");
    commit("Claude, Codex, and Gemini only");

    // A history without Copilot configuration never mentions Copilot.
    const withoutCopilot = await analyzeRepository(repo);
    assert.ok(!JSON.stringify([withoutCopilot.components, withoutCopilot.revisions]).includes("copilot"));
    const first = new Map(expandRevisions(withoutCopilot)[0].components.map((c) => [c.path, c]));
    assert.deepEqual([...first.keys()].sort(), [
      ".agents/skills/release/SKILL.md",
      ".claude/agents/reviewer.md",
      ".claude/rules/README.md",
      ".claude/rules/style.md",
      ".claude/skills/review/SKILL.md",
      ".mcp.json",
      "AGENTS.md",
      "CLAUDE.md",
      "GEMINI.md",
      "docs/REVIEW.md",
    ]);
    assert.deepEqual(first.get("AGENTS.md").readers, ["claude", "codex"]);
    for (const path of ["CLAUDE.md", "GEMINI.md", ".claude/skills/review/SKILL.md", ".mcp.json", "docs/REVIEW.md"]) {
      assert.equal(first.get(path).readers, undefined, path);
    }
    const withoutUi = loadReportUi(renderHtml(withoutCopilot)).get;
    assert.ok(!withoutUi("provider-tabs").children.some((tab) => tab.textContent.startsWith("Copilot")));

    for (const [path, content] of Object.entries(copilotFiles)) put(path, content);
    // A Cursor rule that outlives the Copilot files: each tool's condition is its own.
    put(".cursor/rules/style.mdc", "---\nalwaysApply: true\n---\nUse two spaces.\n");
    const adopted = commit("Adopt GitHub Copilot and Cursor");

    // The legacy chat mode becomes a custom agent; Git detects the move as a rename.
    git("mv", ".github/agents/legacy.chatmode.md", ".github/agents/terse.agent.md");
    put(".github/copilot-instructions.md", "Answer in British English. Keep answers short.\n");
    put("CLAUDE.md", "Claude project memory, now longer.\n");
    const migrated = commit("Migrate the chat mode");

    rmSync(join(repo, "REVIEW.md"));
    rmSync(join(repo, ".vscode/mcp.json"));
    rmSync(join(repo, "packages"), { recursive: true, force: true });
    for (const path of Object.keys(copilotFiles).filter((path) => path.startsWith(".github/"))) {
      rmSync(join(repo, path), { force: true });
    }
    rmSync(join(repo, ".github/agents/terse.agent.md"));
    commit("Stop using Copilot");

    const sentBodies = [];
    const report = await analyzeRepository(repo, {
      providerCounts: {
        claudeModel: "claude-test-model",
        geminiModel: "gemini-test-model",
        anthropicApiKey: "anthropic-test-key",
        geminiApiKey: "gemini-test-key",
        fetchImpl: async (url, init) => {
          sentBodies.push(init.body);
          return new Response(JSON.stringify(url.includes("anthropic") ? { input_tokens: 7 } : { totalTokens: 9 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      },
    });
    assertLineAgesMatchTrees(repo, report);
    assert.equal(report.schemaVersion, 19);
    const revisions = expandRevisions(report);
    const labels = (revision) =>
      Object.fromEntries(
        revision.components.map((component) => [
          component.path,
          [component.provider, component.category, component.estimatedTokens === null ? "source" : "text"],
        ]),
      );
    assert.deepEqual(labels(revisions[1]), {
      ".agents/skills/release/SKILL.md": ["shared", "skills", "text"],
      ".claude/agents/reviewer.md": ["claude", "agents", "text"],
      ".claude/rules/README.md": ["claude", "rules", "text"],
      ".claude/rules/style.md": ["claude", "rules", "text"],
      ".claude/skills/review/SKILL.md": ["claude", "skills", "text"],
      ".cursor/rules/style.mdc": ["cursor", "rules", "text"],
      ".github/agents/README.md": ["copilot", "other", "source"],
      ".github/agents/legacy.chatmode.md": ["copilot", "agents", "text"],
      ".github/agents/reviewer.agent.md": ["copilot", "agents", "text"],
      ".github/agents/team/planner.md": ["copilot", "agents", "text"],
      ".github/chatmodes/old.chatmode.md": ["copilot", "other", "source"],
      ".github/copilot-instructions.md": ["copilot", "instructions", "text"],
      ".github/copilot/settings.json": ["copilot", "settings", "source"],
      ".github/hooks/policy.json": ["copilot", "settings", "source"],
      ".github/instructions/README.md": ["copilot", "other", "source"],
      ".github/instructions/frontend/react.instructions.md": ["copilot", "rules", "text"],
      ".github/mcp.json": ["copilot", "tools", "source"],
      ".github/prompts/drafts/old.prompt.md": ["copilot", "other", "source"],
      ".github/prompts/release.prompt.md": ["copilot", "commands", "text"],
      ".github/skills/SKILL.md": ["copilot", "other", "source"],
      ".github/skills/draft/SKILL.md": ["copilot", "skills", "text"],
      ".github/skills/webapp-testing/SKILL.md": ["copilot", "skills", "text"],
      ".github/skills/web/e2e/SKILL.md": ["copilot", "skills", "source"],
      ".github/skills/webapp-testing/run.sh": ["copilot", "skills", "source"],
      ".github/workflows/copilot-code-review.yml": ["copilot", "settings", "source"],
      ".github/workflows/copilot-setup-steps.yml": ["copilot", "settings", "source"],
      ".mcp.json": ["claude", "tools", "source"],
      ".vscode/mcp.json": ["copilot", "tools", "source"],
      "AGENTS.md": ["shared", "instructions", "text"],
      "CLAUDE.md": ["claude", "instructions", "text"],
      "GEMINI.md": ["gemini", "instructions", "text"],
      "REVIEW.md": ["claude", "instructions", "text"],
      "docs/REVIEW.md": ["claude", "instructions", "text"],
      "packages/web/.github/copilot-instructions.md": ["copilot", "instructions", "text"],
    });
    const byPath = new Map(revisions[1].components.map((component) => [component.path, component]));
    assert.deepEqual(
      revisions[1].components.filter((component) => component.legacy).map((component) => component.path),
      [".github/agents/legacy.chatmode.md"],
    );
    assert.deepEqual(byPath.get("AGENTS.md").readers, ["claude", "codex", "copilot", "cursor"]);
    assert.deepEqual(byPath.get(".agents/skills/release/SKILL.md").readers, ["codex", "copilot", "cursor", "gemini"]);
    assert.deepEqual(byPath.get(".claude/skills/review/SKILL.md").readers, ["claude", "copilot", "cursor"]);
    assert.deepEqual(byPath.get("GEMINI.md").readers, ["copilot", "gemini"]);
    for (const path of [
      "CLAUDE.md",
      "REVIEW.md",
      "docs/REVIEW.md",
      ".claude/rules/style.md",
      ".claude/agents/reviewer.md",
      ".mcp.json",
    ]) {
      assert.deepEqual(byPath.get(path).readers, ["claude", "copilot"], path);
    }
    assert.equal(byPath.get(".claude/rules/README.md").readers, undefined);

    // Copilot reads the other tools' files only while the revision tracks Copilot files.
    const borrowed = (index) =>
      viewRevision(revisions[index], "copilot", revisions[index - 1], report.components)
        .components.filter((component) => component.provider !== "copilot")
        .map((component) => component.path)
        .sort();
    assert.deepEqual(borrowed(0), []);
    assert.deepEqual(borrowed(1), [
      ".agents/skills/release/SKILL.md",
      ".claude/agents/reviewer.md",
      ".claude/rules/style.md",
      ".claude/skills/review/SKILL.md",
      ".mcp.json",
      "AGENTS.md",
      "CLAUDE.md",
      "GEMINI.md",
      "REVIEW.md",
      "docs/REVIEW.md",
    ]);
    assert.deepEqual(borrowed(3), []);
    // Cursor, still configured after Copilot is removed, keeps reading AGENTS.md.
    assert.ok(viewRevision(revisions[3], "cursor").components.some((component) => component.path === "AGENTS.md"));
    const adoption = viewRevision(revisions[1], "copilot", revisions[0], report.components).changes;
    for (const path of ["AGENTS.md", "CLAUDE.md", "GEMINI.md"]) {
      assert.ok(
        adoption.some((change) => change.kind === "added" && change.path === path),
        path,
      );
    }
    const dropped = viewRevision(revisions[3], "copilot", revisions[2], report.components).changes;
    assert.ok(dropped.some((change) => change.kind === "removed" && change.path === "CLAUDE.md"));
    // GEMINI.md stays in the Gemini view by default.
    assert.ok(viewRevision(revisions[3], "gemini").components.some((component) => component.path === "GEMINI.md"));
    const shareableRevisions = expandRevisions(redactReport(report));
    assert.deepEqual(
      shareableRevisions.map((revision) => viewRevision(revision, "copilot").components.length),
      revisions.map((revision) => viewRevision(revision, "copilot").components.length),
    );
    // CLAUDE.md stays Claude's, not shared.
    assert.deepEqual(
      viewRevision(revisions[1], "shared").components.map((component) => component.path),
      [".agents/skills/release/SKILL.md", "AGENTS.md"],
    );

    // Copilot lists a skill by its name and description.
    const listing = (path) => byPath.get(path).skill.listing;
    assert.deepEqual(listing(".github/skills/webapp-testing/SKILL.md"), {
      status: "listed",
      tokens: Math.ceil(Buffer.byteLength("webapp-testing\nTest the web app in a browser") / 4),
    });
    assert.equal(listing(".github/skills/draft/SKILL.md").status, "unresolved");
    assert.deepEqual(
      revisions[1].skillGroups
        .filter((group) => group.provider === "copilot")
        .map(({ root, resourceCount }) => [root, resourceCount]),
      [
        [".github/skills/draft", 0],
        [".github/skills/web", 1],
        [".github/skills/webapp-testing", 1],
      ],
    );

    assert.equal(revisions[1].categoryTotals.instructions.count, 7);
    assert.equal(revisions[1].categoryTotals.agents.count, 4);
    assert.equal(revisions[1].categoryTotals.rules.count, 4);
    assert.equal(revisions[1].categoryTotals.commands.count, 1);
    assert.equal(revisions[1].categoryTotals.settings.sourceOnlyCount, 4);
    assert.equal(revisions[1].categoryTotals.tools.sourceOnlyCount, 3);
    assert.equal(revisions[1].categoryTotals.other.sourceOnlyCount, 5);

    assert.deepEqual(report.revisions[2].changes.map((change) => [change.kind, change.path]).sort(), [
      ["modified", ".github/copilot-instructions.md"],
      ["modified", "CLAUDE.md"],
      ["renamed", ".github/agents/terse.agent.md"],
    ]);
    const terse = revisions[2].components.find((component) => component.path === ".github/agents/terse.agent.md");
    assert.equal(terse.blob, byPath.get(".github/agents/legacy.chatmode.md").blob);
    assert.equal(terse.legacy, undefined);
    assert.ok(revisions[3].components.every((component) => component.provider !== "copilot"));

    // `strata diff` uses the same labels; a CLAUDE.md change stays in Claude's row.
    const delta = compareGitCommits(repo, adopted, migrated);
    assert.equal(delta.schemaVersion, 12);
    const chatmode = delta.comparison.components.find((c) => c.path === ".github/agents/legacy.chatmode.md");
    assert.deepEqual([chatmode.kind, chatmode.provider, chatmode.legacy], ["removed", "copilot", true]);
    const row = (key) => delta.comparison.byProvider.find((group) => group.key === key);
    assert.ok(row("copilot"));
    assert.equal(
      row("claude").deltaTokens,
      delta.comparison.components.find((c) => c.path === "CLAUDE.md").deltaTokens,
    );

    // Copilot has no count endpoint: its files keep the estimate and their text is never sent.
    assert.deepEqual(
      report.providerMeasurements.map((measured) => measured.provider),
      ["claude", "gemini"],
    );
    assert.ok(report.components.every((c) => c.provider !== "copilot" || !c.providerTokenCounts));
    assert.ok(report.components.every((c) => !("copilot" in (c.providerTokenCounts ?? {}))));
    assert.ok(sentBodies.some((body) => body.includes("Claude project memory.")));
    assert.ok(sentBodies.some((body) => body.includes("Gemini project context.")));
    assert.ok(sentBodies.some((body) => body.includes("Flag missing tests in every review.")));
    assert.ok(
      !sentBodies.some((body) =>
        /British English|Prefer hooks|release notes|maintainer|Break the task|Answer tersely|Web package|web app in a browser/.test(
          body,
        ),
      ),
    );

    const shareable = redactReport(report);
    assert.equal(shareable.components.filter((component) => component.legacy).length, 1);
    assert.ok(!JSON.stringify(shareable).includes("chatmode"));

    const { get } = loadReportUi(renderHtml(report));
    const copilotTab = get("provider-tabs").children.find((child) => child.textContent === "Copilot + shared");
    assert.ok(copilotTab);
    copilotTab.listeners.click();
    const paths = (id) => get(id).children.map((row) => row.children[0]?.textContent);
    get("target").value = "0";
    get("target").listeners.change();
    assert.ok(!paths("files").includes("CLAUDE.md"));
    get("target").value = "1";
    get("target").listeners.change();
    assert.ok(paths("files").includes("CLAUDE.md"));
    assert.match(get("view-note").textContent, /Copilot also reads AGENTS\.md, CLAUDE\.md, REVIEW\.md, GEMINI\.md/);
    assert.match(
      get("listing-note").textContent,
      /Copilot may summarize skills from \.claude\/skills or \.agents\/skills differently/,
    );
    assert.ok(get("files").children.some((row) => row.children[2]?.textContent === "agents (legacy)"));
    get("target").value = "3";
    get("target").listeners.change();
    assert.ok(!paths("files").includes("CLAUDE.md"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("draws instruction age by period, marks a shallow start, and follows the keyboard and the baseline", async () => {
  const repos = [];
  /** A repository with one commit per entry, each writing its files at its date. */
  const history = (commits) => {
    const repo = mkdtempSync(join(tmpdir(), "strata-age-ui-"));
    repos.push(repo);
    const git = (args, date) =>
      execFileSync("git", ["-C", repo, ...args], {
        encoding: "utf8",
        env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      });
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.name", "Strata Test"]);
    git(["config", "user.email", "strata-test@example.invalid"]);
    for (const [index, { date, files }] of commits.entries()) {
      for (const [path, content] of Object.entries(files)) writeFileSync(join(repo, path), content);
      git(["add", "-A"], date);
      git(["commit", "-q", "-m", `commit ${index}`], date);
    }
    return analyzeRepository(repo);
  };
  try {
    // One line a year for ten years; the first is long enough to hold half the text alone.
    const lines = [];
    const report = await history(
      Array.from({ length: 10 }, (_, year) => {
        lines.push(year ? `Line ${year}.` : `First line, ${"long ".repeat(12)}enough.`);
        return { date: `${2010 + year}-06-01T12:00:00Z`, files: { "CLAUDE.md": `${lines.join("\n")}\n` } };
      }),
    );
    const dates = report.revisions.map((revision) => revision.date.slice(0, 10));

    // More than eight years keeps one layer a year; in a shallow clone the first is "or earlier".
    const shallow = { ...report, shallow: true };
    const { get } = loadReportUi(renderHtml(shallow));
    assert.equal(get("age-panel").hidden, false);
    const chart = get("age-chart");
    assert.equal(chart.children.length, 10);
    assert.equal(get("age-start").textContent, dates[0]);
    assert.equal(get("age-end").textContent, dates[9]);
    const legend = get("age-legend").children.map((entry) => entry.textContent);
    assert.deepEqual(
      legend,
      Array.from({ length: 10 }, (_, index) => `${2019 - index}${index === 9 ? " or earlier" : ""}`),
    );
    assert.match(chart.children[0].title, /from 2010 or earlier$/);
    // Each layer names its period and share; the last bar has one layer per year.
    const layers = chart.children[9].children[0].children;
    assert.equal(layers.length, 10);
    assert.match(layers[0].title, /^Revision 10 · \d+% from 2010 or earlier$/);
    assert.match(layers[9].title, /^Revision 10 · \d+% from 2019$/);
    assert.equal(
      get("age-count").textContent,
      `half added by ${dates[0]} or earlier · 100% of the ${dates[0]} text still there`,
    );
    assert.match(
      get("age-note").textContent,
      /This shallow clone starts at revision 1, so text dated there may be older\.$/,
    );

    // Arrow keys and End move the selection along the age chart and keep focus on its bars.
    const press = (key, target) => chart.listeners.keydown({ key, target, preventDefault() {} });
    press("Home", chart.children[9]);
    assert.equal(get("target").value, "0");
    press("ArrowRight", chart.children[0]);
    assert.equal(get("target").value, "1");
    assert.equal(chart.children[1].focused, true);
    press("End", chart.children[1]);
    assert.equal(get("target").value, "9");

    // A fixed baseline is marked on both charts, and still is after a provider tab redraws the history chart.
    const marked = (bars) => bars.map((bar) => bar.classes.has("baseline"));
    const atTwo = Array.from({ length: 10 }, (_, index) => index === 2);
    get("baseline").value = "2";
    get("baseline").listeners.change();
    assert.deepEqual(marked(chart.children), atTwo);
    assert.deepEqual(marked(get("chart").children), atTwo);
    assert.match(get("compare-kept").textContent, /^100% of /);
    get("provider-tabs").children[1].listeners.click();
    assert.deepEqual(marked(get("chart").children), atTwo);
    assert.deepEqual(marked(chart.children), atTwo);
    assert.match(get("age-count").textContent, / · all files$/);
    get("provider-tabs").children[0].listeners.click();
    assert.doesNotMatch(get("age-count").textContent, /all files/);
    // "Previous revision" marks nothing.
    get("baseline").value = "previous";
    get("baseline").listeners.change();
    assert.ok(chart.children.every((bar) => !bar.classes.has("baseline")));
    assert.ok(get("chart").children.every((bar) => !bar.classes.has("baseline")));

    // A full clone has no "or earlier"; a year of monthly commits is drawn by quarter.
    const monthly = {
      ...report,
      revisions: report.revisions.map((revision, index) => ({
        ...revision,
        date: `2026-${String(index + 1).padStart(2, "0")}-15T12:00:00Z`,
      })),
    };
    const quarters = loadReportUi(renderHtml(monthly)).get;
    assert.deepEqual(
      quarters("age-legend").children.map((entry) => entry.textContent),
      ["2026 Q4", "2026 Q3", "2026 Q2", "2026 Q1"],
    );
    assert.match(quarters("age-count").textContent, /^half added by 2026-01-15 · /);
    assert.doesNotMatch(quarters("age-note").textContent, /shallow/);

    // Without instruction text the panel stays hidden.
    const silent = { ...report, revisions: report.revisions.map(({ lineAge: _lineAge, ...revision }) => revision) };
    assert.equal(loadReportUi(renderHtml(silent)).get("age-panel").hidden, true);

    // A shallow history whose first revision has no instruction text dates nothing "or earlier".
    const late = await history([
      { date: "2026-03-02T12:00:00Z", files: { "README.md": "Readme.\n" } },
      { date: "2026-03-03T12:00:00Z", files: { "CLAUDE.md": "Short.\n" } },
    ]);
    const lateUi = loadReportUi(renderHtml({ ...late, shallow: true })).get;
    assert.deepEqual(
      lateUi("age-legend").children.map((entry) => entry.textContent),
      ["Week of 2026-03-02"],
    );
    assert.doesNotMatch(lateUi("age-count").textContent, /or earlier/);
    assert.doesNotMatch(lateUi("age-note").textContent, /shallow|or earlier/);

    // The period holding the first revision is "or earlier", but a median at a later revision in it is not.
    const sameWeek = await history([
      { date: "2026-03-02T12:00:00Z", files: { "CLAUDE.md": "Short.\n" } },
      { date: "2026-03-03T12:00:00Z", files: { "CLAUDE.md": `Short.\n${"A much longer line. ".repeat(4)}\n` } },
    ]);
    const sameWeekUi = loadReportUi(renderHtml({ ...sameWeek, shallow: true })).get;
    assert.deepEqual(
      sameWeekUi("age-legend").children.map((entry) => entry.textContent),
      ["Week of 2026-03-02 or earlier"],
    );
    assert.match(sameWeekUi("age-count").textContent, /^half added by 2026-03-03 · /);
    assert.match(sameWeekUi("age-note").textContent, /This shallow clone starts at revision 1/);
  } finally {
    for (const repo of repos) rmSync(repo, { recursive: true, force: true });
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

test("treemap frame keeps category gaps, seams, and headers in drawn units", () => {
  const component = (path, category, estimatedTokens) => ({
    path,
    provider: "shared",
    category,
    blob: path,
    bytes: estimatedTokens * 4,
    estimatedTokens,
  });
  const components = [
    ...Array.from({ length: 12 }, (_, index) => component(`skills/s${index}/SKILL.md`, "skills", 400 + index * 50)),
    ...Array.from({ length: 8 }, (_, index) => component(`agents/a${index}.md`, "agents", 300 + index * 40)),
    component("CLAUDE.md", "instructions", 60),
  ];
  const frame = { width: 1150, height: 390, gap: 4, seam: 1, header: 22, wide: 2 };
  const layout = layoutTreemap(components, frame);
  const inside = (inner, outer) =>
    inner.x >= outer.x - 1e-6 &&
    inner.y >= outer.y - 1e-6 &&
    inner.x + inner.width <= outer.x + outer.width + 1e-6 &&
    inner.y + inner.height <= outer.y + outer.height + 1e-6;
  for (const group of layout.groups) {
    assert.ok(inside(group, { x: 0, y: 0, width: frame.width, height: frame.height }));
    for (const leaf of group.leaves) {
      assert.ok(inside(leaf, group));
      // A headed category keeps its band clear of files.
      if (group.headed) assert.ok(leaf.y >= group.y + frame.header - 1e-6);
    }
  }
  // Large categories are named; one too small to spare the band is not.
  assert.equal(layout.groups.find((group) => group.category === "skills").headed, true);
  assert.equal(layout.groups.find((group) => group.category === "instructions").headed, false);
  // Categories never touch: each pair is at least the gap apart on one axis.
  const [first, second] = layout.groups;
  const apart = (a, b) =>
    Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width), b.y - (a.y + a.height), a.y - (b.y + b.height));
  assert.ok(apart(first, second) >= frame.gap - 1e-6);
  // Without a frame the layout is unchanged: areas are exact shares of a 100 by 100 square.
  const plain = layoutTreemap(components);
  for (const leaf of plain.groups.flatMap((group) => group.leaves)) {
    assert.ok(Math.abs((leaf.width * leaf.height) / 10000 - leaf.estimatedTokens / plain.totalTokens) < 1e-9);
  }
  assert.ok(plain.groups.every((group) => !group.headed));
  // Wide tiles leave room for a file name on one line.
  const wideLeaves = layout.groups.flatMap((group) => group.leaves);
  const squareLeaves = layoutTreemap(components, { ...frame, wide: 1 }).groups.flatMap((group) => group.leaves);
  const meanAspect = (leaves) => leaves.reduce((sum, leaf) => sum + leaf.width / leaf.height, 0) / leaves.length;
  assert.ok(meanAspect(wideLeaves) > meanAspect(squareLeaves));
});

test("the imports table says where an import past the depth limit points", async () => {
  const repo = mkdtempSync(join(tmpdir(), "strata-import-depth-"));
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  try {
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Strata Test");
    git("config", "user.email", "strata-test@example.invalid");
    git("config", "commit.gpgsign", "false");
    // CLAUDE.md reaches d.md in four hops, so d.md's own imports are past the limit.
    writeFileSync(join(repo, "CLAUDE.md"), "@a.md\n@~/.claude/near.md\n");
    writeFileSync(join(repo, "a.md"), "@b.md\n");
    writeFileSync(join(repo, "b.md"), "@c.md\n");
    writeFileSync(join(repo, "c.md"), "@d.md\n");
    writeFileSync(join(repo, "d.md"), "@~/.claude/me.md\n@nowhere.md\n");
    git("add", "-A");
    git("commit", "-q", "-m", "chain");
    const ui = loadReportUi(renderHtml(await analyzeRepository(repo)));
    const rows = ui.get("imports").children.map((row) => row.children.map((cell) => cell.textContent));
    assert.deepEqual(
      rows.filter((cells) => cells[4] !== "resolved"),
      [
        // Within the limit the status already says where it points, so the Imports cell is empty.
        ["CLAUDE.md", "2", "—", "1", "outside the repository"],
        ["d.md", "1", "outside the repository", "5", "too deep"],
        ["d.md", "2", "not a tracked path", "5", "too deep"],
      ],
    );
    const cli = spawnSync(process.execPath, ["dist/cli.js", "analyze", repo, "--format", "json", "--output", "-"], {
      encoding: "utf8",
    });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(
      cli.stderr,
      /3 Claude @path imports are unresolved at the last revision \(1 outside the repository, 2 beyond four hops \(1 points outside the repository\)\)/,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("resolves Claude @path imports per revision against the tracked tree", async () => {
  const { treeImports } = await import("../dist/claude-imports.js");
  const { listTree } = await import("../dist/git.js");
  const { trackedFile } = await import("../dist/inventory.js");
  const { importLinks } = await import("../dist/import-links.js");
  const repo = mkdtempSync(join(tmpdir(), "strata-imports-"));
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  const put = (path, content) => {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), content);
  };
  const commit = (message) => {
    git("add", "-A");
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  const at = (revision) =>
    Object.fromEntries(revision.components.map((component) => [component.path, component.imported ? "imported" : ""]));
  const links = (revision) =>
    importLinks(revision.components).map(({ source, target, status }) => `${source} -> ${target} ${status}`);
  try {
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Strata Test");
    git("config", "user.email", "strata-test@example.invalid");
    git("config", "commit.gpgsign", "false");
    // With one path to follow, this setting would otherwise make Git report renames.
    git("config", "log.follow", "true");
    put("CLAUDE.md", "@AGENTS.md\n@docs/guide.md\n- personal @~/.claude/me.md\n@docs/missing.md\n`@docs/unused.md`\n");
    put("AGENTS.md", "Shared.\n@docs/shared.md\n");
    put(".claude/CLAUDE.md", "@../package.json\n");
    put("docs/guide.md", "Guide.\n@nested/deep.md\n");
    put("docs/nested/deep.md", "Deep.\n");
    put("docs/shared.md", "Shared doc.\n");
    put("docs/unused.md", "Never imported.\n");
    put("package.json", "{}\n");
    const first = commit("Import docs");
    put("docs/guide.md", "Guide, longer now.\n@nested/deep.md\n");
    put("docs/missing.md", "Here at last.\n");
    const second = commit("Edit an imported file and add a missing one");
    put("CLAUDE.md", "@AGENTS.md\n- personal @~/.claude/me.md\n@docs/missing.md\n");
    const third = commit("Stop importing the guide");
    git("checkout", "-q", "-b", "feature");
    put("CLAUDE.md", "@AGENTS.md\n- personal @~/.claude/me.md\n@docs/missing.md\n@docs/feature.md\n");
    put("docs/feature.md", "Feature notes.\n");
    put("docs/missing.md", "Edited on the branch.\n");
    commit("Import feature notes");
    git("checkout", "-q", "main");
    put("README.md", "Unrelated.\n");
    commit("Unrelated change on main");
    git("merge", "-q", "--no-ff", "feature", "-m", "Merge feature");
    git("mv", "docs/shared.md", "docs/common.md");
    put("AGENTS.md", "Shared.\n@docs/common.md\n");
    commit("Rename the shared doc");
    rmSync(join(repo, "docs/common.md"));
    symlinkSync("../README.md", join(repo, "docs/common.md"));
    commit("Replace the shared doc with a symlink");
    put(
      "CLAUDE.md",
      "@AGENTS.md\n@docs/missing.md\n@docs/feature.md\n@.claude/rules/style.md\nAsk @alice, or see @docs and @.claude/ or @.\n",
    );
    put(".claude/rules/style.md", "Style.\n@../../docs/from-rule.md\n");
    put("docs/from-rule.md", "Imported by a rule.\n@deep/one.md\n");
    put("docs/deep/one.md", "@two.md\n");
    put("docs/deep/two.md", "@three.md\n");
    put("docs/deep/three.md", "Too deep.\n");
    // Claude Code's Code Review reads REVIEW.md, but sessions do not load it, so its imports are not expanded.
    put("REVIEW.md", "@docs/review-only.md\n");
    put("docs/review-only.md", "Review notes.\n");
    commit("Import a rule that imports a doc");

    const report = await analyzeRepository(repo);
    assertLineAgesMatchTrees(repo, report);
    assert.equal(report.schemaVersion, 19);
    const revisions = expandRevisions(report);
    assert.equal(revisions.length, 8);

    // Imported files no path rule recognizes join the inventory; Markdown is measured, anything else is source-only.
    assert.deepEqual(at(revisions[0]), {
      ".claude/CLAUDE.md": "",
      "AGENTS.md": "",
      "CLAUDE.md": "",
      "docs/guide.md": "imported",
      "docs/nested/deep.md": "imported",
      "docs/shared.md": "imported",
      "package.json": "imported",
    });
    const guide = revisions[0].components.find((component) => component.path === "docs/guide.md");
    assert.deepEqual(
      [guide.provider, guide.category, guide.estimatedTokens, guide.imports],
      [
        "claude",
        "instructions",
        Math.ceil("Guide.\n@nested/deep.md\n".length / 4),
        [{ line: 2, target: "docs/nested/deep.md" }],
      ],
    );
    const manifest = revisions[0].components.find((component) => component.path === "package.json");
    assert.deepEqual([manifest.category, manifest.estimatedTokens, manifest.imports], ["other", null, undefined]);
    assert.deepEqual(revisions[0].components.find((component) => component.path === "CLAUDE.md").imports, [
      { line: 1, target: "AGENTS.md" },
      { line: 2, target: "docs/guide.md" },
      { line: 3, target: null, external: true },
      { line: 4, target: "docs/missing.md" },
    ]);
    // CLAUDE.md imports AGENTS.md, so AGENTS.md is a hop on its chain rather than a chain of its own.
    assert.deepEqual(links(revisions[0]), [
      ".claude/CLAUDE.md -> package.json resolved",
      "CLAUDE.md -> AGENTS.md resolved",
      "CLAUDE.md -> docs/guide.md resolved",
      "CLAUDE.md -> null external",
      "CLAUDE.md -> docs/missing.md missing",
      "AGENTS.md -> docs/shared.md resolved",
      "docs/guide.md -> docs/nested/deep.md resolved",
    ]);
    assert.equal(revisions[0].categoryTotals.instructions.count, 6);
    assert.equal(revisions[0].categoryTotals.other.sourceOnlyCount, 1);

    // An edit to an imported file is a modification; a file that appears where an import pointed is added.
    const kinds = (revision) => revision.changes.map(({ kind, path }) => `${kind} ${path}`);
    assert.deepEqual(kinds(revisions[1]), ["modified docs/guide.md", "added docs/missing.md"]);
    assert.ok(links(revisions[1]).includes("CLAUDE.md -> docs/missing.md resolved"));
    // Dropping an import removes the files it reached from the inventory, though they remain in Git.
    assert.deepEqual(kinds(revisions[2]), [
      "modified CLAUDE.md",
      "removed docs/guide.md",
      "removed docs/nested/deep.md",
    ]);
    // A branch's import arrives with the merge, compared with its first parent.
    assert.deepEqual(kinds(revisions[3]), []);
    assert.deepEqual(kinds(revisions[4]), ["modified CLAUDE.md", "added docs/feature.md", "modified docs/missing.md"]);
    // A rename shows as a removal and an addition.
    assert.deepEqual(kinds(revisions[5]), ["modified AGENTS.md", "added docs/common.md", "removed docs/shared.md"]);
    // A symlink is not a tracked file, so the import no longer resolves.
    assert.deepEqual(kinds(revisions[6]), ["removed docs/common.md"]);
    assert.ok(links(revisions[6]).includes("AGENTS.md -> docs/common.md missing"));
    // A recognized rule reached by an import passes its own imports on.
    assert.equal(at(revisions[7])["docs/from-rule.md"], "imported");
    assert.equal(at(revisions[7])[".claude/rules/style.md"], "");
    assert.ok(links(revisions[7]).includes(".claude/rules/style.md -> docs/from-rule.md resolved"));
    // `.claude/CLAUDE.md` resolves `../package.json` from its own directory.
    assert.equal(at(revisions[7])["package.json"], "imported");
    assert.equal(at(revisions[7])["docs/unused.md"], undefined);
    // A chain stops after four hops; the file a fifth would reach stays out.
    assert.equal(at(revisions[7])["docs/deep/two.md"], "imported");
    assert.equal(at(revisions[7])["docs/deep/three.md"], undefined);
    assert.ok(links(revisions[7]).includes("docs/deep/two.md -> docs/deep/three.md depth-limit"));
    // A mention of a path no file has keeps its line but not its text; a directory names no file.
    const last = revisions[7].components.find((component) => component.path === "CLAUDE.md");
    assert.deepEqual(last.imports.slice(4), [
      { line: 5, target: null },
      { line: 5, target: null },
      { line: 5, target: null },
      { line: 5, target: null },
    ]);
    assert.doesNotMatch(JSON.stringify(report), /alice/);
    assert.equal(at(revisions[7])["docs/guide.md"], undefined);
    assert.equal(at(revisions[7])["REVIEW.md"], "");
    assert.equal(at(revisions[7])["docs/review-only.md"], undefined);
    assert.ok(!links(revisions[7]).some((link) => link.startsWith("REVIEW.md")));

    // Every revision's inventory matches resolving the imports of that commit's own tree.
    for (const revision of revisions) {
      const tree = listTree(repo, revision.id);
      const recognized = tree.flatMap(({ mode, blob, path }) => trackedFile(mode, blob, path) ?? []);
      const expected = [...recognized, ...treeImports(repo, tree, recognized, new Map())]
        .map(({ path, blob }) => `${path} ${blob}`)
        .sort();
      assert.deepEqual(revision.components.map(({ path, blob }) => `${path} ${blob}`).sort(), expected);
    }

    // `strata diff` resolves imports in both trees the same way.
    const delta = compareGitCommits(repo, second, third);
    assert.deepEqual(delta.comparison.components.map(({ path, kind }) => `${kind} ${path}`).sort(), [
      "edited CLAUDE.md",
      "removed docs/guide.md",
      "removed docs/nested/deep.md",
    ]);
    assert.ok(
      compareGitCommits(repo, first, second).comparison.components.some(({ path }) => path === "docs/missing.md"),
    );
    assert.ok(delta.comparison.components.every((component) => component.path === "CLAUDE.md" || component.imported));
    assert.match(renderPullRequestDelta(delta), /\| docs\/guide\.md \| removed \(imported\) \|/);

    // A shareable report aliases import targets with the same aliases as paths, including targets no file has.
    const shareable = redactReport(report);
    assert.doesNotMatch(JSON.stringify(shareable), /docs\/|package\.json|\.claude\//);
    const redacted = expandRevisions(shareable);
    for (const [index, revision] of revisions.entries()) {
      assert.deepEqual(
        importLinks(redacted[index].components).map(({ status }) => status),
        importLinks(revision.components).map(({ status }) => status),
      );
    }

    // The HTML report lists the selected revision's imports, unresolved ones first.
    const ui = loadReportUi(renderHtml(report));
    assert.equal(ui.get("imports-panel").hidden, false);
    assert.equal(ui.get("imports").children.length, importLinks(revisions[7].components).length);
    assert.deepEqual(
      ui.get("imports").children[0].children.map((cell) => cell.textContent),
      ["AGENTS.md", "2", "docs/common.md", "2", "missing"],
    );
    assert.equal(ui.get("imports-count").textContent, "14 · 6 unresolved");
    // The configuration map draws the files in folders, with a line for each resolved import between two of them.
    const lastLinks = importLinks(revisions[7].components);
    const expectedMap = configMap(revisions[7].components, lastLinks);
    const mapRows = () => ui.get("config-map").children.filter((child) => child.className.startsWith("map-row"));
    // Rows share listeners on the map, as in the browser, so events are sent there with the row as target.
    const onMap = (type, target) => ui.get("config-map").listeners[type]({ target });
    const mapRow = (path, map = expectedMap) => mapRows()[map.rows.findIndex((row) => row.path === path)];
    const mapLines = () =>
      ui
        .get("config-map")
        .children.find((child) => child.className === "map-gutter")
        .children.filter((child) => child.className === "map-arc");
    assert.equal(mapRows().length, expectedMap.rows.length);
    assert.equal(mapLines().length, expectedMap.edges.length);
    assert.ok(expectedMap.edges.length >= 5);
    assert.match(ui.get("map-hover").textContent, / import lines · 6 unresolved, listed under Claude imports\./);
    // A row's detail line names what the file imports and what imports it.
    onMap("focusin", mapRow("CLAUDE.md"));
    assert.match(
      ui.get("map-hover").textContent,
      /^CLAUDE\.md · claude \/ instructions · \d+ stored-text tokens · imports AGENTS\.md, docs\/missing\.md, docs\/feature\.md and 1 more · edited at this revision · 4 unresolved imports$/,
    );
    onMap("mouseover", mapRow("docs/from-rule.md").children[0]);
    assert.match(
      ui.get("map-hover").textContent,
      / · imports docs\/deep\/one\.md · imported by \.claude\/rules\/style\.md · added at this revision$/,
    );
    // Leaving a row with the mouse goes back to the focused row's detail.
    mapRow("CLAUDE.md").focus();
    onMap("mouseleave");
    assert.match(ui.get("map-hover").textContent, /^CLAUDE\.md · /);
    // Losing focus goes back to the row under the pointer.
    onMap("mouseover", mapRow("docs/from-rule.md"));
    onMap("focusout", mapRow("CLAUDE.md"));
    assert.match(ui.get("map-hover").textContent, /^docs\/from-rule\.md · /);
    // Selecting a folder closes it; the lines of the files it holds then end at its row.
    const docsRow = expectedMap.rows.findIndex((row) => row.path === "docs");
    onMap("click", mapRows()[docsRow].children[0]);
    const closedMap = configMap(revisions[7].components, lastLinks, { toggled: new Map([["docs", true]]) });
    assert.ok(closedMap.rows[docsRow].collapsed);
    assert.equal(mapRows().length, closedMap.rows.length);
    assert.ok(mapRows().length < expectedMap.rows.length);
    assert.equal(mapLines().length, closedMap.edges.length);
    assert.ok(closedMap.folded > 0);
    assert.equal(mapRows()[docsRow].focused, true);
    // Arrow keys open a closed folder, then move into it; the open and close buttons reset every folder.
    const press = (key, map, path) =>
      ui.get("config-map").listeners.keydown({
        key,
        target: mapRows()[map.rows.findIndex((row) => row.path === path)],
        preventDefault() {},
      });
    press("ArrowRight", closedMap, "docs");
    assert.equal(mapRows().length, expectedMap.rows.length);
    press("ArrowRight", expectedMap, "docs");
    assert.equal(mapRows()[docsRow + 1].focused, true);
    press("ArrowLeft", expectedMap, "docs");
    assert.equal(mapRows().length, closedMap.rows.length);
    // Keys pressed with Alt, Ctrl, or Cmd are left to the browser.
    ui.get("config-map").listeners.keydown({
      key: "ArrowLeft",
      altKey: true,
      target: mapRows()[docsRow],
      preventDefault() {
        assert.fail("Alt+ArrowLeft was taken from the browser");
      },
    });
    assert.equal(mapRows().length, closedMap.rows.length);
    ui.get("map-collapse").listeners.click();
    assert.equal(
      mapRows().length,
      configMap(revisions[7].components, lastLinks, { fallback: "collapsed" }).rows.length,
    );
    ui.get("map-expand").listeners.click();
    assert.equal(mapRows().length, configMap(revisions[7].components, lastLinks, { fallback: "expanded" }).rows.length);
    // While the slider is dragged the map can show an earlier revision. Selecting a file there brings the map up
    // to date first, and locates the file only if the selected revision has it.
    const expandedMap = configMap(revisions[7].components, lastLinks, { fallback: "expanded" });
    const fromRule = () => expandedMap.rows.findIndex((row) => row.path === "docs/from-rule.md");
    const searched = ui.get("path-search").value;
    ui.get("slider").value = "0";
    ui.get("slider").listeners.input();
    onMap("click", mapRows()[fromRule()]);
    assert.ok(!revisions[0].components.some((component) => component.path === "docs/from-rule.md"));
    assert.equal(
      mapRows().length,
      configMap(revisions[0].components, importLinks(revisions[0].components), { fallback: "expanded" }).rows.length,
    );
    assert.equal(ui.get("path-search").value, searched);
    ui.get("slider").value = "7";
    ui.get("slider").listeners.change();
    // Settling again at the same revision keeps the rows already drawn.
    const drawnRow = mapRows()[0];
    ui.get("slider").listeners.change();
    assert.equal(mapRows()[0], drawnRow);
    onMap("click", mapRows()[fromRule()]);
    assert.equal(ui.get("path-search").value, "docs/from-rule.md");
    const importedRow = ui.get("files").children.find((row) => row.children[0].textContent === "docs/from-rule.md");
    assert.equal(importedRow.children[2].textContent, "instructions (imported)");
    // Selecting a file locates it in the file table, as the treemap does.
    onMap("click", mapRow("AGENTS.md", expandedMap));
    assert.equal(ui.get("files-panel").open, true);
    assert.equal(ui.get("path-search").value, "AGENTS.md");

    // Leaving a revision that tagged files for one that changed nothing clears the tags; moving on between
    // revisions that share an inventory and tag nothing keeps the rows already drawn.
    const quiet = (id) => ({ ...report.revisions.at(-1), id, changes: [] });
    const unchanged = { ...report, revisions: [...report.revisions, quiet("a".repeat(40)), quiet("b".repeat(40))] };
    const quietUi = loadReportUi(renderHtml(unchanged));
    const quietRows = () => quietUi.get("config-map").children.filter((child) => child.className.startsWith("map-row"));
    const tags = () =>
      quietRows().flatMap((row) => row.children[0].children.filter((child) => child.className === "map-tag"));
    quietUi.get("slider").value = String(unchanged.revisions.length - 3);
    quietUi.get("slider").listeners.change();
    assert.ok(tags().length > 0);
    quietUi.get("slider").value = String(unchanged.revisions.length - 2);
    quietUi.get("slider").listeners.change();
    assert.equal(tags().length, 0);
    const quietRow = quietRows()[0];
    quietUi.get("slider").value = String(unchanged.revisions.length - 1);
    quietUi.get("slider").listeners.change();
    assert.equal(quietRows()[0], quietRow);

    // The command line counts unresolved imports at the last revision without naming paths.
    const output = join(tmpdir(), `strata-imports-${process.pid}.json`);
    const cli = spawnSync(process.execPath, ["dist/cli.js", "analyze", repo, "--output", output, "--format", "json"], {
      encoding: "utf8",
    });
    rmSync(output, { force: true });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(
      cli.stderr,
      /Note: 6 Claude @path imports are unresolved at the last revision \(5 missing, 1 beyond four hops\); the report lists them\./,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("lists the MCP servers tracked files define, without storing their commands or URLs", async () => {
  const { codexServers, mcpServers } = await import("../dist/mcp-servers.js");
  const repo = mkdtempSync(join(tmpdir(), "strata-mcp-"));
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  const put = (path, content) => {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), content);
  };
  const commit = (message) => {
    git("add", "-A");
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  const secret = "sk-test-do-not-store";
  // A server name is repository text: Markdown and HTML must escape it, and control characters must not reach a terminal.
  const hostile = "a|b<i>\u001b[31m";
  const servers = (component) =>
    component.mcp.status === "listed"
      ? component.mcp.servers.map((server) => `${server.name}:${server.transport}${server.disabled ? ":off" : ""}`)
      : component.mcp.status;
  const at = (revision) =>
    Object.fromEntries(
      revision.components.filter((component) => component.mcp).map((component) => [component.path, servers(component)]),
    );
  try {
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Strata Test");
    git("config", "user.email", "strata-test@example.invalid");
    git("config", "commit.gpgsign", "false");
    put("CLAUDE.md", "Project memory.\n");
    // A Gemini or Codex settings file that does not mention MCP servers has no server list.
    put(".gemini/settings.json", '{"general":{"vimMode":true}}\n');
    put(".codex/config.toml", 'model = "o3"\n');
    const before = commit("No MCP servers");

    put(
      ".mcp.json",
      JSON.stringify({
        mcpServers: {
          github: { type: "http", url: "https://example.invalid/mcp", headers: { Authorization: secret } },
          files: { command: "npx", args: ["-y", "files-server"], env: { TOKEN: secret } },
        },
      }),
    );
    put(
      ".cursor/mcp.json",
      '{\n  // Cursor accepts comments and trailing commas.\n  "mcpServers": {"docs": {"url": "https://example.invalid/sse"},},\n}\n',
    );
    put(".vscode/mcp.json", '{"servers":{"local":{"type":"stdio","command":"node"}}}\n');
    put(
      ".gemini/settings.json",
      '{\n  // Gemini CLI strips comments.\n  "mcpServers": {"search": {"httpUrl": "https://example.invalid/mcp"}, "other": {"command": "x"}},\n  "mcp": {"excluded": ["other"]}\n}\n',
    );
    // Gemini CLI reads workspace settings at the root only, so nested settings list no servers.
    put("packages/app/.gemini/settings.json", '{"mcpServers": {"nested": {"command": "x"}}}\n');
    // Copilot CLI also reads servers at the top level, but a VS Code-shaped `servers` object is not one.
    put(
      ".github/mcp.json",
      JSON.stringify({ servers: { decoy: { command: "x" } }, [hostile]: { type: "local", command: "x" } }),
    );
    put(
      ".codex/config.toml",
      `model = "o3"\n\n[mcp_servers.files]\ncommand = "npx"\nargs = [\n  "-y",\n  "[not-a-table]",\n]\n\n[mcp_servers.files.env]\nTOKEN = "${secret}"\n\n[mcp_servers."paused docs"]\nurl = "https://example.invalid/mcp"\nenabled = false\n`,
    );
    commit("Add MCP servers");

    // Claude Code reads strict JSON, so a comment leaves its servers unresolved rather than none.
    put(
      ".mcp.json",
      '{\n  // not JSON\n  "mcpServers": {"github": {"type": "http", "url": "https://example.invalid/mcp"}}\n}\n',
    );
    commit("Break the Claude MCP file");

    put(".mcp.json", JSON.stringify({ mcpServers: { github: { type: "http", url: "https://example.invalid/mcp" } } }));
    rmSync(join(repo, ".vscode/mcp.json"));
    const head = commit("Drop the local servers");

    const report = await analyzeRepository(repo);
    const revisions = expandRevisions(report);
    assert.equal(report.schemaVersion, 19);
    assert.deepEqual(at(revisions[0]), {});
    assert.deepEqual(at(revisions[1]), {
      ".codex/config.toml": ["files:local", "paused docs:remote:off"],
      ".cursor/mcp.json": ["docs:remote"],
      ".gemini/settings.json": ["search:remote", "other:local:off"],
      ".github/mcp.json": [`${hostile}:local`],
      ".mcp.json": ["github:remote", "files:local"],
      ".vscode/mcp.json": ["local:local"],
    });
    assert.equal(at(revisions[2])[".mcp.json"], "unresolved");
    assert.deepEqual(at(revisions[3])[".mcp.json"], ["github:remote"]);
    assert.equal(at(revisions[3])[".vscode/mcp.json"], undefined);
    // MCP files stay source-only; only server names and where they run are kept.
    for (const component of report.components.filter((entry) => entry.mcp)) {
      assert.equal(component.estimatedTokens, null, component.path);
    }
    const json = JSON.stringify(report);
    for (const stored of [secret, "example.invalid", "npx", "files-server"]) assert.ok(!json.includes(stored), stored);

    // The comparison names servers by file, so one in two files counts twice; unreadable files are counted apart.
    const fromStart = compareRevisions(revisions[0], revisions[1]).mcp;
    assert.deepEqual(
      [fromStart.beforeServers, fromStart.afterServers, fromStart.added.map((ref) => `${ref.path}#${ref.name}`)],
      [
        0,
        9,
        [
          ".codex/config.toml#files",
          ".codex/config.toml#paused docs",
          ".cursor/mcp.json#docs",
          ".gemini/settings.json#other",
          ".gemini/settings.json#search",
          `.github/mcp.json#${hostile}`,
          ".mcp.json#files",
          ".mcp.json#github",
          ".vscode/mcp.json#local",
        ],
      ],
    );
    const broken = compareRevisions(revisions[1], revisions[2]).mcp;
    assert.deepEqual([broken.afterServers, broken.afterUnresolved, broken.removed.length], [7, 1, 2]);
    assert.equal(
      compareRevisions({ components: [], estimatedTokens: 0 }, { components: [], estimatedTokens: 0 }).mcp,
      undefined,
    );

    // `strata diff` says which servers a change adds or removes, and that defining one does not load it.
    const delta = compareGitCommits(repo, before, head);
    assert.equal(delta.schemaVersion, 12);
    const markdown = renderPullRequestDelta(delta);
    assert.match(
      markdown,
      /MCP servers the tracked files define: \*\*\+7\*\* \(0 → 7\)\. Added: files \(\.codex\/config\.toml\), paused docs \(\.codex\/config\.toml\), docs \(\.cursor\/mcp\.json\)/,
    );
    assert.ok(markdown.includes("a\\|b&lt;i&gt; \\[31m (.github/mcp.json)"));
    assert.ok(!markdown.includes("\u001b"));
    assert.match(markdown, /Defined is not loaded/);
    assert.ok(!markdown.includes(secret));

    // A shareable export aliases server names, the same name to the same alias.
    const shared = redactReport(report);
    const names = shared.components.flatMap((component) =>
      component.mcp?.status === "listed" ? component.mcp.servers.map((server) => server.name) : [],
    );
    assert.ok(names.length && names.every((name) => /^server-\d{5}$/.test(name)));
    assert.ok(!JSON.stringify(shared).includes("paused docs"));
    assert.equal(
      new Set(names).size,
      new Set(report.components.flatMap((component) => component.mcp?.servers?.map((server) => server.name) ?? []))
        .size,
    );

    // The HTML report lists the selected revision's servers, and the comparison names what was added.
    const html = renderHtml(report);
    assert.ok(!html.includes(secret));
    assert.ok(!html.includes("b<i>"));
    const ui = loadReportUi(html);
    assert.equal(ui.get("mcp-panel").hidden, false);
    assert.equal(ui.get("mcp-count").textContent, "7 servers · 5 files");
    assert.deepEqual(
      ui.get("mcp-servers").children.map((row) => row.children.map((cell) => cell.textContent).join(" | ")),
      [
        "files | local | .codex/config.toml | codex",
        "paused docs | remote (disabled) | .codex/config.toml | codex",
        "docs | remote | .cursor/mcp.json | cursor",
        "search | remote | .gemini/settings.json | gemini",
        "other | local (disabled) | .gemini/settings.json | gemini",
        `${hostile} | local | .github/mcp.json | copilot`,
        "github | remote | .mcp.json | claude",
      ],
    );
    assert.equal(ui.get("compare-mcp-wrap").hidden, false);
    assert.match(
      ui.get("compare-mcp-names").textContent,
      /^MCP servers added: github \(\.mcp\.json\)\. MCP servers removed: local \(\.vscode\/mcp\.json\)\.$/,
    );

    // Parsing follows each tool's format; anything outside it is unresolved, not empty.
    const json5 = { kind: "json", key: "mcpServers", syntax: "json" };
    assert.deepEqual(mcpServers('{"mcpServers": []}', json5), { status: "unresolved" });
    assert.deepEqual(mcpServers('{"other": {}}', json5), { status: "listed", servers: [] });
    assert.deepEqual(mcpServers('{"gh": {"type": "local", "command": "x"}}', { ...json5, bare: true }), {
      status: "listed",
      servers: [{ name: "gh", transport: "local" }],
    });
    assert.deepEqual(mcpServers('{"servers": {"decoy": {}}}', { ...json5, bare: true }), {
      status: "listed",
      servers: [],
    });
    assert.deepEqual(mcpServers('{"theme": "x"}', { ...json5, syntax: "comments", optional: true }), null);
    // Tools disagree on whether a command or a URL wins, so an entry with both and no `type` is unknown.
    assert.deepEqual(mcpServers('{"mcpServers": {"both": {"command": "x", "url": "y"}}}', json5).servers, [
      { name: "both", transport: "unknown" },
    ]);
    const gemini = { ...json5, syntax: "comments", optional: true, gemini: true };
    assert.deepEqual(
      mcpServers('{"mcpServers": {"a": {"command": "x"}, "b": {"command": "x"}}, "allowMCPServers": ["a"]}', gemini)
        .servers,
      [
        { name: "a", transport: "local" },
        { name: "b", transport: "local", disabled: true },
      ],
    );
    assert.deepEqual(codexServers('[mcp_servers]\nfiles = { command = "x" }\n'), { status: "unresolved" });
    assert.deepEqual(codexServers('mcp_servers.files.command = "x"\n'), {
      status: "listed",
      servers: [{ name: "files", transport: "local" }],
    });
    assert.equal(codexServers('x = """\n[mcp_servers.fake]\n"""\n'), null);
    assert.equal(codexServers('# mcp_servers are configured per user\nmodel = "x"\n'), null);
    assert.deepEqual(codexServers('[mcp_servers.open\ncommand = "x"\n'), { status: "unresolved" });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
