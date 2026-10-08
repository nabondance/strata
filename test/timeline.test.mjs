import assert from "node:assert/strict";
import test from "node:test";
import { timelineBuckets } from "../dist/timeline.js";

test("timeline overview stays bounded and covers every revision", () => {
  assert.deepEqual(timelineBuckets(0), []);
  assert.deepEqual(timelineBuckets(3), [{ start: 0, end: 0 }, { start: 1, end: 1 }, { start: 2, end: 2 }]);
  const buckets = timelineBuckets(1001);
  assert.equal(buckets.length, 100);
  assert.equal(buckets[0].start, 0);
  assert.equal(buckets.at(-1).end, 1000);
  for (let index = 1; index < buckets.length; index += 1) assert.equal(buckets[index].start, buckets[index - 1].end + 1);
  assert.throws(() => timelineBuckets(4, 0), /Invalid timeline size/);
});
