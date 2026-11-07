import assert from "node:assert/strict";
import test from "node:test";
import {
  timelineBuckets,
  timelineEdges,
  timelinePosition,
  timelineRevision,
  timelineSpan,
  timelineStepsNote,
  timelineTimeBars,
  timelineZoom,
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
    "One bar per change, as wide as the time until the next one; 1,400 changes dated out of order share the bar before them.",
  );
});

test("bars spaced by time give every change its own bar", () => {
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const at = (time) => new Date(Date.parse("2024-01-01T00:00:00Z") + time).toISOString();
  const changes = timelineBuckets(single([10, 50, 20, 30, 40, 45]));
  assert.equal(changes.length, 6);
  // Two changes on day 0, one on day 1, two on day 5 a minute apart, and one on day 6, a minute before the latest
  // revision: each keeps its own bar, however close it came to the one before.
  const starts = [0, 2 * hour, day, 5 * day, 5 * day + minute, 6 * day];
  const end = Date.parse(at(6 * day + minute));
  const bars = timelineTimeBars(changes, starts.map(at), end);
  assert.deepEqual(bars.buckets, changes);
  assert.equal(bars.elapsed, 6 * day + minute);
  // Each bar lasts until the next one starts; the last is at least as wide as an average bar.
  assert.deepEqual(bars.widths, [2 * hour, day - 2 * hour, 4 * day, minute, day - minute, (6 * day + minute) / 6]);
  assert.equal(bars.outOfOrder, false);
  assert.equal(
    timelineStepsNote(7, bars.buckets, false, undefined, true),
    "One bar per change, as wide as the time until the next one.",
  );
  assert.deepEqual(timelineTimeBars([], [], 0), { buckets: [], widths: [], outOfOrder: false, elapsed: 0 });
});

test("bars spaced by time read dates on a clock that never goes back", () => {
  const day = 24 * 60 * 60 * 1000;
  const at = (days) => new Date(Date.parse("2024-01-01T00:00:00Z") + days * day).toISOString();
  // A rebase dated the third change before the second: it joins the second's bar, which shows it, so no bar is
  // left without a width.
  const changes = timelineBuckets(single([1, 2, 3, 4]));
  const bars = timelineTimeBars(changes, [0, 10, 5, 12].map(at), Date.parse(at(12)));
  assert.deepEqual(bars.buckets, [
    { start: 0, end: 0, peak: 1, changes: 1 },
    { start: 1, end: 2, peak: 3, changes: 2 },
    { start: 3, end: 3, peak: 4, changes: 1 },
  ]);
  assert.deepEqual(bars.widths.slice(0, 2), [10 * day, 2 * day]);
  assert.ok(bars.widths.every((width) => width > 0));
  // The widths add up to the time covered, so a date placed across the chart lines up with the bars.
  assert.equal(bars.elapsed, 12 * day);
  assert.equal(bars.outOfOrder, true);
  assert.equal(
    timelineStepsNote(4, bars.buckets, true, undefined, true),
    "One bar per change, as wide as the time until the next one; 1 change dated out of order shares the bar before it. A dashed line marks a higher total inside a bar.",
  );
  // Two changes with the same date share a bar too, since the second would have no width.
  assert.equal(timelineTimeBars(changes, [0, 3, 3, 12].map(at), Date.parse(at(12))).buckets.length, 3);
  // A date years ahead of the latest revision is a wrong clock: it joins the bar before it rather than pulling
  // every later change into its own bar.
  const future = timelineBuckets(single([1, 2, 3, 4, 5]));
  const skewed = timelineTimeBars(future, [0, 1, 2000, 2, 3].map(at), Date.parse(at(4)));
  assert.deepEqual(
    skewed.buckets.map((bucket) => [bucket.start, bucket.end]),
    [
      [0, 0],
      [1, 2],
      [3, 3],
      [4, 4],
    ],
  );
  assert.equal(skewed.elapsed, 4 * day);
  assert.equal(skewed.outOfOrder, true);
  // On the first change, a wrong clock starts the chart at the earliest date, so later changes keep their bars.
  const first = timelineTimeBars(future, [2000, 1, 2, 3, 4].map(at), Date.parse(at(4)));
  assert.equal(first.buckets.length, 4);
  assert.ok(first.widths.every((width) => width > 0));
  // A rebased change joins the bar before it; the changes after it keep their own bars.
  const rebased = timelineTimeBars(future, [0, 10, 9, 11, 12].map(at), Date.parse(at(12)));
  assert.equal(rebased.buckets.length, 4);
  // A latest revision dated before the latest change ends the chart at that change.
  assert.equal(timelineTimeBars(changes, [0, 10, 5, 12].map(at), Date.parse(at(8))).elapsed, 12 * day);
});

test("bars spaced by time have no cap", () => {
  const day = 24 * 60 * 60 * 1000;
  const changes = timelineBuckets(single(Array.from({ length: 1000 }, (_, index) => index)), 1000);
  const dates = changes.map((_, index) => new Date(Date.parse("2024-01-01T00:00:00Z") + index * day).toISOString());
  const bars = timelineTimeBars(changes, dates, Date.parse(dates.at(-1)));
  assert.equal(bars.buckets.length, 1000);
  assert.equal(bars.outOfOrder, false);
});

test("a drag across the chart zooms into whole bars, and needs more than one change", () => {
  const buckets = [
    { start: 0, end: 2, changes: 1 },
    { start: 3, end: 3, changes: 1 },
    { start: 4, end: 9, changes: 3 },
    { start: 10, end: 12, changes: 1 },
  ];
  const edges = timelineEdges(4, [1, 1, 2, 4]);
  // Edges at 0.125, 0.25, and 0.5: a drag from inside the second bar to inside the fourth covers all three.
  assert.deepEqual(timelineZoom(buckets, edges, 0.2, 0.6), { start: 3, end: 12 });
  assert.deepEqual(timelineZoom(buckets, edges, 0.6, 0.2), { start: 3, end: 12 });
  // Inside one bar there is nothing to zoom into, unless that bar merged several changes.
  assert.equal(timelineZoom(buckets, edges, 0.01, 0.1), undefined);
  assert.deepEqual(timelineZoom(buckets, edges, 0.3, 0.4), { start: 4, end: 9 });
  // A drag past the right edge ends at the last bar.
  assert.deepEqual(timelineZoom(buckets, edges, 0.1, 1), { start: 0, end: 12 });
  assert.equal(timelineZoom([], [], 0, 1), undefined);
});

test("a run of revisions spans its share of the bars, from its first revision's left edge to its last one's right", () => {
  const buckets = [
    { start: 2, end: 2 },
    { start: 3, end: 6 },
    { start: 7, end: 7 },
  ];
  const edges = timelineEdges(3, [1, 2, 1]);
  assert.deepEqual(timelineSpan(buckets, edges, 2, 7), [0, 1]);
  assert.deepEqual(timelineSpan(buckets, edges, 3, 6), [0.25, 0.75]);
  // Revisions 4 and 5 are the middle two quarters of the second bar.
  assert.deepEqual(timelineSpan(buckets, edges, 4, 5), [0.375, 0.625]);
  // The span maps back to the same revisions.
  const [from, to] = timelineSpan(buckets, edges, 4, 5);
  assert.equal(timelineRevision(buckets, edges, from + 1e-9), 4);
  assert.equal(timelineRevision(buckets, edges, to - 1e-9), 5);
  // Revisions outside the bars sit at the ends.
  assert.deepEqual(timelineSpan(buckets, edges, 0, 9), [0, 1]);
  assert.deepEqual(timelineSpan([], [], 0, 1), [0, 1]);
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
