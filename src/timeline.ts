export interface TimelineBucket {
  start: number;
  end: number;
}

/**
 * Keep the overview bounded while the slider can still select every charted revision. Revisions
 * before `first` are left out, so a long history without configuration does not flatten the chart.
 * The HTML report embeds this function's source, so it must stay self-contained.
 */
export function timelineBuckets(revisions: number, maxBars = 100, first = 0): TimelineBucket[] {
  const valid = (value: number, minimum: number) => Number.isSafeInteger(value) && value >= minimum;
  if (!valid(revisions, 0) || !valid(maxBars, 1) || !valid(first, 0) || first > revisions) {
    throw new Error("Invalid timeline size");
  }
  const charted = revisions - first;
  const count = Math.min(charted, maxBars);
  return Array.from({ length: count }, (_, index) => ({
    start: first + Math.floor((index * charted) / count),
    end: first + Math.floor(((index + 1) * charted) / count) - 1,
  }));
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
 * and from the dates already printed at both ends. Bars are revisions, not equal stretches of time, so boundaries can
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
