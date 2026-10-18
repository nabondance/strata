import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);

function skillNames(dir) {
  return readdirSync(new URL(dir, root), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

test("each repository skill has identical Claude and shared copies", () => {
  const claude = skillNames(".claude/skills/");
  assert.deepEqual(claude, skillNames(".agents/skills/"));
  for (const name of claude) {
    const claudeCopy = readFileSync(new URL(`.claude/skills/${name}/SKILL.md`, root), "utf8");
    const sharedCopy = readFileSync(new URL(`.agents/skills/${name}/SKILL.md`, root), "utf8");
    assert.ok(claudeCopy === sharedCopy, `${name}: .claude/skills and .agents/skills copies differ`);
  }
});
