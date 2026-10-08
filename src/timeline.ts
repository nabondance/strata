export interface TimelineBucket {
  start: number;
  end: number;
}

/** Keep the overview bounded while the slider can still select every revision. */
export function timelineBuckets(revisions: number, maxBars = 100): TimelineBucket[] {
  if (!Number.isSafeInteger(revisions) || revisions < 0 || !Number.isSafeInteger(maxBars) || maxBars < 1) {
    throw new Error("Invalid timeline size");
  }
  const count = Math.min(revisions, maxBars);
  return Array.from({ length: count }, (_, index) => ({
    start: Math.floor(index * revisions / count),
    end: Math.floor((index + 1) * revisions / count) - 1,
  }));
}
