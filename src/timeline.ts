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
