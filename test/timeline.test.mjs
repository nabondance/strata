import assert from "node:assert/strict";
import test from "node:test";
import {
  timelineBuckets,
  timelineEdges,
  timelinePosition,
  timelineRevision,
  timelineStepsNote,
  timelineTimeBars,
} from "../dist/timeline.js";

/** One value per revision, as a one-layer chart draws it. */
const single = (values) => values.map((value) => [value]);
const contiguous = (buckets, first, last) => {
  assert.equal(buckets[0].start, first);
  assert.equal(buckets.at(-1).end, last);
  for (const [index, bucket] of buckets.entries()) {
    assert.ok(bucket.start <= bucket.end);
    if (index) assert.equal(bucket.start, buckets[index - 1].end + 1);
  }
};

test("timeline gives each change one bar and leaves out leading revisions", () => {
  // Revisions that draw the same values share a bar; each bar starts at a change.
  assert.deepEqual(timelineBuckets(single([0, 0, 5, 5, 5, 7, 7])), [
    { start: 0, end: 1, peak: 0, changes: 1 },
    { start: 2, end: 4, peak: 5, changes: 1 },
    { start: 5, end: 6, peak: 7, changes: 1 },
  ]);
  // A change in one layer starts a bar even when the total stays the same.
  assert.equal(
    timelineBuckets([
      [3, 2],
      [2, 3],
    ]).length,
    2,
  );
  assert.deepEqual(timelineBuckets(single([0, 0, 0, 4, 9]), 100, 3), [
    { start: 3, end: 3, peak: 4, changes: 1 },
    { start: 4, end: 4, peak: 9, changes: 1 },
  ]);
  assert.deepEqual(timelineBuckets(single([1, 2]), 100, 2), []);
  assert.deepEqual(timelineBuckets([]), []);
  assert.throws(() => timelineBuckets(single([1, 2]), 100, 3), /Invalid timeline size/);
  assert.throws(() => timelineBuckets(single([1]), 0), /Invalid timeline size/);
});

test("timeline merges the most alike neighbors and keeps what they hide", () => {
  // 1,001 revisions that all change stay within 100 bars and cover every revision.
  const growth = single(Array.from({ length: 1001 }, (_, index) => index * 10));
  const buckets = timelineBuckets(growth);
  assert.equal(buckets.length, 100);
  contiguous(buckets, 0, 1000);
  assert.equal(
    buckets.reduce((total, bucket) => total + bucket.changes, 0),
    1001,
  );
  // Steady growth merges evenly rather than from one end.
  const sizes = buckets.map((bucket) => bucket.end - bucket.start + 1);
  assert.ok(Math.max(...sizes) <= 4 * Math.min(...sizes), sizes.join(","));

  // A spike that falls back keeps its own bar; small wobbles around it merge first.
  const wobble = Array.from({ length: 300 }, (_, index) => 1000 + (index % 3));
  wobble[150] = 5000;
  const spiked = timelineBuckets(single(wobble), 10);
  assert.equal(spiked.length, 10);
  assert.deepEqual(
    spiked.find((bucket) => bucket.start <= 150 && 150 <= bucket.end),
    { start: 150, end: 150, peak: 5000, changes: 1 },
  );

  // A step that stays up keeps its edge.
  const step = single(Array.from({ length: 300 }, (_, index) => (index < 100 ? 1000 : 5000) + (index % 2)));
  assert.ok(timelineBuckets(step, 5).some((bucket) => bucket.start === 100));

  // A merged bar shows its last revision; its peak keeps a higher total inside it.
  const hidden = timelineBuckets(single([10, 50, 10, 11]), 1);
  assert.deepEqual(hidden, [{ start: 0, end: 3, peak: 50, changes: 4 }]);
});

