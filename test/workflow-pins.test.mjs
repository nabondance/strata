import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

// A tag such as actions/setup-node@v7 can be moved to other code, a commit
// cannot. The composite Action runs in users' repositories, and workflows with
// a write permission can push, release, or publish to npm, so those pin every
// action to a full commit SHA. Read-only workflows may use release tags.

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const workflows = readdirSync(new URL(".github/workflows/", root)).filter((name) => /\.ya?ml$/.test(name));

const writes = (text) => /^\s+[\w-]+:\s*write\s*$/m.test(text);
const unpinned = (text) =>
  [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)]
    .map((match) => match[1])
    .filter((ref) => !ref.startsWith("./") && !ref.startsWith("docker://") && !/@[0-9a-f]{40}$/.test(ref));

test("the Action and workflows that can write pin actions to a commit SHA", () => {
  const pinned = [
    "action.yml",
    ...workflows.filter((name) => writes(read(`.github/workflows/${name}`))).map((name) => `.github/workflows/${name}`),
  ];
  assert.ok(
    pinned.includes(".github/workflows/publish.yml"),
    "publish.yml should be found as a workflow that can write",
  );
  for (const path of pinned) {
    assert.deepEqual(unpinned(read(path)), [], `${path} uses actions without a commit SHA`);
  }
});
