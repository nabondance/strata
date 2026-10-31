import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { analyzeRepository } from "../dist/analyze.js";
import { redactReport } from "../dist/privacy.js";
import { renderHtml } from "../dist/report.js";
import { layoutTreemap } from "../dist/treemap.js";
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
