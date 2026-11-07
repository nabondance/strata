export interface TimelineBucket {
  start: number;
  end: number;
  /** The largest total of any revision in the bucket; above the last revision's when a higher one is hidden. */
  peak: number;
  /** How many changes the bucket holds: runs of revisions whose drawn values are the same. */
  changes: number;
}

/**
 * Group the charted revisions into at most `maxBars` bars, given the values each revision draws (its token count
 * per category, say). Revisions before `first` are left out, so a long history without configuration does not
 * flatten the chart. A bar starts at each change, where the drawn values differ from the previous revision's, so
 * revisions that look the same never take separate bars. When there are more changes than bars, neighboring bars are
 * merged, the pair whose merged bar would be closest to every revision it covers first. Each bar shows its last
 * revision; its `peak` keeps the highest total inside it. The slider can still select every charted revision.
 * The HTML report embeds this function's source, so it must stay self-contained.
 */
export function timelineBuckets(values: readonly (readonly number[])[], maxBars = 100, first = 0): TimelineBucket[] {
  const count = values.length;
  const valid = (value: number, minimum: number) => Number.isSafeInteger(value) && value >= minimum;
  if (!valid(maxBars, 1) || !valid(first, 0) || first > count) throw new Error("Invalid timeline size");
  const sum = (vector: readonly number[]) => vector.reduce((total, value) => total + value, 0);
  interface Group extends TimelineBucket {
    low: number[];
    high: number[];
  }
  const groups: Group[] = [];
  for (let index = first; index < count; index += 1) {
    const vector = values[index] as readonly number[];
    const last = groups.at(-1);
    const previous = last ? (values[last.end] as readonly number[]) : undefined;
    if (last && previous && previous.length === vector.length && previous.every((value, at) => value === vector[at])) {
      last.end = index;
      continue;
    }
    groups.push({ start: index, end: index, peak: sum(vector), changes: 1, low: [...vector], high: [...vector] });
  }
  const strip = (group: Group): TimelineBucket => ({
    start: group.start,
    end: group.end,
    peak: group.peak,
    changes: group.changes,
  });
  if (groups.length <= maxBars) return groups.map(strip);

  // Merging a bar into the next one shows the next one's last revision for both. Its cost is how far that would be,
  // summed over the values, from the furthest revision either covers, so a step that stays up merges cheaply, a
  // spike that falls back does not, and steady growth merges evenly rather than from one end.
  const cost = (left: Group, right: Group) => {
    const shown = values[right.end] as readonly number[];
    let total = 0;
    for (let at = 0; at < shown.length; at += 1) {
      const value = shown[at] as number;
      const low = Math.min(left.low[at] ?? 0, right.low[at] ?? 0);
      const high = Math.max(left.high[at] ?? 0, right.high[at] ?? 0);
      total += Math.max(high - value, value - low);
    }
    return total;
  };
  const next = groups.map((_, index) => index + 1);
  const previous = groups.map((_, index) => index - 1);
  const version = groups.map(() => 0);
  const alive = groups.map(() => true);
  // A binary heap of candidate merges, cheapest first, then earliest; a candidate is stale once its version moves on.
  type Candidate = [cost: number, start: number, left: number, version: number];
  const heap: Candidate[] = [];
  const before = (a: Candidate, b: Candidate) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
  const push = (left: number) => {
    const right = next[left] as number;
    if (left < 0 || right >= groups.length) return;
    const leftGroup = groups[left] as Group;
    const candidate: Candidate = [
      cost(leftGroup, groups[right] as Group),
      leftGroup.start,
      left,
      version[left] as number,
    ];
    heap.push(candidate);
    for (let at = heap.length - 1; at > 0; ) {
      const parent = (at - 1) >> 1;
      if (!before(heap[at] as Candidate, heap[parent] as Candidate)) break;
      [heap[at], heap[parent]] = [heap[parent] as Candidate, heap[at] as Candidate];
      at = parent;
    }
  };
  const pop = () => {
    const top = heap[0] as Candidate;
    const last = heap.pop() as Candidate;
    if (heap.length) {
      heap[0] = last;
      for (let at = 0; ; ) {
        const child = 2 * at + 1;
        if (child >= heap.length) break;
        const pick =
          child + 1 < heap.length && before(heap[child + 1] as Candidate, heap[child] as Candidate) ? child + 1 : child;
        if (!before(heap[pick] as Candidate, heap[at] as Candidate)) break;
        [heap[at], heap[pick]] = [heap[pick] as Candidate, heap[at] as Candidate];
        at = pick;
      }
    }
    return top;
  };
  for (let index = 0; index < groups.length - 1; index += 1) push(index);
  let remaining = groups.length;
  while (remaining > maxBars && heap.length) {
    const [, , left, stamp] = pop();
    if (!alive[left] || stamp !== version[left]) continue;
    const right = next[left] as number;
    const leftGroup = groups[left] as Group;
    const rightGroup = groups[right] as Group;
    rightGroup.start = leftGroup.start;
    rightGroup.peak = Math.max(leftGroup.peak, rightGroup.peak);
    rightGroup.changes += leftGroup.changes;
    rightGroup.low = rightGroup.low.map((value, at) => Math.min(value, leftGroup.low[at] ?? value));
    rightGroup.high = rightGroup.high.map((value, at) => Math.max(value, leftGroup.high[at] ?? value));
    alive[left] = false;
    remaining -= 1;
    const prior = previous[left] as number;
    previous[right] = prior;
    if (prior >= 0) next[prior] = right;
    // The merged bar's own merges with both neighbors now cost more.
    for (const changed of [prior, right]) {
      if (changed < 0) continue;
      version[changed] = (version[changed] as number) + 1;
      push(changed);
    }
  }
  return groups.filter((_, index) => alive[index]).map(strip);
}

