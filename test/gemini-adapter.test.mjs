import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeRepository } from "../dist/analyze.js";
import { expandRevisions } from "../dist/expand.js";
import { redactReport } from "../dist/privacy.js";
import { viewRevision } from "../dist/provider-view.js";
import { assertLineAgesMatchTrees } from "./line-age-oracle.mjs";

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
