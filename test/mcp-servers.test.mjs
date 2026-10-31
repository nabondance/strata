import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { analyzeRepository } from "../dist/analyze.js";
import { compareRevisions } from "../dist/compare.js";
import { expandRevisions } from "../dist/expand.js";
import { compareGitCommits, renderPullRequestDelta } from "../dist/pr-delta.js";
import { redactReport } from "../dist/privacy.js";
import { renderHtml } from "../dist/report.js";
import { loadReportUi } from "./report-ui.mjs";
import { syntheticRepo } from "./synthetic-repo.mjs";

test("lists the MCP servers tracked files define, without storing their commands or URLs", async () => {
  const { codexServers, mcpServers } = await import("../dist/mcp-servers.js");
  const { repo, put, commit, cleanup } = syntheticRepo("strata-mcp-");
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
    assert.equal(report.schemaVersion, 21);
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
    assert.equal(delta.schemaVersion, 13);
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
    // Added and removed servers are listed one per line, with the file that defines each.
    const flat = (node) => (node.textContent ?? "") + node.children.map(flat).join("");
    assert.deepEqual(
      ui
        .get("compare-mcp-names")
        .children.map((group) => [group.children[0].textContent, ...group.children[1].children.map(flat)]),
      [
        ["MCP servers added (1)", "github .mcp.json"],
        ["MCP servers removed (1)", "local .vscode/mcp.json"],
      ],
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
    cleanup();
  }
});
