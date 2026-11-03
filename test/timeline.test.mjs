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
    timelineStepsNote(1500, merged, false, undefined, "day"),
    "1,500 revisions and 1,500 changes shown as 100 steps, merging changes made on the same day; each step shows the last revision in its group.",
  );
});

test("bars spaced by time merge only changes made on the same day", () => {
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const at = (time) => new Date(Date.parse("2024-01-01T00:00:00Z") + time).toISOString();
  const changes = timelineBuckets(single([10, 50, 20, 30, 40, 45]));
  assert.equal(changes.length, 6);
  // Two changes on day 0, one on day 1, two on day 5, and one on day 6, a minute before the latest revision.
  const starts = [0, 2 * hour, day, 5 * day, 5 * day + hour, 6 * day];
  const end = Date.parse(at(6 * day + minute));
  const bars = timelineTimeBars(changes, starts.map(at), end);
  assert.deepEqual(bars.buckets, [
    { start: 0, end: 1, peak: 50, changes: 2 },
    { start: 2, end: 2, peak: 20, changes: 1 },
    { start: 3, end: 4, peak: 40, changes: 2 },
    { start: 5, end: 5, peak: 45, changes: 1 },
  ]);
  assert.equal(bars.period, "day");
  assert.equal(bars.elapsed, 6 * day + minute);
  // Each bar lasts until the next one starts; the last is at least as wide as an average bar.
  assert.deepEqual(bars.widths, [day, 4 * day, day, (6 * day + minute) / 4]);
  assert.deepEqual(timelineTimeBars([], [], 0), { buckets: [], widths: [], period: "day", elapsed: 0 });
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
  // A rebased change between two on the same day does not split that day.
  const day3 = timelineTimeBars(changes, [0, 10.1, 9, 10.2].map(at), Date.parse(at(11)));
  assert.equal(day3.buckets.length, 2);
  // A latest revision dated before the latest change ends the chart at that change.
  assert.equal(timelineTimeBars(changes, [0, 10, 5, 12].map(at), Date.parse(at(8))).elapsed, 12 * day);
});

test("bars spaced by time group by week, month, or year when there are too many days", () => {
  const day = 24 * 60 * 60 * 1000;
  const changes = timelineBuckets(single(Array.from({ length: 1000 }, (_, index) => index)), 1000);
  const dates = changes.map((_, index) => new Date(Date.parse("2024-01-01T00:00:00Z") + index * day).toISOString());
  const end = Date.parse(dates.at(-1));
  // Under the limit, every day keeps its own bar.
  assert.equal(timelineTimeBars(changes, dates, end, 1000).buckets.length, 1000);
  // 1,000 days are 143 weeks starting on Monday 2024-01-01; a week's bar shows its last day.
  const weeks = timelineTimeBars(changes, dates, end);
  assert.equal(weeks.period, "week");
  assert.equal(weeks.buckets.length, 143);
  assert.deepEqual(weeks.buckets[0], { start: 0, end: 6, peak: 6, changes: 7 });
  const months = timelineTimeBars(changes, dates, end, 100);
  assert.equal(months.period, "month");
  assert.equal(months.buckets.length, 33);
  const years = timelineTimeBars(changes, dates, end, 2);
  assert.equal(years.period, "year");
  assert.equal(years.buckets.length, 3);
  assert.equal(
    timelineStepsNote(1000, weeks.buckets, false, undefined, weeks.period),
    "1,000 revisions and 1,000 changes shown as 143 steps, merging changes made in the same week; each step shows the last revision in its group.",
  );
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