export interface TimelineTimeBars {
  buckets: TimelineBucket[];
  /** Each bar's width in milliseconds. */
  widths: number[];
  /** Whether some change joined the bar before it because its date did not move time on. */
  outOfOrder: boolean;
  /** The time from the first bar's start to the latest date, before the last bar is widened. */
  elapsed: number;
}

/**
 * Bars spaced by time, from one bucket per change and the date of each bucket's first revision: every change keeps
 * its own bar, so any change can be selected and compared, however close it came to the one before. Each bar is as
 * wide as the time from its first revision to the next bar's, and the last one to `end`, the latest revision's time.
 *
 * Dates need not increase (clock skew, a rebase), so times are read on a clock that never goes back: a change dated
 * no later than the bar before it does not move time on, so it joins that bar, which then shows it and keeps the
 * highest total inside it. So every bar has a width, the widths add up to the time the chart covers, and dates
 * placed across it line up with the bars. A date more than 30 days after the latest revision's is a wrong clock
 * rather than a time the history reached, so it does not move the clock either; otherwise one such date would pull
 * every later change into its bar. `outOfOrder` says whether either rule merged a change.
 *
 * The last bar has no next one to end at, and the latest change is often days or minutes before the latest revision,
 * which would leave the selected bar a hairline, so it is at least as wide as an average bar.
 * The HTML report embeds this function's source, so it must stay self-contained.
 */
export function timelineTimeBars(
  buckets: readonly TimelineBucket[],
  dates: readonly string[],
  end: number,
): TimelineTimeBars {
  if (!buckets.length) return { buckets: [], widths: [], outOfOrder: false, elapsed: 0 };
  const limit = end + 30 * 86_400_000;
  const clock: number[] = [];
  // A wrong clock on the first change would leave nothing to start the chart from, so it starts at the earliest date.
  let earliest = end;
  for (const date of dates) earliest = Math.min(earliest, Date.parse(date));
  let latest = Number.NEGATIVE_INFINITY;
  for (const date of dates) {
    const time = Date.parse(date);
    latest = Math.max(latest, time > limit ? (clock.length ? latest : earliest) : time);
    clock.push(latest);
  }
  const finish = Math.max(end, latest);
  const merged: TimelineBucket[] = [];
  const first: number[] = [];
  let outOfOrder = false;
  for (let index = 0; index < buckets.length; index += 1) {
    const bucket = buckets[index] as TimelineBucket;
    const group = merged.at(-1);
    // A change that does not move the clock on would leave the bar before it with no width, so it joins that bar.
    if (group && (clock[index] as number) <= (clock[first.at(-1) as number] as number)) {
      outOfOrder = true;
      group.end = bucket.end;
      group.peak = Math.max(group.peak, bucket.peak);
      group.changes += bucket.changes;
      continue;
    }
    merged.push({ ...bucket });
    first.push(index);
  }
  const widths = first.map(
    (index, bar) =>
      (bar + 1 < first.length ? (clock[first[bar + 1] as number] as number) : finish) - (clock[index] as number),
  );
  const elapsed = finish - (clock[0] as number);
  const last = widths.length - 1;
  widths[last] = Math.max(widths[last] as number, elapsed / widths.length);
  return { buckets: merged, widths, outOfOrder, elapsed };
}

/**
 * Each bar's left and right edge as a share of the chart's width: equal widths, or widths in proportion to `widths`
 * (the time each bar lasts, say). The last edge is always 1.
 * The HTML report embeds this function's source, so it must stay self-contained.
 */
