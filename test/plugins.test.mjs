import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import test from "node:test";
import { analyzeRepository } from "../dist/analyze.js";
import { compareRevisions } from "../dist/compare.js";
import { expandRevisions } from "../dist/expand.js";
import { importLinks } from "../dist/import-links.js";
import { pluginRefs } from "../dist/plugins.js";
import { compareGitCommits, renderPullRequestDelta } from "../dist/pr-delta.js";
import { redactReport } from "../dist/privacy.js";
import { viewRevision } from "../dist/provider-view.js";
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
    assert.deepEqual([change.beforePlugins, change.afterPlugins, change.afterUnresolved], [7, 5, 1]);
    assert.deepEqual(
      change.changed.map((ref) => `${ref.name}:${ref.before}>${ref.after}`),
      ["fmt@tools:enabled>disabled"],
    );

    // A file that stops parsing may still name its plugins, so none of them count as removed.
    assert.ok(!change.removed.some((ref) => ref.path === ".claude-plugin/marketplace.json"));

    const delta = compareGitCommits(repo, second, third);
    assert.equal(delta.schemaVersion, 15);
    const markdown = renderPullRequestDelta(delta);
    assert.match(markdown, /Agent plugin references in tracked files: \*\*-2\*\* \(7 → 5\)/);
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

