import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { analyzeRepository } from "../dist/analyze.js";
import { expandRevisions } from "../dist/expand.js";
import { compareGitCommits } from "../dist/pr-delta.js";
import { redactReport } from "../dist/privacy.js";
import { viewRevision } from "../dist/provider-view.js";
import { renderHtml } from "../dist/report.js";
import { assertLineAgesMatchTrees } from "./line-age-oracle.mjs";
import { apiPlan } from "./provider-plans.mjs";
import { loadReportUi } from "./report-ui.mjs";
import { syntheticRepo } from "./synthetic-repo.mjs";

test("recognizes Cursor configuration, and has Cursor read other tools' files only where Cursor is configured", async () => {
  const { repo, git, put, commit, cleanup } = syntheticRepo("strata-cursor-");
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
      providerPlan: apiPlan(async (url, init) => {
        sentBodies.push(init.body);
        return new Response(JSON.stringify(url.includes("anthropic") ? { input_tokens: 7 } : { totalTokens: 9 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    });
    assertLineAgesMatchTrees(repo, report);
    assert.equal(report.schemaVersion, 21);
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
    assert.equal(delta.schemaVersion, 14);
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
    // `.cursorrules` is a Cursor convention, not a name the repository chose, so it stays.
    assert.equal(shareable.components.find((component) => component.legacy).path, ".cursorrules");

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
    cleanup();
  }
});
