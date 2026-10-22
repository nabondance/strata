import assert from "node:assert/strict";
import test from "node:test";
import { configMap } from "../dist/config-map.js";
import { importLinks } from "../dist/import-links.js";

const file = (path, estimatedTokens, extra = {}) => ({ path, category: "instructions", estimatedTokens, ...extra });
const outline = (map) =>
  map.rows.map(
    (row) => `${"  ".repeat(row.depth)}${row.label}${row.kind === "folder" ? `/${row.collapsed ? " +" : ""}` : ""}`,
  );

test("lays files out as a folder tree with shared rows for single-folder chains", () => {
  const components = [
    file(".claude/skills/review/SKILL.md", 40, { category: "skills" }),
    file(".claude/skills/review/notes.txt", null, { category: "skills" }),
    file("AGENTS.md", 10),
    file("CLAUDE.md", 5),
    file("docs/a.md", 0),
  ];
  const map = configMap(components, []);
  assert.deepEqual(outline(map), [
    ".claude/skills/review/",
    "  SKILL.md",
    "  notes.txt",
    "docs/",
    "  a.md",
    "AGENTS.md",
    "CLAUDE.md",
  ]);
  // The shared row opens the last folder of the chain, so toggling it uses that path.
  assert.equal(map.rows[0].path, ".claude/skills/review");
  assert.equal(map.folders, 4);
  assert.deepEqual(
    [map.rows[0].files, map.rows[0].sourceOnly, map.rows[0].tokens, map.rows[0].categories],
    [2, 1, 40, [{ category: "skills", tokens: 40 }]],
  );
  // A source-only file has no tokens; a zero-token file has zero.
  assert.equal(map.rows[2].tokens, null);
  assert.equal(map.rows[4].tokens, 0);
  assert.equal(map.totalTokens, 55);
  assert.deepEqual(
    map.rows.map((row) => [row.parent, row.position, row.siblings]),
    [
      [-1, 1, 4],
      [0, 1, 2],
      [0, 2, 2],
      [-1, 2, 4],
      [3, 1, 1],
      [-1, 3, 4],
      [-1, 4, 4],
    ],
  );
  assert.deepEqual(map.rowOf, [1, 2, 5, 6, 4]);
  assert.deepEqual(configMap([], []).rows, []);
  // A row several folders share follows the choice for the deepest of them that has one.
  assert.deepEqual(map.rows[0].chain, [".claude", ".claude/skills", ".claude/skills/review"]);
  const closedOuter = configMap(components, [], { toggled: new Map([[".claude", true]]) });
  assert.equal(closedOuter.rows[0].collapsed, true);
  const reopened = configMap(components, [], {
    toggled: new Map([
      [".claude", true],
      [".claude/skills/review", false],
    ]),
  });
  assert.equal(reopened.rows[0].collapsed, false);
});

test("opens folders as deep as the row budget allows and keeps the reader's choices", () => {
  const components = [file("CLAUDE.md", 1)];
  for (let skill = 0; skill < 10; skill += 1) {
    for (let resource = 0; resource < 8; resource += 1) {
      components.push(file(`.claude/skills/s${skill}/r${resource}.md`, 1));
    }
  }
  // Opening the skill folders would pass 80 rows, so they start closed; the root level is always open.
  const auto = configMap(components, []);
  assert.deepEqual(outline(auto).slice(0, 3), [".claude/skills/", "  s0/ +", "  s1/ +"]);
  assert.equal(auto.rows.length, 12);
  assert.equal(auto.rowOf[1], 1);
  // Opening one folder adds its rows and closes nothing else.
  const opened = configMap(components, [], { toggled: new Map([[".claude/skills/s1", false]]) });
  assert.equal(opened.rows.length, 20);
  assert.equal(opened.rows.filter((row) => row.kind === "folder" && !row.collapsed).length, 2);
  assert.equal(configMap(components, [], { fallback: "expanded" }).rows.length, 92);
  assert.deepEqual(outline(configMap(components, [], { fallback: "collapsed" })), [".claude/skills/ +", "CLAUDE.md"]);
  // A small repository opens completely.
  assert.equal(configMap(components.slice(0, 9), [], {}).rows.filter((row) => row.collapsed).length, 0);
});

test("draws resolved imports between rows and counts the rest", () => {
  const components = [
    file("CLAUDE.md", 5, {
      importRoot: true,
      imports: [
        { line: 1, target: "docs/guide.md" },
        { line: 2, target: "docs/missing.md" },
        { line: 3, target: null, external: true },
        { line: 4, target: "rules/a.md" },
      ],
    }),
    file("docs/guide.md", 8, { imported: true, imports: [{ line: 1, target: "docs/deep.md" }] }),
    file("docs/deep.md", 3, { imported: true }),
    file("rules/a.md", 2, { imported: true }),
  ];
  const links = importLinks(components);
  const open = configMap(components, links, { fallback: "expanded" });
  assert.deepEqual(outline(open), ["docs/", "  deep.md", "  guide.md", "rules/", "  a.md", "CLAUDE.md"]);
  assert.deepEqual(
    open.edges.map(({ from, to, links }) => [from, to, links.length]),
    [
      [2, 1, 1],
      [5, 2, 1],
      [5, 4, 1],
    ],
  );
  // Each file's resolved imports, both ways, for the detail line.
  assert.deepEqual(
    [...open.targets],
    [
      ["CLAUDE.md", ["docs/guide.md", "rules/a.md"]],
      ["docs/guide.md", ["docs/deep.md"]],
    ],
  );
  assert.deepEqual(open.sources.get("docs/deep.md"), ["docs/guide.md"]);
  // Unresolved imports are counted on the importing row and never drawn.
  assert.equal(open.unresolved, 2);
  assert.equal(open.rows[5].unresolved, 2);
  // A closed folder takes the lines of the files it holds; an import inside it has no line.
  const closed = configMap(components, links, { fallback: "collapsed" });
  assert.deepEqual(outline(closed), ["docs/ +", "rules/ +", "CLAUDE.md"]);
  assert.deepEqual(
    closed.edges.map(({ from, to }) => [from, to]),
    [
      [2, 0],
      [2, 1],
    ],
  );
  assert.equal(closed.folded, 1);
  // Imports with a file outside the given components, such as in a provider view, are counted apart.
  const view = configMap(components.slice(0, 2), links, { fallback: "expanded" });
  assert.equal(view.edges.length, 1);
  assert.equal(view.offMap, 2);
  assert.equal(view.unresolved, 2);
  // Unresolved imports count wherever the importing file is; a file importing itself gets no line.
  const elsewhere = configMap(components.slice(1), links, { fallback: "expanded" });
  assert.deepEqual([elsewhere.unresolved, elsewhere.offMap, elsewhere.edges.length], [2, 2, 1]);
  const self = [file("CLAUDE.md", 1, { importRoot: true, imports: [{ line: 1, target: "CLAUDE.md" }] })];
  const selfMap = configMap(self, importLinks(self));
  assert.deepEqual([selfMap.edges.length, selfMap.folded, selfMap.offMap], [0, 0, 0]);
});