export function timelineEdges(count: number, widths?: readonly number[]): [number, number][] {
  const total = widths ? widths.reduce((sum, width) => sum + width, 0) : count;
  let edge = 0;
  return Array.from({ length: count }, (_, index) => {
    const from = edge;
    edge += total > 0 ? (widths ? (widths[index] as number) : 1) / total : 1 / count;
    return [from, index === count - 1 ? 1 : edge];
  });
}

/**
 * Where a revision sits across the chart, from 0 to 1: inside its bar, at its share of the bar's revisions, so a
 * slider that runs along the chart stays over the bar it selects. A revision before the first bar is at 0.
 * The HTML report embeds this function's source, so it must stay self-contained.
 */
export function timelinePosition(
  buckets: readonly { start: number; end: number }[],
  edges: readonly [number, number][],
  index: number,
): number {
  const at = buckets.findIndex((bucket) => bucket.start <= index && index <= bucket.end);
  if (at < 0) return 0;
  const bucket = buckets[at] as { start: number; end: number };
  const [from, to] = edges[at] as [number, number];
  return from + ((to - from) * (index - bucket.start + 0.5)) / (bucket.end - bucket.start + 1);
}

/**
 * The revision at a position across the chart, from 0 to 1: the bar under it, then the revision at that share of
 * the bar's revisions. Undefined when there are no bars.
 * The HTML report embeds this function's source, so it must stay self-contained.
 */
export function timelineRevision(
  buckets: readonly { start: number; end: number }[],
  edges: readonly [number, number][],
  position: number,
): number | undefined {
  if (!buckets.length) return undefined;
  let at = edges.findIndex(([, to]) => position < to);
  if (at < 0) at = buckets.length - 1;
  const bucket = buckets[at] as { start: number; end: number };
  const [from, to] = edges[at] as [number, number];
  const share = to > from ? Math.max(0, (position - from) / (to - from)) : 0;
  return Math.min(bucket.end, bucket.start + Math.floor(share * (bucket.end - bucket.start + 1)));
}

/**
 * The revisions a drag across the chart zooms into, from two positions across it, 0 to 1: every revision of the bars
 * under the drag, whole bars only. Undefined when the drag covers a single change, which there is nothing to zoom into.
 * The HTML report embeds this function's source, so it must stay self-contained.
 */
export function timelineZoom(
  buckets: readonly { start: number; end: number; changes: number }[],
  edges: readonly [number, number][],
  from: number,
  to: number,
): { start: number; end: number } | undefined {
  if (!buckets.length) return undefined;
  const barAt = (position: number) => {
    const at = edges.findIndex(([, right]) => position < right);
    return at < 0 ? buckets.length - 1 : at;
  };
  const first = barAt(Math.min(from, to));
  const last = barAt(Math.max(from, to));
  let changes = 0;
  for (let at = first; at <= last; at += 1) changes += (buckets[at] as { changes: number }).changes;
  if (changes < 2) return undefined;
  return {
    start: (buckets[first] as { start: number }).start,
    end: (buckets[last] as { end: number }).end,
  };
}

/**
 * Where a run of revisions sits across the chart, from 0 to 1: from the left edge of the first one's share of its bar
 * to the right edge of the last one's. A revision before the first bar sits at the left end, one after the last at the
 * right end. The HTML report embeds this function's source, so it must stay self-contained.
 */
export function timelineSpan(
  buckets: readonly { start: number; end: number }[],
  edges: readonly [number, number][],
  first: number,
  last: number,
): [number, number] {
  if (!buckets.length) return [0, 1];
  const edge = (index: number, after: boolean) => {
    const at = buckets.findIndex((bucket) => bucket.start <= index && index <= bucket.end);
    if (at < 0) return index < (buckets[0] as { start: number }).start ? 0 : 1;
    const bucket = buckets[at] as { start: number; end: number };
    const [from, to] = edges[at] as [number, number];
    return from + ((to - from) * (index - bucket.start + (after ? 1 : 0))) / (bucket.end - bucket.start + 1);
  };
  return [edge(first, false), edge(last, true)];
}

/**
 * The line under a grouped timeline, shared by the HTML report and the SVG image; empty when every charted revision
 * has its own bar. `higher` says whether some bar hides a higher total, which a dashed line marks. `byTime` says the
 * bars are spaced by time: the line then says how wide they are, and how many changes dated out of order share a bar.
 * The HTML report embeds this function's source, so it must stay self-contained.
 */
