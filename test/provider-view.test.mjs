import assert from "node:assert/strict";
import test from "node:test";
import { providerReads, viewRevision } from "../dist/provider-view.js";

test("provider views count shared files once and split cross-provider moves", () => {
  const shared = {
    path: "AGENTS.md",
    provider: "shared",
    readers: ["claude", "codex"],
    category: "instructions",
    blob: "s",
    bytes: 40,
    estimatedTokens: 10,
  };
  const claudeFile = {
    path: ".claude/skills/example/SKILL.md",
    provider: "claude",
    category: "skills",
    blob: "c",
    bytes: 80,
    estimatedTokens: 20,
  };
  const codexFile = {
    ...claudeFile,
    path: ".agents/skills/example/SKILL.md",
    provider: "shared",
    readers: ["codex", "gemini"],
  };
  const first = {
    id: "first",
    date: "2026-10-01",
    firstParent: null,
    components: [shared, claudeFile],
    skillGroups: [],
    categoryTotals: {},
    estimatedTokens: 30,
    changes: [],
  };
  const second = {
    ...first,
    id: "second",
    components: [shared, codexFile],
    changes: [
      {
        kind: "renamed",
        path: codexFile.path,
        previousPath: claudeFile.path,
        previousTokens: 20,
        estimatedTokens: 20,
        deltaTokens: 0,
      },
    ],
  };
  const claude = viewRevision(second, "claude", first);
  const codex = viewRevision(second, "codex", first);
  assert.equal(claude.estimatedTokens, 10);
  assert.equal(codex.estimatedTokens, 30);
  assert.deepEqual(
    claude.changes.map((change) => [change.kind, change.path, change.deltaTokens]),
    [["removed", claudeFile.path, -20]],
  );
  assert.deepEqual(
    codex.changes.map((change) => [change.kind, change.path, change.deltaTokens]),
    [["added", codexFile.path, 20]],
  );
  assert.equal(viewRevision(second, "gemini", first).estimatedTokens, 20);
  assert.equal(viewRevision(second, "shared", first).estimatedTokens, 30);
  assert.deepEqual(viewRevision(second, "all", first), second);
});

test("the Gemini view follows each revision's context files, by label rather than path", () => {
  const shared = {
    path: "file-00001",
    provider: "shared",
    readers: ["claude", "codex"],
    contextFile: "agents-md",
    category: "instructions",
    blob: "s",
    bytes: 40,
    estimatedTokens: 10,
  };
  const geminiMd = { ...shared, path: "file-00002", provider: "gemini", contextFile: "gemini-md", blob: "m" };
  delete geminiMd.readers;
  const settings = {
    path: "file-00003",
    provider: "gemini",
    category: "settings",
    blob: "g1",
    bytes: 2,
    estimatedTokens: null,
  };
  const configuredSettings = { ...settings, blob: "g2" };
  const table = [shared, geminiMd, settings, configuredSettings];
  const defaults = {
    id: "default",
    date: "2026-10-01",
    firstParent: null,
    components: [shared, geminiMd, settings],
    skillGroups: [],
    categoryTotals: {},
    estimatedTokens: 20,
    changes: [],
  };
  const agentsOnly = {
    ...defaults,
    id: "agents-only",
    components: [shared, geminiMd, configuredSettings],
    geminiContextFiles: ["agents-md"],
    changes: [
      {
        kind: "modified",
        path: settings.path,
        previousTokens: null,
        estimatedTokens: null,
        deltaTokens: 0,
        component: 3,
      },
    ],
  };
  assert.equal(providerReads(shared, "gemini"), false);
  assert.equal(providerReads(geminiMd, "gemini"), true);
  assert.equal(providerReads(shared, "gemini", ["agents-md"]), true);
  assert.equal(providerReads(geminiMd, "gemini", []), false);
  assert.equal(viewRevision(defaults, "gemini").estimatedTokens, 10);
  const view = viewRevision(agentsOnly, "gemini", defaults, table);
  assert.deepEqual(
    view.components.map((component) => component.path),
    [shared.path, configuredSettings.path],
  );
  assert.equal(viewRevision(agentsOnly, "claude", defaults).estimatedTokens, 10);
  assert.deepEqual(
    view.changes.map((change) => [change.kind, change.path, change.deltaTokens, change.component]),
    [
      ["modified", settings.path, 0, 3],
      ["added", shared.path, 10, 0],
      ["removed", geminiMd.path, -10, null],
    ],
  );
});

