import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

// The shipped skill names the report schema versions it describes; a schema bump must update it.
test("the interpretation skill describes the current report schema versions", () => {
  const skill = read("skills/strata-interpret/SKILL.md");
  const history = read("src/model.ts").match(/schemaVersion: (\d+);/)?.[1];
  const diff = read("src/pr-delta.ts").match(/schemaVersion: (\d+);/)?.[1];
  assert.ok(history && diff);
  assert.match(skill, new RegExp(`describes history schema version ${history};`));
  assert.match(skill, new RegExp(`A \`strata diff\` JSON comparison \\(schema version ${diff};`));
});

// The skill names report panels, tabs, and labels in bold; each must still exist in the report.
test("the interpretation skill names HTML labels the report still shows", () => {
  const skill = read("skills/strata-interpret/SKILL.md");
  const report = read("src/report.ts");
  const start = skill.indexOf("If the user asks about something they saw in the HTML report");
  const end = skill.indexOf("The default local report omits source text");
  assert.ok(start >= 0 && end > start);
  const labels = [...skill.slice(start, end).matchAll(/\*\*(.+?)\*\*/g)].map((match) =>
    match[1].replace("<Provider> ", ""),
  );
  assert.ok(labels.length > 20);
  for (const label of labels) assert.ok(report.includes(label), `report.ts has no "${label}"`);
});
