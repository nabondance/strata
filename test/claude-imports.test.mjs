import assert from "node:assert/strict";
import test from "node:test";
import { importPaths, maxImportHops, readImports, resolveImport } from "../dist/claude-imports.js";
import { importLinks } from "../dist/import-links.js";

test("reads @path imports where Claude Code does, outside code and comments", () => {
  const text = [
    "@AGENTS.md",
    "See @README for an overview and @package.json for scripts.",
    "- API conventions @Design\\ Docs/api-conventions.md",
    "- git workflow @docs/git.md#branches, and @./local.md",
    'Mail someone@example.com, or quote "@quoted.md", or write @@twice or @#heading.',
    "Keep `@literal.md` literal, but `code`@after-span.md imports.",
    "``a ` @inside-double.md``",
    "```md",
    "@fenced.md",
    "```",
    "~~~",
    "@tilde-fenced.md",
    "~~~~",
    "<!-- @commented.md",
    "still a comment @commented-too.md -->@after-comment.md",
    "An unmatched ` backtick leaves @open-tick.md as text.",
    "@~/.claude/personal.md and @/etc/absolute.md",
  ].join("\n");
  assert.deepEqual(importPaths(text), [
    { path: "AGENTS.md", line: 1 },
    { path: "README", line: 2 },
    { path: "package.json", line: 2 },
    { path: "Design Docs/api-conventions.md", line: 3 },
    { path: "docs/git.md", line: 4 },
    { path: "./local.md", line: 4 },
    { path: "after-span.md", line: 6 },
    { path: "open-tick.md", line: 16 },
    { path: "~/.claude/personal.md", line: 17 },
    { path: "/etc/absolute.md", line: 17 },
  ]);
  // A fence opened and never closed runs to the end of the file.
  assert.deepEqual(importPaths("@before.md\n```\n@never.md\n"), [{ path: "before.md", line: 1 }]);
  // A code span does not cross a blank line, so a lone backtick there is literal.
  assert.deepEqual(importPaths("a ` b\n\n@next.md `"), [{ path: "next.md", line: 3 }]);
  // A `<!--` with no `-->` in its paragraph, or inside a code span, is literal text and hides nothing.
  assert.deepEqual(importPaths("Start a comment with `<!--`.\n\n@docs/a.md\n"), [{ path: "docs/a.md", line: 3 }]);
  assert.deepEqual(importPaths("Use <!-- for comments\n\n@docs/a.md\n"), [{ path: "docs/a.md", line: 3 }]);
  assert.deepEqual(importPaths("x <!-- y @after-open.md"), [{ path: "after-open.md", line: 1 }]);
  // A comment inside a code span is code, and a code span inside a comment is comment.
  assert.deepEqual(importPaths("`<!--` @a.md `-->` @b.md\nsee <!-- `x` @c.md --> @d.md"), [
    { path: "a.md", line: 1 },
    { path: "b.md", line: 1 },
    { path: "d.md", line: 2 },
  ]);
  assert.deepEqual(importPaths("﻿@bom.md\r\n@crlf.md\r\n"), [
    { path: "bom.md", line: 1 },
    { path: "crlf.md", line: 2 },
  ]);
});

test("resolves imports against the importing file's directory, inside the repository only", () => {
  assert.equal(resolveImport("AGENTS.md", "CLAUDE.md"), "AGENTS.md");
  assert.equal(resolveImport("AGENTS.md", ".claude/CLAUDE.md"), ".claude/AGENTS.md");
  assert.equal(resolveImport("../AGENTS.md", ".claude/CLAUDE.md"), "AGENTS.md");
  assert.equal(resolveImport("./docs/../guide.md", "packages/app/CLAUDE.md"), "packages/app/guide.md");
  assert.equal(resolveImport("../../outside.md", "packages/CLAUDE.md"), null);
  assert.equal(resolveImport("~/.claude/personal.md", "CLAUDE.md"), null);
  assert.equal(resolveImport("/etc/absolute.md", "CLAUDE.md"), null);
  // The repository root and directories are not files; analysis never reads their history.
  assert.equal(resolveImport(".", "CLAUDE.md"), ".");
  assert.equal(resolveImport("./", "docs/CLAUDE.md"), "docs/");
  // One entry per target, at its first line; each external import is kept.
  assert.deepEqual(readImports("@a.md\n@./a.md @~/x.md\n@~/y.md\n@../up.md", "docs/CLAUDE.md"), [
    { line: 1, target: "docs/a.md" },
    { line: 2, target: null, external: true },
    { line: 3, target: null, external: true },
    { line: 4, target: "up.md" },
  ]);
});