test("covers every tool's plugin files, and only confirmed ones among common file names", async () => {
  const { repo, put, commit, cleanup } = syntheticRepo("strata-plugins-tools-");
  const schema = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
  const states = (revision) =>
    Object.fromEntries(
      revision.components
        .filter((component) => component.plugins?.status === "listed")
        .map((component) => [
          component.path,
          component.plugins.plugins.map((plugin) =>
            [plugin.name, plugin.state, ...(plugin.listed ? [plugin.listed.local, plugin.listed.external] : [])].join(
              ":",
            ),
          ),
        ]),
    );
  try {
    put("AGENTS.md", "Shared instructions.\n");
    // Other projects use these names too, so without the documented format they are not plugins.
    put("plugin.json", '{"name":"webpack-thing"}\n');
    put("src/plugin.json", "not json\n");
    const first = commit("No plugins");

    const owner = { name: "Example" };
    put(
      ".github/plugin/marketplace.json",
      JSON.stringify({ name: "co", owner, plugins: [{ name: "x", source: { source: "github", repo: "o/r" } }] }),
    );
    put(".github/copilot/settings.json", '{"enabledPlugins":{"x@co":true}}\n');
    put(
      ".agents/plugins/marketplace.json",
      JSON.stringify({ name: "local-repo", plugins: [{ name: "a", source: { source: "local", path: "./a" } }] }),
    );
    put(".codex/config.toml", '[plugins."a@local-repo"]\nenabled = true\n\n[plugins."b@other"]\nenabled = false\n');
    put("a/.codex-plugin/plugin.json", '{"name":"a"}\n');
    put(
      ".cursor-plugin/marketplace.json",
      JSON.stringify({ name: "cur", owner, plugins: [{ name: "c", source: { path: "./c" } }] }),
    );
    put("c/.cursor-plugin/plugin.json", '{"name":"c"}\n');
    put("ext/gemini-extension.json", '{"name":"ext"}\n');
    put("std/plugin.json", JSON.stringify({ $schema: schema, name: "std" }));
    put("marketplace.json", JSON.stringify({ name: "root", owner, plugins: [] }));
    const second = commit("Add each tool's plugins");

    // A version that stops parsing is still a package, whose plugins are unknown rather than removed.
    put("std/plugin.json", `{"$schema":"${schema}","name":"std",}`);
    const broken = commit("Break the manifest");
    const unreadable = compareGitCommits(repo, second, broken).comparison.plugins;
    assert.deepEqual([unreadable.removed.length, unreadable.afterUnresolved], [0, 1]);
    // A broken file must carry the same exact schema URL as a valid one to count.
    put("loose/plugin.json", `{"$schema":"https://agent-plugins.org/schemas/latest/plugin.schema.json","name":"x",}`);
    assert.ok(
      !compareGitCommits(repo, second, commit("Unversioned schema")).comparison.components.some(
        (c) => c.path === "loose/plugin.json",
      ),
    );
    // So is one that still declares the schema but breaks a required field.
    put("std/plugin.json", JSON.stringify({ $schema: schema, name: "" }));
    const badField = commit("Break a field");
    const fieldBroken = compareGitCommits(repo, second, badField).comparison.plugins;
    assert.deepEqual([fieldBroken.removed.length, fieldBroken.afterUnresolved], [0, 1]);

    // A root marketplace with a damaged field is unknown too, not removed.
    put("marketplace.json", JSON.stringify({ name: "root", owner, plugins: { a: {} } }));
    const badCatalog = commit("Break the catalog");
    const catalogBroken = compareGitCommits(repo, second, badCatalog).comparison.plugins;
    assert.ok(!catalogBroken.removed.some((ref) => ref.path === "marketplace.json"));
    put("marketplace.json", JSON.stringify({ name: "root", owner, plugins: [] }));

    put("std/plugin.json", '{"name":"std"}\n');
    const third = commit("Drop the schema");

    const report = await analyzeRepository(repo);
    const revisions = expandRevisions(report);
    assert.deepEqual(states(revisions[0]), {});
    assert.deepEqual(states(revisions[1]), {
      ".agents/plugins/marketplace.json": ["local-repo:catalog:1:0"],
      ".codex/config.toml": ["a@local-repo:enabled", "b@other:disabled"],
      ".cursor-plugin/marketplace.json": ["cur:catalog:1:0"],
      ".github/copilot/settings.json": ["x@co:enabled"],
      ".github/plugin/marketplace.json": ["co:catalog:0:1"],
      "a/.codex-plugin/plugin.json": ["a:defined"],
      "c/.cursor-plugin/plugin.json": ["c:defined"],
      "ext/gemini-extension.json": ["ext:defined"],
      "marketplace.json": ["root:catalog:0:0"],
      "std/plugin.json": ["std:defined"],
    });
    const paths = (revision) => revision.components.map((component) => component.path);
    assert.ok(!paths(revisions[1]).includes("plugin.json") && !paths(revisions[1]).includes("src/plugin.json"));
    // A file that stops being a package leaves the inventory.
    assert.ok(!paths(revisions.at(-1)).includes("std/plugin.json"));
    assert.equal(revisions[1].estimatedTokens, revisions[0].estimatedTokens);

    // Packaging a Cursor plugin does not show the repository uses Cursor; Copilot's settings do.
    const agents = revisions[1].components.find((component) => component.path === "AGENTS.md");
    assert.ok(agents.readers.includes("copilot") && !agents.readers.includes("cursor"));
    assert.deepEqual(revisions[1].components.find((c) => c.path === "std/plugin.json").readers, [
      "codex",
      "copilot",
      "cursor",
    ]);

    // `strata diff` confirms packages the same way.
    assert.equal(compareGitCommits(repo, first, second).comparison.plugins.afterPlugins, 11);
    assert.match(renderPullRequestDelta(compareGitCommits(repo, first, second)), /marketplace file, 1 plugin \(/);
    const dropped = compareGitCommits(repo, second, third).comparison.plugins;
    assert.deepEqual(
      dropped.removed.map((ref) => ref.path),
      ["std/plugin.json"],
    );
    assert.ok(redactReport(report).components.every((component) => component.path !== "std/plugin.json"));
  } finally {
    cleanup();
  }
});

test("keeps packages exact through imports, renames, partial clones, and tool detection", async (t) => {
  const { repo, git, put, commit, cleanup } = syntheticRepo("strata-plugins-edges-");
  t.after(cleanup);
  const manifest = (name) =>
    JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name });
  const packaged = (revision) =>
    revision.components.filter((component) => component.pluginPackage).map((component) => component.path);
  put("CLAUDE.md", "Memory.\n");
  put("plugin.json", manifest("root"));
  // A marketplace can place a plugin in an agent's own folder; the file keeps its label there.
  put(".agents/plugins/foo/plugin.json", manifest("foo"));
  const ids = [commit("Manifest first")];
  put("CLAUDE.md", "Memory.\n@plugin.json\n");
  ids.push(commit("Import it"));
  put("CLAUDE.md", "Memory.\n");
  ids.push(commit("Stop importing it"));
  git("mv", "plugin.json", "moved-plugin.json");
  git("mv", "moved-plugin.json", "pkg-plugin.json");
  git("mv", "pkg-plugin.json", "plugin.json");
  put("sub/x.txt", "x\n");
  git("mv", "plugin.json", "sub/plugin.json");
  ids.push(commit("Move it"));

  const report = await analyzeRepository(repo);
  const revisions = expandRevisions(report);
  // A package keeps its label while an import reaches it, and `strata diff` agrees.
  const agent = ".agents/plugins/foo/plugin.json";
  assert.deepEqual(revisions.map(packaged), [
    [agent, "plugin.json"],
    [agent, "plugin.json"],
    [agent, "plugin.json"],
    [agent, "sub/plugin.json"],
  ]);
  const reached = revisions[1].components.find((component) => component.path === "plugin.json");
  assert.ok(!reached.imported && reached.plugins.status === "listed");
  const links = importLinks(revisions[1].components);
  assert.ok(links.some((link) => link.target === "plugin.json" && link.status === "resolved"));
  for (let index = 1; index < ids.length; index += 1) {
    assert.deepEqual(
      compareGitCommits(repo, ids[index - 1], ids[index]).comparison.plugins,
      compareRevisions(revisions[index - 1], revisions[index]).plugins,
    );
  }
  assert.ok(
    revisions[3].changes.some(
      (change) =>
        change.kind === "renamed" && change.previousPath === "plugin.json" && change.path === "sub/plugin.json",
    ),
  );
  const inAgentFolder = revisions[0].components.find((c) => c.path === ".agents/plugins/foo/plugin.json");
  assert.deepEqual(inAgentFolder.plugins, { status: "listed", plugins: [{ name: "foo", state: "defined" }] });
  assert.deepEqual(inAgentFolder.readers, ["codex", "copilot", "cursor"]);

  // Publishing for a tool neither adds it to session context nor gives it a report tab.
  const published = syntheticRepo("strata-plugins-published-");
  t.after(published.cleanup);
  published.put("AGENTS.md", "Shared instructions.\n");
  const base = published.commit("Instructions");
  published.put(".cursor-plugin/plugin.json", '{"name":"pub"}\n');
  published.put(".claude-plugin/plugin.json", '{"name":"pub"}\n');
  const head = published.commit("Publish plugins");
  assert.ok(!compareGitCommits(published.repo, base, head).upFront.some((row) => row.provider === "cursor"));
  const tabs = loadReportUi(renderHtml(await analyzeRepository(published.repo)))
    .get("provider-tabs")
    .children.map((tab) => tab.textContent);
  assert.ok(!tabs.some((tab) => /^(?:Copilot|Cursor)/.test(tab)), tabs.join(", "));

  // A partial clone leaves plugin packages out, whichever blobs it holds, and downloads nothing for them.
  const remote = syntheticRepo("strata-plugins-partial-");
  t.after(remote.cleanup);
  remote.git("config", "uploadpack.allowFilter", "true");
  remote.git("config", "uploadpack.allowAnySHA1InWant", "true");
  remote.put("CLAUDE.md", "Memory.\n@.claude-plugin/plugin.json\n");
  remote.put(".claude-plugin/plugin.json", '{"name":"imported"}\n');
  remote.put("a/plugin.json", manifest("held"));
  remote.put("b/plugin.json", manifest("old"));
  const oldCommit = remote.commit("First");
  remote.put("b/plugin.json", manifest("new"));
  const newCommit = remote.commit("Second");
  const clone = `${remote.repo}-clone`;
  t.after(() => rmSync(clone, { recursive: true, force: true }));
  const inClone = (...args) => execFileSync("git", ["-C", clone, ...args], { stdio: "ignore" });
  execFileSync(
    "git",
    ["clone", "-q", "--no-local", "--no-checkout", "--filter=blob:none", `file://${remote.repo}`, clone],
    {
      stdio: "ignore",
    },
  );
  inClone("cat-file", "-p", `${newCommit}:CLAUDE.md`);
  inClone("cat-file", "-p", `${newCommit}:a/plugin.json`);
  const read = async () => {
    const notices = [];
    const report = await analyzeRepository(clone, { onNotice: (line) => notices.push(line) });
    return { report, notices, components: expandRevisions(report).at(-1).components };
  };
  const first = await read();
  assert.ok(first.report.pluginPackagesLeftOut);
  assert.match(first.notices[0], /This is a partial clone/);
  // A left-out file an import reaches is an ordinary imported file, with no plugin entry.
  assert.deepEqual(
    first.components.map((component) => [component.path, Boolean(component.imported), component.plugins ?? null]),
    [
      [".claude-plugin/plugin.json", true, null],
      ["CLAUDE.md", false, null],
    ],
  );
  // That import's download does not change the next run.
  assert.deepEqual((await read()).components, first.components);
  const partialDelta = compareGitCommits(clone, oldCommit, newCommit);
  assert.equal(partialDelta.comparison.plugins, undefined);
  assert.ok(partialDelta.pluginPackagesLeftOut);
  assert.match(renderPullRequestDelta(partialDelta), /This is a partial clone/);
  // Git also marks a partial clone with `extensions.partialClone`.
  inClone("config", "--unset", "remote.origin.promisor");
  inClone("config", "core.repositoryformatversion", "1");
  inClone("config", "extensions.partialClone", "origin");
  assert.ok((await read()).report.pluginPackagesLeftOut);

  // An imported file that happens to be called plugin.json is not reported as renamed.
  const importedMove = syntheticRepo("strata-plugins-imported-move-");
  t.after(importedMove.cleanup);
  importedMove.put("CLAUDE.md", "@docs/plugin.json\n");
  importedMove.put("docs/plugin.json", '{"name":"not a package"}\n');
  importedMove.commit("Import it");
  importedMove.put("conf/.keep", "");
  importedMove.git("mv", "docs/plugin.json", "conf/plugin.json");
  importedMove.put("CLAUDE.md", "@conf/plugin.json\n");
  importedMove.commit("Move it");
  const moved = expandRevisions(await analyzeRepository(importedMove.repo)).at(-1);
  assert.ok(!moved.changes.some((change) => change.kind === "renamed"));

  // A plugin.json in an agent folder never makes a tool count as used, in a full or a partial clone.
  const agentFolder = syntheticRepo("strata-plugins-agent-folder-");
  t.after(agentFolder.cleanup);
  agentFolder.put("AGENTS.md", "Shared instructions.\n");
  const beforeManifest = agentFolder.commit("Instructions");
  agentFolder.put(".cursor/plugin.json", manifest("pub"));
  const afterManifest = agentFolder.commit("Publish from an agent folder");
  assert.ok(
    !compareGitCommits(agentFolder.repo, beforeManifest, afterManifest).upFront.some(
      (row) => row.provider === "cursor",
    ),
  );

  // A settings file saved in another encoding may still name its plugins.
  const encoded = syntheticRepo("strata-plugins-encoded-");
  t.after(encoded.cleanup);
  const settings = '{"enabledPlugins":{"fmt@tools":true}}';
  encoded.put(".claude/settings.json", settings);
  const utf8 = encoded.commit("UTF-8");
  encoded.put(".claude/settings.json", Buffer.from(`\uFEFF${settings}`, "utf16le"));
  const utf16 = encoded.commit("UTF-16");
  const reencoded = compareGitCommits(encoded.repo, utf8, utf16).comparison.plugins;
  assert.deepEqual([reencoded.removed.length, reencoded.afterUnresolved], [0, 1]);

  // Only Claude Code loads a plugin from a skill folder.
  const skillFolder = syntheticRepo("strata-plugins-skill-");
  t.after(skillFolder.cleanup);
  skillFolder.put(".cursor/rules/a.mdc", "---\nalwaysApply: true\n---\nRule.\n");
  skillFolder.put(".claude/skills/pack/.claude-plugin/plugin.json", '{"name":"pack"}\n');
  skillFolder.commit("A plugin in a skill folder");
  const folderReport = await analyzeRepository(skillFolder.repo);
  const latest = expandRevisions(folderReport).at(-1);
  const inView = (view) =>
    viewRevision(latest, view, undefined, folderReport.components).components.find((component) => component.skill);
  assert.ok(inView("claude").plugins);
  assert.ok(inView("cursor") && !inView("cursor").plugins);
});