test("the grouped timeline note says how bars group revisions", () => {
  const unchanged = timelineBuckets(single([0, 0, 5, 5, 5, 7, 7]));
  assert.equal(
    timelineStepsNote(7, unchanged, false),
    "7 revisions shown as 3 steps, one per change; each step shows the last revision in its group.",
  );
  const merged = timelineBuckets(single(Array.from({ length: 1500 }, (_, index) => index % 7)));
  assert.equal(
    timelineStepsNote(1500, merged, true),
    "1,500 revisions and 1,500 changes shown as 100 steps, merging the most alike neighbors; each step shows the last revision in its group. A dashed line marks a higher total inside a step.",
  );
  assert.equal(timelineStepsNote(3, timelineBuckets(single([1, 2, 3])), false), "");
  assert.equal(
    timelineStepsNote(1500, merged, false, (value) => `#${value}`),
    "#1500 revisions and #1500 changes shown as #100 steps, merging the most alike neighbors; each step shows the last revision in its group.",
  );
  assert.equal(
    timelineStepsNote(1500, merged, false, undefined, true),
    "1,500 revisions and 1,500 changes shown as 100 steps, merging changes made on the same day; each step shows the last revision in its group.",
  );
});

test("bars spaced by time merge only changes made on the same day", () => {
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;
  const changes = timelineBuckets(single([10, 50, 20, 30, 40, 45]));
  assert.equal(changes.length, 6);
  // Two changes on day 0, one on day 1, two on day 5, and one on day 6, a minute before the latest revision.
  const starts = [0, 2 * hour, day, 5 * day, 5 * day + hour, 6 * day];
  const days = ["2024-01-01", "2024-01-01", "2024-01-02", "2024-01-06", "2024-01-06", "2024-01-07"];
  const { buckets, widths } = timelineTimeBars(changes, starts, days, 6 * day + 60 * 1000);
  assert.deepEqual(buckets, [
    { start: 0, end: 1, peak: 50, changes: 2 },
    { start: 2, end: 2, peak: 20, changes: 1 },
    { start: 3, end: 4, peak: 40, changes: 2 },
    { start: 5, end: 5, peak: 45, changes: 1 },
  ]);
  // Each bar lasts until the next one starts; the last is at least as wide as an average bar.
  assert.deepEqual(widths.slice(0, 3), [day, 4 * day, day]);
  assert.equal(widths[3], (6 * day + 60 * 1000) / 4);
  // Changes on different days keep their own bars, however many there are, and a date out of order adds no width.
  const many = timelineBuckets(single(Array.from({ length: 500 }, (_, index) => index)), 500);
  const spread = timelineTimeBars(
    many,
    many.map((_, index) => (index === 10 ? 0 : index * day)),
    many.map((_, index) => `day ${index}`),
    500 * day,
  );
  assert.equal(spread.buckets.length, 500);
  assert.equal(spread.widths[9], 0);
  assert.deepEqual(timelineTimeBars([], [], [], 0), { buckets: [], widths: [] });
});

test("the slider position follows the bars, in equal or time-proportional widths", () => {
  const buckets = [
    { start: 2, end: 2 },
    { start: 3, end: 6 },
    { start: 7, end: 7 },
  ];
  assert.deepEqual(timelineEdges(3), [
    [0, 1 / 3],
    [1 / 3, 2 / 3],
    [2 / 3, 1],
  ]);
  assert.deepEqual(timelineEdges(3, [1, 2, 1]), [
    [0, 0.25],
    [0.25, 0.75],
    [0.75, 1],
  ]);
  const edges = timelineEdges(3, [1, 2, 1]);
  // A revision sits at its share of its bar; one before the first bar is at the left end.
  assert.equal(timelinePosition(buckets, edges, 2), 0.125);
  assert.equal(timelinePosition(buckets, edges, 3), 0.25 + 0.5 * (0.5 / 4));
  assert.equal(timelinePosition(buckets, edges, 0), 0);
  // Every revision maps back to itself, and the ends select the first and last charted revisions.
  for (let index = 2; index <= 7; index += 1)
    assert.equal(timelineRevision(buckets, edges, timelinePosition(buckets, edges, index)), index);
  assert.equal(timelineRevision(buckets, edges, 0), 2);
  assert.equal(timelineRevision(buckets, edges, 1), 7);
  assert.equal(timelineRevision([], [], 0.5), undefined);
});
