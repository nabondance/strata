import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { analyzeRepository } from "../dist/analyze.js";
import { redactReport } from "../dist/privacy.js";
import { renderHtml } from "../dist/report.js";
import { layoutTreemap, shorterTreemapNames, treemapNames } from "../dist/treemap.js";
import { loadReportUi } from "./report-ui.mjs";
import { gitRepository, syntheticRepo } from "./synthetic-repo.mjs";

test("draws instruction age by period, marks a shallow start, and follows the keyboard and the baseline", async () => {
  const repos = [];
  /** A repository with one commit per entry, each writing its files at its date. */
  const history = (commits) => {
    const { repo, put, commit, cleanup } = syntheticRepo("strata-age-ui-");
    repos.push(cleanup);
    for (const [index, { date, files }] of commits.entries()) {
      for (const [path, content] of Object.entries(files)) put(path, content);
      commit(`commit ${index}`, { date });
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
    assert.equal(get("compare-kept").textContent, "100%");
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
    for (const cleanup of repos) cleanup();
  }
});

test("names submodules that hold agent configuration it did not analyze", async () => {
  const { repo, git, cleanup } = syntheticRepo("strata-submodules-");
  // A submodule entry records a commit from another repository; `nested` makes that repository in place.
  const link = (path, commit) => git("update-index", "--add", "--cacheinfo", `160000,${commit},${path}`);
  const missing = "1".repeat(40);
  const nested = (path, files) => {
    const sub = gitRepository(join(repo, path));
    for (const [file, content] of Object.entries(files)) sub.put(file, content);
    return sub.commit("Submodule content");
  };
  try {
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
    const html = renderHtml(report);
    const ui = loadReportUi(html);
    const notice = ui.get("submodules");
    assert.equal(notice.hidden, false);
    assert.equal(
      notice.textContent,
      "Not analyzed: 2 Git submodules hold recognized agent configuration files: .claude-template (3), .claude/skills/review (2). " +
        "Run Strata on one to see its history.",
    );
    // Submodules a fresh clone has not checked out get a quiet note after the measurement disclosure, not a warning.
    const unchecked = ui.get("submodules-unchecked");
    assert.equal(unchecked.hidden, false);
    assert.equal(
      unchecked.textContent,
      "2 Git submodules were not checked for agent configuration because they are not checked out at the recorded commit.",
    );
    assert.match(html, /<p class="notice warning" id="submodules" hidden>/);
    assert.match(
      html,
      /id="counting-notice">[\s\S]*?<\/details>\n\s*<p class="notice submodule-note" id="submodules-unchecked" hidden>/,
    );
    const onlyUnchecked = loadReportUi(
      renderHtml({ ...report, submodules: [{ path: "evals/bench", configFiles: null }] }),
    );
    assert.equal(onlyUnchecked.get("submodules").hidden, true);
    assert.equal(onlyUnchecked.get("submodules-unchecked").hidden, false);
    assert.match(
      onlyUnchecked.get("submodules-unchecked").textContent,
      /^1 Git submodule was not checked .* because it is /,
    );

    const shareable = redactReport(report);
    assert.deepEqual(
      shareable.submodules.map(({ path }) => path),
      // Submodule paths are aliased like folders, so one under `.claude/skills` stays there.
      ["d1", ".claude/skills/d2", "d3/d4", "d3/d5", "d3/d6"],
    );
    assert.doesNotMatch(JSON.stringify(shareable), /claude-template|vendor/);

    // Submodules without agent configuration are left out of the notice.
    const quiet = { ...report, submodules: [{ path: "vendor/lib", configFiles: 0 }] };
    assert.equal(loadReportUi(renderHtml(quiet)).get("submodules").hidden, true);
    assert.equal(loadReportUi(renderHtml(quiet)).get("submodules-unchecked").hidden, true);
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
    cleanup();
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

test("explains a history with no agent configuration instead of drawing empty panels", async () => {
  const { repo, put, commit, cleanup } = syntheticRepo("strata-empty-");
  try {
    // Skills at the repository root are not where any supported tool reads them.
    put("README.md", "Skills.\n");
    commit("Start");
    put("skills/review/SKILL.md", "---\nname: review\ndescription: Review.\n---\nReview.\n");
    commit("Add a skill at the root");
    const report = await analyzeRepository(repo);
    assert.equal(report.components.length, 0);
    const html = renderHtml(report);
    assert.match(html, /<div id="report-panels">/);
    const { get } = loadReportUi(html);
    const card = get("empty-state");
    assert.equal(card.hidden, false);
    assert.equal(
      card.children[0].textContent,
      `Strata found no agent configuration in 2 revisions of ${report.repository}`,
    );
    const listed = card.children[2].children.map((item) => item.children[0].textContent);
    for (const path of [
      "CLAUDE.md",
      "AGENTS.md",
      ".claude/",
      ".agents/skills/",
      ".cursor/rules/",
      ".github/copilot-instructions.md",
      "GEMINI.md",
      ".codex/",
    ]) {
      assert.ok(listed.includes(path), path);
    }
    assert.match(card.children[3].textContent, /a top-level skills\/ folder, are not read by the supported tools/);
    // The panels, the provider tabs, and the measurement disclosure would all be empty, so they are hidden.
    assert.equal(get("report-panels").hidden, true);
    assert.equal(get("counting-notice").hidden, true);
    // The masthead stays.
    assert.equal(get("repo").textContent, report.repository);
    assert.equal(get("components").textContent, "0");
    assert.equal(get("silhouette").children.at(-1).hidden, true);

    // Configuration that existed earlier keeps the panels, with each panel's own empty message at the latest revision.
    put("CLAUDE.md", "Instructions.\n");
    commit("Add instructions");
    rmSync(join(repo, "CLAUDE.md"));
    commit("Remove instructions");
    const removed = await analyzeRepository(repo);
    assert.ok(removed.components.length);
    const later = loadReportUi(renderHtml(removed)).get;
    assert.notEqual(later("empty-state")?.hidden, false);
    assert.notEqual(later("report-panels")?.hidden, true);
    assert.equal(later("treemap").children[0].textContent, "No instructional token estimates at this revision.");
    assert.equal(later("components").textContent, "0");
  } finally {
    cleanup();
  }
});

test("names repeated treemap labels by the folders that tell them apart", async () => {
  assert.deepEqual(
    treemapNames([
      "AGENTS.md",
      "packages/core/AGENTS.md",
      "packages/server/AGENTS.md",
      "templates/x/AGENTS.md",
      "CLAUDE.md",
      ".claude/skills/pr-screenshots",
      ".agents/skills/pr-screenshots",
      "docs/CLAUDE.md",
    ]),
    [
      "AGENTS.md",
      "core/AGENTS.md",
      "server/AGENTS.md",
      "x/AGENTS.md",
      "CLAUDE.md",
      ".claude/skills/pr-screenshots",
      ".agents/skills/pr-screenshots",
      "docs/CLAUDE.md",
    ],
  );
  // A folder that ends another path's folders still tells the two apart.
  assert.deepEqual(treemapNames(["a/AGENTS.md", "x/a/AGENTS.md"]), ["a/AGENTS.md", "x/a/AGENTS.md"]);
  // An ellipsis stands for two or more folders, never for one.
  assert.deepEqual(treemapNames(["b/c/x.md", "a/b/c/x.md", "d/b/c/x.md"]), ["b/c/x.md", "a/…/x.md", "d/…/x.md"]);
  // When leaving folders out would make two names alike again, they keep every folder they needed.
  assert.deepEqual(treemapNames(["a/p/q/M", "b/p/q/M", "a/s/t/u/M", "c/s/t/u/M"]), [
    "a/p/q/M",
    "b/…/M",
    "a/s/t/u/M",
    "c/…/M",
  ]);
  assert.deepEqual(treemapNames([]), []);

  // Shorter forms drop whole folders before cutting letters, and none reads like another name or its shorter forms.
  assert.deepEqual(shorterTreemapNames(["playground/CLAUDE.md", "background/CLAUDE.md", "CLAUDE.md"]), [
    ["…ayground/CLAUDE.md", "…yground/CLAUDE.md"],
    ["…ckground/CLAUDE.md", "…kground/CLAUDE.md"],
    [],
  ]);
  assert.deepEqual(shorterTreemapNames(["a/p/q/M", "b/…/M"]), [["a/…/M", "…/q/M"], []]);
  // `…/<name>` is offered when no other name can read the same, such as beside the root-level file.
  assert.deepEqual(shorterTreemapNames(["AGENTS.md", "templates/…/AGENTS.md"]), [
    [],
    [
      "…/AGENTS.md",
      "…mplates/…/AGENTS.md",
      "…plates/…/AGENTS.md",
      "…lates/…/AGENTS.md",
      "…ates/…/AGENTS.md",
      "…tes/…/AGENTS.md",
      "…es/…/AGENTS.md",
      "…s/…/AGENTS.md",
    ],
  ]);

  const { repo, put, commit, cleanup } = syntheticRepo("strata-treemap-names-");
  try {
    put("AGENTS.md", `${"Root. ".repeat(40)}\n`);
    put("packages/core/AGENTS.md", `${"Core. ".repeat(40)}\n`);
    put("packages/server/AGENTS.md", `${"Server. ".repeat(40)}\n`);
    put(".claude/skills/review/SKILL.md", `---\nname: review\ndescription: Review.\n---\n${"Review. ".repeat(40)}\n`);
    put(".agents/skills/review/SKILL.md", `---\nname: review\ndescription: Review.\n---\n${"Check. ".repeat(40)}\n`);
    commit("Repeated names");
    const report = await analyzeRepository(repo);
    const { get, layout } = loadReportUi(renderHtml(report));
    const drawnNames = () =>
      get("treemap")
        .children.filter((child) => child.className === "treemap-leaf")
        .map((leaf) => leaf.children[0].textContent)
        .sort();
    assert.deepEqual(drawnNames(), [
      ".agents/skills/review",
      ".claude/skills/review",
      "AGENTS.md",
      "core/AGENTS.md",
      "server/AGENTS.md",
    ]);
    // In narrow rectangles, names lose folders and then letters from the left, and still all differ.
    layout.labelFits = (text) => text.length <= 12;
    get("target").value = "0";
    get("target").listeners.change();
    assert.deepEqual(drawnNames(), ["AGENTS.md", "…de/…/review", "…e/AGENTS.md", "…r/AGENTS.md", "…ts/…/review"]);
  } finally {
    cleanup();
  }
});

test("the masthead silhouette follows the provider view and marks the selected revision", async () => {
  const { repo, put, commit, cleanup } = syntheticRepo("strata-silhouette-");
  try {
    put("CLAUDE.md", `${"Claude. ".repeat(50)}\n`);
    commit("Claude");
    put(".claude/agents/review.md", `${"Review. ".repeat(80)}\n`);
    commit("Agent");
    put("AGENTS.md", `${"Shared. ".repeat(30)}\n`);
    commit("Shared");
    const report = await analyzeRepository(repo);
    const { get } = loadReportUi(renderHtml(report));
    const layers = () => get("silhouette").children.filter((child) => child.className !== "silhouette-mark");
    const mark = () => get("silhouette").children.at(-1);
    assert.equal(layers().length, 2);
    assert.equal(mark().hidden, false);
    assert.equal(mark().style.left, "83.33%");
    get("target").value = "0";
    get("target").listeners.change();
    assert.equal(mark().style.left, "16.67%");
    // Codex reads only AGENTS.md, so its view has one layer, drawn from the last revision.
    get("provider-tabs")
      .children.find((tab) => tab.textContent === "Codex + shared")
      .listeners.click();
    assert.equal(layers().length, 1);
    assert.equal(mark().hidden, true);
    get("target").value = "2";
    get("target").listeners.change();
    assert.equal(mark().hidden, false);
    assert.equal(mark().style.left, "50.00%");
  } finally {
    cleanup();
  }
});
