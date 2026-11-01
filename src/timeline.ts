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
 * The line under a grouped timeline, shared by the HTML report and the SVG image; empty when every charted revision
 * has its own bar. `higher` says whether some bar hides a higher total, which a dashed line marks.
 * The HTML report embeds this function's source, so it must stay self-contained.
 */
export function timelineStepsNote(
  revisions: number,
  buckets: readonly TimelineBucket[],
  higher: boolean,
  format: (value: number) => string = (value) => new Intl.NumberFormat("en-US").format(value),
): string {
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