export function timelineStepsNote(
  revisions: number,
  buckets: readonly TimelineBucket[],
  higher: boolean,
  format: (value: number) => string = (value) => new Intl.NumberFormat("en-US").format(value),
  byTime = false,
): string {
  if (byTime) {
    const merged = buckets.reduce((total, bucket) => total + bucket.changes, 0) - buckets.length;
    const outOfOrder = merged
      ? `; ${format(merged)} ${merged === 1 ? "change dated out of order shares the bar before it" : "changes dated out of order share the bar before them"}`
      : "";
    return `One bar per change, as wide as the time until the next one${outOfOrder}.${higher ? " A dashed line marks a higher total inside a bar." : ""}`;
  }
  if (buckets.length >= revisions) return "";
  const changes = buckets.reduce((total, bucket) => total + bucket.changes, 0);
  if (changes <= buckets.length) {
    return `${format(revisions)} revisions shown as ${format(buckets.length)} steps, one per change; each step shows the last revision in its group.`;
  }
  return `${format(revisions)} revisions and ${format(changes)} changes shown as ${format(buckets.length)} steps, merging the most alike neighbors; each step shows the last revision in its group.${higher ? " A dashed line marks a higher total inside a step." : ""}`;
}

export interface TimelineScale {
  /** The value drawn at the top of the plot: a whole number of steps, at least the largest value. */
  top: number;
  /** The gridline values from 0 to `top`, three to five of them. */
  ticks: number[];
}

/**
 * Round gridlines for a chart whose largest value is `max`: steps of 1, 2, 2.5, or 5 times a power of ten, like
 * the SVG image's axis. Token counts are whole, so a step is at least 1 and 2.5 needs a power of ten or more.
 * The HTML report embeds this function's source, so it must stay self-contained.
 */
export function timelineScale(max: number): TimelineScale {
  const raw = max > 0 ? max / 4 : 1;
  const power = 10 ** Math.floor(Math.log10(raw));
  const multiples = power >= 10 ? [1, 2, 2.5, 5, 10] : [1, 2, 5, 10];
  const step = Math.max(1, (multiples.find((multiple) => multiple * power >= raw) ?? 10) * power);
  const top = Math.max(step, Math.ceil(max / step) * step);
  const ticks = [];
  for (let value = 0; value <= top; value += step) ticks.push(value);
  return { top, ticks };
}

export interface TimelineDateTick {
  /** The index of the bar the period starts at; the label sits at its left edge. */
  at: number;
  /** `YYYY-MM` for month, quarter, and half-year boundaries, `YYYY` for years. */
  label: string;
  /** The one label kept on a narrow screen, near the middle of the axis. */
  primary: boolean;
}

/**
 * Labels for the calendar boundaries inside a timeline, given the date of each bar. It takes the finest of months,
 * quarters, half-years, years, or longer that gives at most `maxTicks` labels, and keeps labels apart from each other
 * and from the dates already printed at both ends. Bars are changes, not equal stretches of time, so boundaries can
 * crowd where few revisions span a long time; those are dropped. A bar is a boundary when its period is later than the
 * previous bar's, not later than every bar before it, so a single out-of-order date does not hide the labels after it.
 * The HTML report embeds this function's source, so it must stay self-contained.
 */
export function timelineDateTicks(dates: readonly string[], maxTicks = 4): TimelineDateTick[] {
  const count = dates.length;
  const gap = 0.12;
  const months = dates.map((date) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1);
  for (const step of [1, 3, 6, 12, 24, 60, 120]) {
    const ticks: TimelineDateTick[] = [];
    let last = 0;
    for (let index = 1; index < count; index += 1) {
      // A boundary is a bar in a later period than the bar before it. Dates need not increase (clock skew, a rebase),
      // so one early bar with a late date only costs its own label, and a step back in time is not labeled.
      const period = Math.floor((months[index] as number) / step);
      if (period <= Math.floor((months[index - 1] as number) / step)) continue;
      const position = index / count;
      if (position < gap || position > 1 - gap || position - last < gap) continue;
      const month = period * step;
      const year = Math.floor(month / 12);
      ticks.push({
        at: index,
        label: step >= 12 ? String(year) : `${year}-${String((month % 12) + 1).padStart(2, "0")}`,
        primary: false,
      });
      last = position;
    }
    if (ticks.length > maxTicks) continue;
    // On a narrow screen the end dates take about a third of the axis each, so only a label near the middle fits.
    let middle: TimelineDateTick | undefined;
    for (const tick of ticks) {
      const distance = Math.abs(tick.at / count - 0.5);
      if (distance <= 0.2 && (!middle || distance < Math.abs(middle.at / count - 0.5))) middle = tick;
    }
    if (middle) middle.primary = true;
    return ticks;
  }
  return [];
}