test("follows imports from the roots by the shortest chain, up to four hops", () => {
  const instructions = { provider: "claude", category: "instructions", importRoot: true };
  const imported = { provider: "claude", category: "instructions", imported: true };
  const links = importLinks([
    { path: "AGENTS.md", provider: "shared", category: "instructions", contextFile: "agents-md" },
    {
      path: "CLAUDE.md",
      ...instructions,
      imports: [
        { line: 1, target: "a.md" },
        { line: 2, target: "c.md" },
      ],
    },
    { path: "a.md", ...imported, imports: [{ line: 1, target: "b.md" }] },
    { path: "b.md", ...imported, imports: [{ line: 1, target: "c.md" }] },
    { path: "c.md", ...imported, imports: [{ line: 3, target: "d.md" }] },
    { path: "d.md", ...imported, imports: [{ line: 1, target: "e.md" }] },
    { path: "e.md", ...imported, imports: [{ line: 1, target: "f.md" }] },
    {
      path: "f.md",
      ...imported,
      imports: [
        { line: 1, target: "g.md" },
        { line: 2, target: null, external: true },
      ],
    },
    { path: "g.md", ...imported, imports: [{ line: 1, target: "CLAUDE.md" }] },
    // A rule is not a root, so its imports count only once something imports it.
    { path: ".claude/rules/r.md", provider: "claude", category: "rules", imports: [{ line: 1, target: "x.md" }] },
    // Neither is REVIEW.md, a Claude instruction file that sessions do not load.
    { path: "REVIEW.md", provider: "claude", category: "instructions", imports: [{ line: 1, target: "y.md" }] },
    {
      path: "CLAUDE.local.md",
      ...instructions,
      imports: [
        { line: 4, target: null, external: true },
        { line: 5, target: "gone.md" },
        // A path no file has is stored without its text.
        { line: 6, target: null },
      ],
    },
  ]);
  assert.deepEqual(
    links.map(({ source, target, hop, status }) => [source, target, hop, status]),
    [
      ["CLAUDE.md", "a.md", 1, "resolved"],
      ["CLAUDE.md", "c.md", 1, "resolved"],
      ["CLAUDE.local.md", null, 1, "external"],
      ["CLAUDE.local.md", "gone.md", 1, "missing"],
      ["CLAUDE.local.md", null, 1, "missing"],
      ["a.md", "b.md", 2, "resolved"],
      ["c.md", "d.md", 2, "resolved"],
      ["b.md", "c.md", 3, "resolved"],
      ["d.md", "e.md", 3, "resolved"],
      ["e.md", "f.md", 4, "resolved"],
      ["f.md", "g.md", 5, "depth-limit"],
      // Claude Code does not expand a file past the limit, so its external import is past the limit too.
      ["f.md", null, 5, "depth-limit"],
    ],
  );
  assert.ok(links.every((link) => link.kind === "links to" && link.evidence === "claude-import"));
  // `importLinks` is embedded in the HTML report, so it keeps its own copy of the limit; they must agree.
  assert.equal(maxImportHops, 4);
  assert.ok(importLinks.toString().includes(`maxHops = ${maxImportHops}`));
});

test("starts at AGENTS.md only where no CLAUDE.md chain reaches it", () => {
  const agents = { provider: "shared", category: "instructions", contextFile: "agents-md", importRoot: true };
  const imported = { provider: "claude", category: "instructions", imported: true };
  const chain = [
    { path: "AGENTS.md", ...agents, imports: [{ line: 1, target: "a.md" }] },
    { path: "a.md", ...imported, imports: [{ line: 1, target: "b.md" }] },
    { path: "b.md", ...imported, imports: [{ line: 1, target: "c.md" }] },
    { path: "c.md", ...imported, imports: [{ line: 1, target: "d.md" }] },
    { path: "d.md", ...imported, imports: [{ line: 1, target: "e.md" }] },
    { path: "e.md", ...imported },
  ];
  const hops = (components) => importLinks(components).map(({ source, hop, status }) => `${source} ${hop} ${status}`);
  const claude = { path: "CLAUDE.md", provider: "claude", category: "instructions", importRoot: true };
  // Imported by CLAUDE.md, AGENTS.md is the first hop, so its chain meets the limit one file sooner.
  assert.deepEqual(hops([{ ...claude, imports: [{ line: 1, target: "AGENTS.md" }] }, ...chain]), [
    "CLAUDE.md 1 resolved",
    "AGENTS.md 2 resolved",
    "a.md 3 resolved",
    "b.md 4 resolved",
    "c.md 5 depth-limit",
  ]);
  // Without one, AGENTS.md starts the chain.
  assert.deepEqual(hops(chain), [
    "AGENTS.md 1 resolved",
    "a.md 2 resolved",
    "b.md 3 resolved",
    "c.md 4 resolved",
    "d.md 5 depth-limit",
  ]);
  // A cycle ends where a file is already reached.
  assert.deepEqual(hops([{ ...chain[0], imports: [{ line: 1, target: "AGENTS.md" }] }]), ["AGENTS.md 1 resolved"]);
});
