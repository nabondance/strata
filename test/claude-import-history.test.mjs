import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeRepository } from "../dist/analyze.js";
import { configMap } from "../dist/config-map.js";
import { expandRevisions } from "../dist/expand.js";
import { compareGitCommits, renderPullRequestDelta } from "../dist/pr-delta.js";
import { redactReport } from "../dist/privacy.js";
import { renderHtml } from "../dist/report.js";
import { assertLineAgesMatchTrees } from "./line-age-oracle.mjs";
import { loadReportUi } from "./report-ui.mjs";
import { syntheticRepo } from "./synthetic-repo.mjs";

test("the imports table says where an import past the depth limit points", async () => {
  const { repo, put, commit, cleanup } = syntheticRepo("strata-import-depth-");
  try {
    // CLAUDE.md reaches d.md in four hops, so d.md's own imports are past the limit.
    put("CLAUDE.md", "@a.md\n@~/.claude/near.md\n");
    put("a.md", "@b.md\n");
    put("b.md", "@c.md\n");
    put("c.md", "@d.md\n");
    put("d.md", "@~/.claude/me.md\n@nowhere.md\n");
    commit("chain");
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
    cleanup();
  }
});

test("resolves Claude @path imports per revision against the tracked tree", async () => {
  const { treeImports } = await import("../dist/claude-imports.js");
  const { listTree } = await import("../dist/git.js");
  const { trackedFile } = await import("../dist/inventory.js");
  const { importLinks } = await import("../dist/import-links.js");
  const { repo, git, put, commit, cleanup } = syntheticRepo("strata-imports-");
  const at = (revision) =>
    Object.fromEntries(revision.components.map((component) => [component.path, component.imported ? "imported" : ""]));
  const links = (revision) =>
    importLinks(revision.components).map(({ source, target, status }) => `${source} -> ${target} ${status}`);
  try {
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
    assert.equal(report.schemaVersion, 20);
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
    cleanup();
  }
});