test("Cursor reads other tools' files only at revisions that track Cursor configuration", () => {
  const agents = {
    path: "file-00001",
    provider: "shared",
    readers: ["claude", "codex", "cursor"],
    contextFile: "agents-md",
    category: "instructions",
    blob: "a",
    bytes: 40,
    estimatedTokens: 10,
  };
  const claudeSkill = {
    path: "file-00002",
    provider: "claude",
    readers: ["claude", "cursor"],
    category: "skills",
    blob: "k",
    bytes: 20,
    estimatedTokens: 5,
  };
  const settings = {
    path: "file-00003",
    provider: "gemini",
    category: "settings",
    blob: "g1",
    bytes: 2,
    estimatedTokens: null,
  };
  const configuredSettings = { ...settings, blob: "g2" };
  const cursorIgnore = {
    path: "file-00004",
    provider: "cursor",
    category: "settings",
    blob: "c",
    bytes: 9,
    estimatedTokens: null,
  };
  const table = [agents, claudeSkill, settings, configuredSettings, cursorIgnore];
  const before = {
    id: "before",
    date: "2026-10-01",
    firstParent: null,
    components: [agents, claudeSkill, settings],
    skillGroups: [],
    categoryTotals: {},
    estimatedTokens: 15,
    changes: [],
  };
  // One revision both configures Gemini to read AGENTS.md and adds the first Cursor file.
  const after = {
    ...before,
    id: "after",
    components: [agents, claudeSkill, configuredSettings, cursorIgnore],
    geminiContextFiles: ["agents-md"],
    changes: [
      {
        kind: "modified",
        path: settings.path,
        previousTokens: null,
        estimatedTokens: null,
        deltaTokens: 0,
        component: 3,
      },
      {
        kind: "added",
        path: cursorIgnore.path,
        previousTokens: null,
        estimatedTokens: null,
        deltaTokens: 0,
        component: 4,
      },
    ],
  };
  assert.equal(providerReads(claudeSkill, "cursor"), false);
  assert.equal(providerReads(claudeSkill, "cursor", null, true), true);
  assert.equal(providerReads(cursorIgnore, "cursor"), true);
  assert.equal(providerReads(claudeSkill, "claude"), true);
  assert.equal(providerReads(agents, "codex", null, false), true);

  const changes = (view) =>
    viewRevision(after, view, before, table).changes.map((change) => [change.kind, change.path]);
  assert.deepEqual(viewRevision(before, "cursor").components, []);
  assert.deepEqual(changes("cursor"), [
    ["added", cursorIgnore.path],
    ["added", agents.path],
    ["added", claudeSkill.path],
  ]);
  assert.deepEqual(changes("gemini"), [
    ["modified", settings.path],
    ["added", agents.path],
  ]);
  assert.deepEqual(changes("claude"), []);
  assert.deepEqual(
    viewRevision(after, "shared").components.map((component) => component.path),
    [agents.path],
  );
  // Removing the last Cursor file takes the borrowed files out of the Cursor view again.
  const removed = {
    ...after,
    id: "removed",
    components: [agents, claudeSkill, configuredSettings],
    changes: [
      {
        kind: "removed",
        path: cursorIgnore.path,
        previousTokens: null,
        estimatedTokens: null,
        deltaTokens: 0,
        component: null,
      },
    ],
  };
  assert.deepEqual(
    viewRevision(removed, "cursor", after, table).changes.map((change) => [change.kind, change.path]),
    [
      ["removed", cursorIgnore.path],
      ["removed", agents.path],
      ["removed", claudeSkill.path],
    ],
  );
});

test("Copilot and Cursor each read other tools' files only where their own configuration is tracked", () => {
  const component = (path, provider, category, readers, extra = {}) => ({
    path,
    provider,
    ...(readers ? { readers } : {}),
    category,
    blob: path,
    bytes: 8,
    estimatedTokens: 2,
    ...extra,
  });
  const agents = component("file-00001", "shared", "instructions", ["claude", "codex", "copilot", "cursor"], {
    contextFile: "agents-md",
  });
  const gemini = component("file-00002", "gemini", "instructions", ["copilot", "gemini"], {
    contextFile: "gemini-md",
  });
  const claudeSkill = component("file-00003", "claude", "skills", ["claude", "copilot", "cursor"]);
  const claudeRule = component("file-00004", "claude", "rules", ["claude", "copilot"]);
  const instructions = component("file-00005", "copilot", "instructions");
  const table = [agents, gemini, claudeSkill, claudeRule, instructions];
  const before = {
    id: "before",
    date: "2026-10-01",
    firstParent: null,
    components: [agents, gemini, claudeSkill, claudeRule],
    skillGroups: [],
    categoryTotals: {},
    estimatedTokens: 8,
    changes: [],
  };
  const after = {
    ...before,
    id: "after",
    components: [...before.components, instructions],
    changes: [
      {
        kind: "added",
        path: instructions.path,
        previousTokens: null,
        estimatedTokens: 2,
        deltaTokens: 2,
        component: 4,
      },
    ],
  };
  assert.equal(providerReads(claudeRule, "copilot"), false);
  assert.equal(providerReads(claudeRule, "copilot", null, true), true);
  // Copilot reads GEMINI.md whatever Gemini's settings say; Gemini follows them.
  assert.equal(providerReads(gemini, "copilot", ["agents-md"], true), true);
  assert.equal(providerReads(gemini, "gemini", ["agents-md"]), false);

  const paths = (revision, view) => viewRevision(revision, view).components.map((entry) => entry.path);
  assert.deepEqual(paths(before, "copilot"), []);
  assert.deepEqual(paths(after, "copilot"), [
    agents.path,
    gemini.path,
    claudeSkill.path,
    claudeRule.path,
    instructions.path,
  ]);
  // A Copilot file does not make Cursor read anything.
  assert.deepEqual(paths(after, "cursor"), []);
  assert.deepEqual(
    viewRevision(after, "copilot", before, table).changes.map((change) => [change.kind, change.path]),
    [
      ["added", instructions.path],
      ["added", agents.path],
      ["added", gemini.path],
      ["added", claudeSkill.path],
      ["added", claudeRule.path],
    ],
  );
  assert.deepEqual(viewRevision(after, "claude", before, table).changes, []);
});
