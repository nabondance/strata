import assert from "node:assert/strict";
import test from "node:test";
import { ignoreMatcher } from "../dist/ignore.js";

/** Assert which paths a single pattern leaves out and which it keeps. */
function check(pattern, matches, keeps) {
  const ignored = ignoreMatcher([pattern]);
  for (const path of matches) assert.ok(ignored(path), `${pattern} should match ${path}`);
  for (const path of keeps) assert.ok(!ignored(path), `${pattern} should not match ${path}`);
}

test("* matches within one path segment, and ? one character of it", () => {
  check("*.md", ["a.md", "docs/a.md"], ["a.mdx", "a.md.txt"]);
  check("docs/*.md", ["docs/a.md"], ["docs/sub/a.md"]);
  check("a?c.md", ["abc.md", "x/aZc.md"], ["a/c.md", "abbc.md"]);
});

test("** spans any number of folders at the start, the end, or the middle", () => {
  check("**/fixtures", ["fixtures/CLAUDE.md", "a/b/fixtures/CLAUDE.md"], ["fixturesx/CLAUDE.md"]);
  check("examples/**", ["examples/AGENTS.md", "examples/a/b/SKILL.md"], ["examples", "src/examples/AGENTS.md"]);
  check("a/**/b.md", ["a/b.md", "a/x/b.md", "a/x/y/b.md"], ["a/xb.md", "x/a/b.md"]);
  check("a/**/**/b.md", ["a/b.md", "a/x/y/b.md"], []);
  check("**", ["CLAUDE.md", "any/path/at/all"], []);
  // Asterisks inside a segment are a single *.
  check("a**b.md", ["axyzb.md"], ["a/b.md"]);
});

test("a trailing / matches a folder and everything under it, but not a file of that name", () => {
  check("templates/", ["templates/a/AGENTS.md", "packages/templates/CLAUDE.md"], ["templates", "templatesx/a.md"]);
  check("examples/agent/", ["examples/agent/AGENTS.md"], ["examples/agent", "x/examples/agent/AGENTS.md"]);
});

test("a leading or middle / anchors at the root; a pattern without / matches at any depth", () => {
  check("/CLAUDE.md", ["CLAUDE.md"], ["packages/CLAUDE.md"]);
  check("/examples", ["examples/AGENTS.md"], ["src/examples/AGENTS.md"]);
  check("examples/agent", ["examples/agent/AGENTS.md"], ["src/examples/agent/AGENTS.md"]);
  check("CLAUDE.md", ["CLAUDE.md", "a/b/CLAUDE.md"], ["a/CLAUDE.mdx", "XCLAUDE.md"]);
  // A pattern matching a folder name leaves out everything inside it.
  check("fixtures", ["fixtures/CLAUDE.md", "test/fixtures/a/AGENTS.md"], ["fixtures.md"]);
});

test("other characters match themselves, and a path matching any pattern is ignored", () => {
  check("x[1].md", ["x[1].md"], ["x1.md"]);
  check("a+b.md", ["a+b.md"], ["aab.md"]);
  const ignored = ignoreMatcher(["examples/**", "templates/"]);
  assert.ok(ignored("examples/a.md"));
  assert.ok(ignored("templates/a.md"));
  assert.ok(!ignored("AGENTS.md"));
  assert.equal(ignoreMatcher([])("anything"), false);
});

test("empty, root-only, and negated patterns are refused", () => {
  for (const pattern of ["", "  ", "/", "//"]) assert.throws(() => ignoreMatcher([pattern]), /pattern/);
  assert.throws(() => ignoreMatcher(["!examples/keep.md"]), /re-include/);
});
