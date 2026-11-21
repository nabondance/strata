import assert from "node:assert/strict";
import test from "node:test";
import { analyzeRepository } from "../dist/analyze.js";
import { compareRevisions } from "../dist/compare.js";
import { expandRevisions } from "../dist/expand.js";
import { pluginRefs } from "../dist/plugins.js";
import { compareGitCommits, renderPullRequestDelta } from "../dist/pr-delta.js";
import { redactReport } from "../dist/privacy.js";
import { renderHtml } from "../dist/report.js";
import { loadReportUi } from "./report-ui.mjs";
import { syntheticRepo } from "./synthetic-repo.mjs";

test("shows Claude plugins through time by state, without their sources or content", async () => {
  const { repo, put, commit, cleanup } = syntheticRepo("strata-plugins-");
  const secret = "private-org/secret-plugins";
  // A plugin name is repository text: Markdown and HTML must escape it.
  const hostile = "a|b<i>\u001b[31m@tools";
  const at = (revision) =>
    Object.fromEntries(
      revision.components
        .filter((component) => component.plugins)
        .map((component) => [
          component.path,
          component.plugins.status === "listed"
            ? component.plugins.plugins.map(
                (plugin) =>
                  `${plugin.name}:${plugin.state}${plugin.listed ? `:${plugin.listed.local}+${plugin.listed.external}` : ""}`,
              )
            : component.plugins.status,
        ]),
    );
  try {
    put("CLAUDE.md", "Project memory.\n");
    put(".claude/settings.json", '{"model":"example"}\n');
    const first = commit("No plugins");

    put("plugins/fmt/.claude-plugin/plugin.json", '{"name":"fmt"}\n');
    put(
      "plugins/fmt/skills/lint/SKILL.md",
      `---\nname: lint\ndescription: Lint.\n---\n${"Plugin text. ".repeat(50)}\n`,
    );
    put(
      ".claude-plugin/marketplace.json",
      JSON.stringify({
        name: "tools",
        owner: { name: "Example" },
        plugins: [
          { name: "fmt", source: "./plugins/fmt" },
          { name: "remote", source: { source: "github", repo: secret } },
        ],
      }),
    );
    put(".claude/skills/pack/.claude-plugin/plugin.json", '{"name":"pack"}\n');
    put(".claude/skills/off/.claude-plugin/plugin.json", '{"name":"off","defaultEnabled":false}\n');
    put(
      ".claude/settings.json",
      JSON.stringify({
        enabledPlugins: { "fmt@tools": true, "old@tools": true, [hostile]: false },
        extraKnownMarketplaces: { tools: { source: { source: "github", repo: secret } } },
      }),
    );
    const second = commit("Add plugins");

    put(".claude/settings.json", JSON.stringify({ enabledPlugins: { "fmt@tools": false, [hostile]: false } }));
    put(".claude-plugin/marketplace.json", "{ not json");
    const third = commit("Turn one off and break the marketplace");

    const report = await analyzeRepository(repo);
    const revisions = expandRevisions(report);
    assert.equal(report.schemaVersion, 23);
    assert.deepEqual(at(revisions[0]), {});
    assert.deepEqual(at(revisions[1]), {
      ".claude-plugin/marketplace.json": ["tools:catalog:1+1"],
      ".claude/settings.json": ["fmt@tools:enabled", "old@tools:enabled", `${hostile}:disabled`, "tools:marketplace"],
      ".claude/skills/off/.claude-plugin/plugin.json": ["off@skills-dir:defined"],
      ".claude/skills/pack/.claude-plugin/plugin.json": ["pack@skills-dir:skills-folder"],
      "plugins/fmt/.claude-plugin/plugin.json": ["fmt:defined"],
    });
    assert.equal(at(revisions[2])[".claude-plugin/marketplace.json"], "unresolved");

    // Naming a plugin adds no tokens, and its own files are not counted as this repository's context.
    assert.equal(revisions[1].estimatedTokens, revisions[0].estimatedTokens);
    assert.ok(!revisions[1].components.some((component) => component.path.endsWith("lint/SKILL.md")));
    assert.ok(!JSON.stringify(report).includes(secret));

    const change = compareRevisions(revisions[1], revisions[2]).plugins;
    assert.deepEqual([change.beforePlugins, change.afterPlugins, change.afterUnresolved], [8, 5, 1]);
    assert.deepEqual(
      change.changed.map((ref) => `${ref.name}:${ref.before}>${ref.after}`),
      ["fmt@tools:enabled>disabled"],
    );

    const delta = compareGitCommits(repo, second, third);
    assert.equal(delta.schemaVersion, 15);
    const markdown = renderPullRequestDelta(delta);
    assert.match(markdown, /Agent plugin references in tracked files: \*\*-3\*\* \(8 → 5\)/);
    assert.match(markdown, /Changed: fmt@tools, enabled → turned off \(\.claude\/settings\.json\)/);
    assert.match(markdown, /Enabled is not installed, and defined is not active/);
    assert.ok(!markdown.includes("\u001b"));
    assert.equal(compareGitCommits(repo, first, first).comparison.plugins, undefined);
    assert.match(renderPullRequestDelta(compareGitCommits(repo, first, second)), /a\\\|b&lt;i&gt;/);

    // A shareable export aliases names, the same name to the same alias.
    const shared = JSON.stringify(redactReport(report));
    assert.ok(!shared.includes("fmt@tools") && !shared.includes("pack@skills-dir") && shared.includes("plugin-00001"));

    const html = renderHtml(report);
    assert.ok(!html.includes(secret) && !html.includes("b<i>"));
    const ui = loadReportUi(html);
    assert.equal(ui.get("plugins-panel").hidden, false);
    assert.equal(ui.get("plugins-count").textContent, "5 references · 5 files · 1 unresolved");
    assert.equal(ui.get("compare-plugins-wrap").hidden, false);
    const flat = (node) => (node.textContent ?? "") + node.children.map(flat).join("");
    assert.ok(
      ui
        .get("compare-plugin-names")
        .children.some((group) => flat(group).includes("fmt@tools, enabled → turned off .claude/settings.json")),
    );
  } finally {
    cleanup();
  }
});

test("reads only the documented plugin shapes, and marks anything else unresolved", () => {
  const unresolved = { status: "unresolved" };
  assert.equal(pluginRefs('{"theme":"enabledPlugins"}', "settings"), null);
  assert.deepEqual(pluginRefs('{"enabledPlugins":{"a@b":"yes"}}', "settings"), unresolved);
  assert.deepEqual(pluginRefs('{"enabledPlugins":[]}', "settings"), unresolved);
  assert.deepEqual(pluginRefs('{"version":"1"}', "manifest"), unresolved);
  assert.deepEqual(pluginRefs('{"name":"m","plugins":[{"name":"p"}]}', "marketplace"), unresolved);
});
