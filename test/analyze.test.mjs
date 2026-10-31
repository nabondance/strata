import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { getEncoding } from "js-tiktoken";
import { analyzeRepository, categories } from "../dist/analyze.js";
import { compareRevisions } from "../dist/compare.js";
import { compactRevisions, expandRevisions, fillRevisions } from "../dist/expand.js";
import { summarize } from "../dist/inventory.js";
import { createMeasurer } from "../dist/measurement.js";
import { compareGitCommits, renderPullRequestDelta } from "../dist/pr-delta.js";
import { redactReport } from "../dist/privacy.js";
import { viewRevision } from "../dist/provider-view.js";
import { clientScript, panelScripts } from "../dist/report/client.js";
import { renderHtml } from "../dist/report.js";
import { renderSvg } from "../dist/svg.js";
import { timelineBuckets } from "../dist/timeline.js";
import { layoutTreemap } from "../dist/treemap.js";
import { assertLineAgesMatchTrees } from "./line-age-oracle.mjs";
import { apiPlan } from "./provider-plans.mjs";
import { exerciseReportUi, loadReportUi } from "./report-ui.mjs";
import { gitRepository, syntheticRepo } from "./synthetic-repo.mjs";

test("tracks configuration across first-parent history without reading untracked files", async () => {
  const { repo, git, put, commit, cleanup } = syntheticRepo("strata-history-");

  try {
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
    const providerReport = await analyzeRepository(repo, {
      providerPlan: {
        methods: { ...apiPlan().methods, codex: [{ kind: "local" }] },
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
    assert.equal(providerReport.schemaVersion, 21);
    assert.equal(providerReport.measurement.accuracy, "estimate");
    assert.deepEqual(
      providerReport.providerMeasurements.map(({ provider, model, accuracy }) => [provider, model, accuracy]),
      [
        ["claude", "claude-test-model", "api-counted"],
        ["gemini", "gemini-test-model", "api-counted"],
        ["codex", "o200k_base", "encoding-exact"],
      ],
    );
    const providerRevisions = expandRevisions(providerReport);
    const sharedMeasured = providerRevisions[0].components.find((component) => component.path === "AGENTS.md");
    assert.equal(sharedMeasured.providerTokenCounts.claude.tokens, 7);
    // The fixture's Gemini settings keep the default context file, so Gemini does not read AGENTS.md.
    assert.equal(sharedMeasured.providerTokenCounts.gemini, undefined);
    const sharedSkill = providerRevisions[0].components.find(
      (component) => component.path === ".agents/skills/release/SKILL.md",
    );
    assert.deepEqual(Object.keys(sharedSkill.providerTokenCounts), ["gemini", "codex"]);
    assert.equal(
      sharedMeasured.providerTokenCounts.codex.tokens,
      getEncoding("o200k_base").encode("Shared project instructions.\n").length,
    );
    assert.equal(providerRevisions[0].components.filter((component) => component.path === "AGENTS.md").length, 1);
    assert.equal(
      providerRevisions[0].providerTokenTotals.claude,
      providerRevisions[0].components.reduce(
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
    const providerJson = JSON.stringify(providerReport);
    assert.ok(!providerJson.includes("anthropic-test-key"));
    assert.ok(!providerJson.includes("gemini-test-key"));
    assert.ok(!providerJson.includes("Shared project instructions."));
    assert.match(
      renderHtml(providerReport),
      /Text sent to: api\.anthropic\.com \(Claude\), generativelanguage\.googleapis\.com \(Gemini\)/,
    );
    // The per-provider columns are the point of this mode, so their table starts open.
    assert.match(renderHtml(providerReport), /<details class="panel" id="files-panel" open>/);
    assert.match(renderHtml(report), /<details class="panel" id="files-panel">/);
    const providerUi = exerciseReportUi(renderHtml(providerReport), providerReport);
    assert.equal(providerUi("files").children[0].children.length, 8);
    const sharedRow = providerUi("files").children.find((row) => row.children[0].textContent === "AGENTS.md");
    assert.equal(sharedRow.children[5].textContent, "7");
    assert.equal(sharedRow.children[6].textContent, "—");
    assert.ok(
      providerUi("files").children.some((row) =>
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
    assert.equal(prDelta.schemaVersion, 13);
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
    assert.equal(report.schemaVersion, 21);
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
    // Panel parts only declare state and functions, so the report works the same with them in reverse order.
    const script = clientScript(report);
    assert.ok(html.includes(script));
    const reversed = clientScript(report, [...panelScripts].reverse());
    assert.notEqual(reversed, script);
    exerciseReportUi(
      html.replace(script, () => reversed),
      report,
    );
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
      const present = revisions.some((revision) => revision.categoryTotals[category].estimatedTokens > 0);
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
    // Without --precise, the report keeps the estimate and Codex reads are also counted exactly on this machine.
    assert.deepEqual(
      [cliReport.measurement.accuracy, cliReport.measurement.encoding, cliReport.measurement.model],
      ["estimate", null, null],
    );
    assert.deepEqual(cliReport.providerMeasurements, [
      {
        provider: "codex",
        model: "o200k_base",
        method: "js-tiktoken@1.0.21: o200k_base, counted per instructional file",
        version: "js-tiktoken@1.0.21",
        accuracy: "encoding-exact",
      },
    ]);
    const cliRevisions = expandRevisions(cliReport);
    const codexInstruction = cliRevisions[0].components.find((component) => component.path === "AGENTS.md");
    assert.equal(codexInstruction.estimatedTokens, Math.ceil(Buffer.byteLength("Shared project instructions.\n") / 4));
    assert.equal(
      codexInstruction.providerTokenCounts.codex.tokens,
      getEncoding("o200k_base").encode("Shared project instructions.\n").length,
    );
    assert.equal(
      cliRevisions[0].components.find((component) => component.path === ".agents/skills/release/assets/icon.png")
        ?.providerTokenCounts,
      undefined,
    );
    for (const removed of [["--model", "gpt-4o"], ["--provider-api"], ["--tokenizer", "openai-o200k_base"]]) {
      const result = spawnSync(process.execPath, ["dist/cli.js", "analyze", repo, ...removed], { encoding: "utf8" });
      assert.equal(result.status, 2, removed.join(" "));
    }
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
      const { put, commit } = gitRepository(single);
      put("CLAUDE.md", "Only commit.\n");
      commit("root");
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
    cleanup();
  }
});

// Schema 21 leaves out what repeats the previous revision; `fillRevisions` restores it exactly.
test("leaves out category totals and first parents that repeat the previous revision", async () => {
  const { repo, put, commit, cleanup } = syntheticRepo("strata-carried-");
  try {
    put("CLAUDE.md", "Root instructions.\n");
    put("AGENTS.md", "Shared instructions.\n");
    put(".claude/skills/release/SKILL.md", "---\nname: release\ndescription: Prepare a release\n---\nShip it.\n");
    const ids = [commit("configuration")];
    put("README.md", "Not agent configuration.\n");
    ids.push(commit("readme"));
    put("src/index.ts", "export {};\n");
    ids.push(commit("code"));
    put("CLAUDE.md", "Root instructions, now longer.\n");
    ids.push(commit("grow instructions"));
    // Same size, so the same totals although a recognized file changed.
    put("CLAUDE.md", "Root instructions, now LONGER.\n");
    ids.push(commit("same-size edit"));
    ids.push(commit("empty", { flags: ["--allow-empty"] }));

    const report = await analyzeRepository(repo);
    assert.equal(report.schemaVersion, 21);
    const stored = report.revisions;
    assert.equal(stored.length, 6);
    // The first revision always carries both fields.
    assert.equal(stored[0].firstParent, null);
    assert.ok(stored[0].categoryTotals);
    for (const revision of stored.slice(1)) assert.ok(!("firstParent" in revision), revision.id);
    assert.deepEqual(
      stored.map((revision) => "categoryTotals" in revision),
      [true, false, false, true, false, false],
    );
    assert.equal(stored[4].changes.length, 1);
    // Per-revision totals the README and the skill rely on stay on every revision.
    for (const revision of stored) {
      for (const field of ["id", "date", "componentCount", "estimatedTokens", "skillListingTokens", "changes"]) {
        assert.ok(field in revision, `${revision.id} ${field}`);
      }
    }

    // Filling restores every revision's totals and parent, which the JSON round trip keeps.
    const filled = fillRevisions(JSON.parse(JSON.stringify(report)).revisions);
    assert.deepEqual(fillRevisions(stored), filled);
    assert.deepEqual(fillRevisions(filled), filled);
    assert.deepEqual(compactRevisions(filled), stored);
    assert.deepEqual(
      filled.map((revision) => revision.firstParent),
      [null, ...ids.slice(0, -1)],
    );
    const expanded = expandRevisions(report);
    expanded.forEach((revision, index) => {
      assert.deepEqual(revision.categoryTotals, summarize(revision.components).categoryTotals, `revision ${index}`);
      assert.deepEqual(filled[index].categoryTotals, revision.categoryTotals);
      assert.equal(revision.firstParent, filled[index].firstParent);
    });
    assert.notDeepEqual(filled[3].categoryTotals, filled[0].categoryTotals);
    assert.throws(() => fillRevisions(stored.slice(1)), /first revision/);

    // Shareable aliases keep the same fields out, and the HTML embeds the compacted revisions.
    const shareable = redactReport(report);
    assert.deepEqual(
      shareable.revisions.map((revision) => ["firstParent" in revision, "categoryTotals" in revision]),
      stored.map((revision) => ["firstParent" in revision, "categoryTotals" in revision]),
    );
    assert.deepEqual(
      fillRevisions(shareable.revisions).map((revision) => revision.firstParent),
      [null, ...shareable.revisions.slice(0, -1).map((revision) => revision.id)],
    );
    // The last revision has no stored totals, so the legend it draws on startup reads filled ones.
    const legendCategories = categories.filter((category) => filled.at(-1).categoryTotals[category].count);
    for (const subject of [report, shareable]) {
      const html = renderHtml(subject);
      assert.equal(html.match(/"categoryTotals":/g).length, 2);
      assert.equal(html.match(/"firstParent":/g).length, 1);
      const ui = loadReportUi(html);
      assert.deepEqual(
        ui.get("legend").children.map((label) => [label.textContent, label.children.at(-1).textContent]),
        legendCategories.map((category) => {
          const total = filled.at(-1).categoryTotals[category];
          const files = `${total.count} file${total.count === 1 ? "" : "s"}`;
          return [category, total.count === total.sourceOnlyCount ? files : String(total.estimatedTokens)];
        }),
      );
    }
    assert.match(renderSvg(report), /<polygon/);
  } finally {
    cleanup();
  }
});
