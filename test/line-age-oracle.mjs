import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { expandRevisions } from "../dist/expand.js";
import { instructionAges } from "../dist/instruction-age.js";

/**
 * Check a report's instruction age against the files themselves, without its line tracking: read
 * every instructional file at each revision, count its trimmed nonblank lines, and require that
 * the bytes at each revision match, and that for every baseline B and target T the bytes the report
 * dates at or before B equal each line's weight times its fewest copies over B..T, which is what
 * continuous presence means when the newest copies go first. Valid UTF-8 text only.
 */
export function assertLineAgesMatchTrees(repo, report) {
  const blobs = new Map();
  const lines = (blob) => {
    if (!blobs.has(blob)) {
      const body = execFileSync("git", ["-C", repo, "cat-file", "blob", blob], { encoding: "utf8" });
      blobs.set(
        blob,
        body
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
      );
    }
    return blobs.get(blob);
  };
  const counts = expandRevisions(report).map((revision) => {
    const count = new Map();
    for (const component of revision.components) {
      if (component.estimatedTokens === null) continue;
      for (const line of lines(component.blob)) count.set(line, (count.get(line) ?? 0) + 1);
    }
    return count;
  });
  const ages = instructionAges(report);
  const weigh = (count) => [...count].reduce((sum, [line, copies]) => sum + Buffer.byteLength(line) * copies, 0);
  for (const [index, count] of counts.entries())
    assert.equal(ages.bytes[index], weigh(count), `bytes at revision ${index}`);
  for (let from = 0; from < counts.length; from += 1) {
    let fewest = new Map(counts[from]);
    for (let to = from; to < counts.length; to += 1) {
      fewest = new Map([...fewest].map(([line, copies]) => [line, Math.min(copies, counts[to].get(line) ?? 0)]));
      const kept = ages.at(to).reduce((sum, cohort) => sum + (cohort.from <= from ? cohort.bytes : 0), 0);
      assert.equal(kept, weigh(fewest), `text of revision ${from} kept at revision ${to}`);
    }
  }
}