test("reads only the documented plugin shapes, and marks anything else unresolved", () => {
  const unresolved = { status: "unresolved" };
  assert.equal(pluginRefs('{"theme":"enabledPlugins"}', "settings"), null);
  assert.deepEqual(pluginRefs('{"enabledPlugins":{"a@b":"yes"}}', "settings"), unresolved);
  assert.deepEqual(pluginRefs('{"enabledPlugins":[]}', "settings"), unresolved);
  // Claude's schema allows a list of strings, which Copilot does not document.
  assert.deepEqual(pluginRefs('{"enabledPlugins":{"a@m":["^1.0.0"]}}', "settings").plugins, [
    { name: "a@m", state: "configured" },
  ]);
  assert.deepEqual(pluginRefs('{"enabledPlugins":{"a@m":["^1.0.0"]}}', "copilot-settings"), unresolved);
  // A URL is not a path in this repository, whichever way it is written.
  for (const source of ['"https://example.invalid/p.git"', '"git@example.invalid:o/p.git"', '"/opt/p"', '"~/p"']) {
    const catalog = pluginRefs(`{"name":"m","plugins":[{"name":"p","source":${source}}]}`, "marketplace");
    assert.deepEqual(catalog.plugins[0].listed, { local: 0, external: 1 }, source);
  }
  assert.deepEqual(pluginRefs('[plugins.""]\nenabled = true\n', "codex-config"), unresolved);
  // A key written with a JSON escape is the same key.
  assert.deepEqual(pluginRefs('{"enabled\\u0050lugins":{"a@b":true}}', "settings").plugins, [
    { name: "a@b", state: "enabled" },
  ]);
  // An escape can hide the key in a file that does not parse, so its plugins are unknown.
  assert.deepEqual(pluginRefs('{"enabled\\u0050lugins":{"a@m":true},}', "settings"), unresolved);
  assert.deepEqual(pluginRefs('["plugin\\U00000073"."caf\\u00e9@m"]\nenabled = true\n', "codex-config"), unresolved);
  // Cursor documents only `name` as required for a marketplace entry; Claude also requires `source`.
  assert.deepEqual(pluginRefs('{"name":"m","plugins":[{"name":"p"}]}', "cursor-marketplace").plugins[0].listed, {
    local: 0,
    external: 1,
  });
  assert.deepEqual(
    pluginRefs('{"name":"m","plugins":[{"name":"p","source":"10.0.0.1:o/r"}]}', "marketplace").plugins[0].listed,
    {
      local: 0,
      external: 1,
    },
  );
  // A table Strata cannot read matters only under `plugins`.
  assert.equal(
    pluginRefs('[features]\nplugins = true\n[projects."caf\\u00e9"]\ntrust = "yes"\n', "codex-config"),
    null,
  );
  assert.deepEqual(pluginRefs('[plugins."caf\\u00e9@m"]\nenabled = true\n', "codex-config"), unresolved);
  assert.deepEqual(pluginRefs('{"version":"1"}', "manifest"), unresolved);
  assert.deepEqual(pluginRefs('{"name":"m","plugins":[{"name":"p"}]}', "marketplace"), unresolved);
  assert.equal(pluginRefs('model = "plugins"\n', "codex-config"), null);
  // A Codex table of MCP policy does not say whether the plugin is on, and leaves the others readable.
  assert.deepEqual(
    pluginRefs('[plugins."a@b"]\nenabled = false\n[plugins."c@d".mcp_servers.docs]\nenabled = true\n', "codex-config")
      .plugins,
    [
      { name: "a@b", state: "disabled" },
      { name: "c@d", state: "configured" },
    ],
  );
  // Copilot documents JSON with comments; Claude's settings stay strict.
  const commented = '// team defaults\n{"enabledPlugins":{"a@b":true,},}';
  assert.deepEqual(pluginRefs(commented, "copilot-settings").plugins, [{ name: "a@b", state: "enabled" }]);
  assert.deepEqual(pluginRefs(commented, "settings"), unresolved);
  // A Codex overlay can leave identity to the root manifest, and Codex skips an entry it cannot resolve.
  assert.deepEqual(pluginRefs('{"extensions":{}}', "codex-manifest"), { status: "listed", plugins: [] });
  assert.deepEqual(
    pluginRefs(
      '{"name":"m","plugins":[{"name":"ok","source":"./ok"},{"name":"bad","source":{"source":"local"}}]}',
      "codex-marketplace",
    ).plugins[0].listed,
    { local: 1, external: 0 },
  );
  assert.deepEqual(pluginRefs('[plugins]\n"a@b" = { enabled = true }\n', "codex-config"), unresolved);
});
