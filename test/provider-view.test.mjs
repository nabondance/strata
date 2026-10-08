import assert from "node:assert/strict";
import test from "node:test";
import { viewRevision } from "../dist/provider-view.js";

test("provider views count shared files once and split cross-provider moves", () => {
  const shared = { path: "AGENTS.md", provider: "shared", category: "instructions", blob: "s", bytes: 40, estimatedTokens: 10 };
  const claudeFile = { path: ".claude/skills/example/SKILL.md", provider: "claude", category: "skills", blob: "c", bytes: 80, estimatedTokens: 20 };
  const codexFile = { ...claudeFile, path: ".agents/skills/example/SKILL.md", provider: "codex" };
  const first = { id: "first", date: "2026-10-01", firstParent: null, components: [shared, claudeFile], skillGroups: [],
    categoryTotals: {}, estimatedTokens: 30, changes: [] };
  const second = { ...first, id: "second", components: [shared, codexFile], changes: [{ kind: "renamed",
    path: codexFile.path, previousPath: claudeFile.path, previousTokens: 20, estimatedTokens: 20, deltaTokens: 0 }] };
  const claude = viewRevision(second, "claude", first);
  const codex = viewRevision(second, "codex", first);
  assert.equal(claude.estimatedTokens, 10);
  assert.equal(codex.estimatedTokens, 30);
  assert.deepEqual(claude.changes.map((change) => [change.kind, change.path, change.deltaTokens]),
    [["removed", claudeFile.path, -20]]);
  assert.deepEqual(codex.changes.map((change) => [change.kind, change.path, change.deltaTokens]),
    [["added", codexFile.path, 20]]);
  assert.equal(viewRevision(second, "shared", first).estimatedTokens, 10);
  assert.deepEqual(viewRevision(second, "all", first), second);
});
