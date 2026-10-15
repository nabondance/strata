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
