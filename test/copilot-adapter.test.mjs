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

test("recognizes GitHub Copilot configuration, and has Copilot read other tools' files only where Copilot is configured", async () => {
  const { repo, git, put, commit, cleanup } = syntheticRepo("strata-copilot-");
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
    assert.equal(delta.schemaVersion, 13);
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
    cleanup();
  }
});
