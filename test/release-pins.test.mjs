import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Release Please rewrites every x.y.z version on a line marked
// x-release-please-version and inside x-release-please-start-version blocks.
// Those regions must hold only Strata's own version, or a release would
// silently rewrite another pin (an action tag, a tool version) as well.

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const versionPattern = /\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[-\w.]+)?/g;

const { version } = JSON.parse(read("package.json"));
const config = JSON.parse(read("release-please-config.json"));
const extraFiles = config.packages["."]["extra-files"].map((entry) => (typeof entry === "string" ? entry : entry.path));

function markedLines(text) {
  const marked = [];
  let inBlock = false;
  for (const [index, line] of text.split("\n").entries()) {
    if (line.includes("x-release-please-start-version")) inBlock = true;
    else if (line.includes("x-release-please-end")) inBlock = false;
    else if (inBlock || line.includes("x-release-please-version")) marked.push({ number: index + 1, line });
  }
  assert.equal(inBlock, false, "an x-release-please-start-version block is not closed");
  return marked;
}

test("release-managed files pin only Strata's current version", () => {
  assert.ok(extraFiles.length > 0);
  for (const path of extraFiles) {
    const marked = markedLines(read(path));
    const versions = marked.flatMap(({ number, line }) =>
      (line.match(versionPattern) ?? []).map((found) => ({ number, found })),
    );
    assert.ok(versions.length > 0, `${path} has no version for Release Please to update`);
    for (const { number, found } of versions) {
      assert.equal(
        found,
        version,
        `${path}:${number} holds ${found}; only Strata's version may sit in a marked region`,
      );
    }
  }
});
