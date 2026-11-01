import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

// A tag such as actions/setup-node@v7 can be moved to other code, a commit
// cannot. The composite Action runs in users' repositories, and workflows that
// can write can push, release, or publish to npm, so those pin every action to
// a full commit SHA. Only workflows that are read-only for certain may use
// release tags, and so may the local reusable workflows they call.

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const workflowPaths = readdirSync(new URL(".github/workflows/", root))
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => `.github/workflows/${name}`);

const withoutComments = (text) => text.replace(/(^|\s)#.*$/gm, "$1");
const refs = (text) =>
  [...withoutComments(text).matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)].map((match) =>
    match[1].replace(/^["']|["']$/g, ""),
  );

// The text of every permissions block: the key's own line and the lines
// indented under it.
function permissionBlocks(text) {
  const blocks = [];
  let indent = -1;
  for (const line of withoutComments(text).split("\n")) {
    const depth = line.search(/\S/);
    if (depth < 0) continue;
    if (indent >= 0 && depth > indent) {
      blocks[blocks.length - 1] += `\n${line}`;
      continue;
    }
    indent = -1;
    if (/^\s*permissions:/.test(line)) {
      indent = depth;
      blocks.push(line);
    }
  }
  return blocks;
}

// Read-only only when it sets top-level permissions and nothing grants write;
// without a top-level block, the job token gets the repository's default.
function canWrite(text) {
  return (
    !/^permissions:/m.test(withoutComments(text)) ||
    permissionBlocks(text).some((block) => /\bwrite(-all)?\b/.test(block))
  );
}

function mustPin() {
  const pinned = new Set(["action.yml", ...workflowPaths.filter((path) => canWrite(read(path)))]);
  // A local reusable workflow runs with its caller's token, so it follows the caller.
  for (const path of pinned) {
    for (const ref of refs(read(path))) {
      if (ref.startsWith("./.github/workflows/")) pinned.add(ref.slice(2).split("@")[0]);
    }
  }
  return [...pinned];
}

const unpinned = (text) =>
  refs(text).filter((ref) => !ref.startsWith("./") && !ref.startsWith("docker://") && !/@[0-9a-f]{40}$/.test(ref));

test("the Action and workflows that can write pin actions to a commit SHA", () => {
  const pinned = mustPin();
  for (const path of [
    ".github/workflows/publish.yml",
    ".github/workflows/release-please.yml",
    ".github/workflows/main-gate.yml",
  ]) {
    assert.ok(pinned.includes(path), `${path} should have to pin its actions`);
  }
  assert.ok(!pinned.includes(".github/workflows/ci.yml"), "ci.yml is read-only");
  for (const path of pinned) {
    assert.deepEqual(unpinned(read(path)), [], `${path} uses actions without a commit SHA`);
  }
});

test("a write permission is found in any form", () => {
  const readOnly = "permissions:\n  contents: read\njobs:\n  a:\n    steps: []\n";
  assert.equal(canWrite(readOnly), false);
  assert.equal(canWrite("jobs:\n  a:\n    steps: []\n"), true, "no top-level permissions");
  assert.equal(canWrite("permissions: write-all\n"), true);
  assert.equal(canWrite("permissions: { contents: write }\n"), true);
  assert.equal(canWrite(`${readOnly}    permissions:\n      contents: write # push the image\n`), true);
  assert.equal(
    canWrite(`${readOnly}    steps:\n      - run: echo write\n`),
    false,
    "write outside a permissions block",
  );
  assert.deepEqual(unpinned(`uses: "actions/checkout@${"a".repeat(40)}"\nuses: 'actions/checkout@v7' # v7\n`), [
    "actions/checkout@v7",
  ]);
});
