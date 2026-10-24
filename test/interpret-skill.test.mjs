import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Source without comment lines, so a label must appear in markup or a string the report shows.
const code = (path) =>
  read(path)
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join("\n");

// The shipped skill names the report schema versions it describes; a schema bump must update it.
test("the interpretation skill describes the current report schema versions", () => {
  const skill = read("skills/strata-interpret/SKILL.md");
  const history = read("src/model.ts").match(/schemaVersion: (\d+);/)?.[1];
  const diff = read("src/pr-delta.ts").match(/schemaVersion: (\d+);/)?.[1];
  assert.ok(history && diff);
  assert.match(skill, new RegExp(`describes history schema version ${history};`));
  assert.match(skill, new RegExp(`A \`strata diff\` JSON comparison \\(schema version ${diff};`));
});

// The skill names report panels, tabs, and labels in bold; each must still be text the report shows.
test("the interpretation skill names HTML labels the report still shows", () => {
  const skill = read("skills/strata-interpret/SKILL.md");
  const report = code("src/report.ts");
  const start = skill.indexOf("If the user asks about something they saw in the HTML report");
  const end = skill.indexOf("The default local report omits source text");
  assert.ok(start >= 0 && end > start);
  const labels = [...skill.slice(start, end).matchAll(/\*\*(.+?)\*\*/g)].map((match) =>
    match[1].replace("<Provider> ", ""),
  );
  assert.ok(labels.length > 20);
  for (const label of labels) {
    // Bounded by markup or a string quote, so a CSS class, id, or longer word does not count.
    const shown = new RegExp(`[>'"\`]\\s*${escapeRegExp(label)}(?=\\s*[<'"\`·(:]|\\s*$)`, "m");
    assert.match(report, shown, `report.ts does not show "${label}"`);
  }
});

// The skill states what the diff Markdown keeps; those limits live in renderPullRequestDelta.
test("the interpretation skill states the diff Markdown limits", () => {
  const skill = read("skills/strata-interpret/SKILL.md");
  const markdown = code("src/pr-delta.ts");
  assert.match(skill, /commit IDs are cut to 12 characters/);
  assert.match(markdown, /delta\.base\.slice\(0, 12\)/);
  assert.match(skill, /only the 25 files with the largest token change/);
  assert.match(markdown, /components\s*\.slice\(0, 25\)/);
  assert.match(code("src/compare.ts"), /Math\.abs\(b\.deltaTokens\) - Math\.abs\(a\.deltaTokens\)/);
  assert.match(skill, /MCP names stop at ten per list/);
  assert.match(markdown, /refs\.slice\(0, 10\)/);
});

// Quoted labels are text the report or the diff Markdown prints; each must still be printed.
test("the interpretation skill quotes text the report and the diff Markdown still print", () => {
  const skill = read("skills/strata-interpret/SKILL.md");
  const quoted = (from, to) =>
    [...skill.slice(skill.indexOf(from), skill.indexOf(to)).matchAll(/"([^"`]+)"/g)].map((match) => match[1]);
  const html = quoted("If the user asks about something they saw in the HTML report", "The default local report omits");
  const markdown = quoted("`strata diff` writes Markdown by default", "Other outputs carry less.").filter(
    (text) => text !== "0",
  );
  assert.ok(html.length > 8 && markdown.length > 0);
  const report = code("src/report.ts");
  for (const text of html) assert.ok(report.includes(text), `report.ts does not print "${text}"`);
  const delta = code("src/pr-delta.ts");
  for (const text of markdown) assert.ok(delta.includes(text), `pr-delta.ts does not print "${text}"`);
});
