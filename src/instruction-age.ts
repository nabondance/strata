import type { Report } from "./model.js";

/** Bytes of instruction text that appeared at one revision, `from`, and are still present. */
export interface AgeCohort {
  from: number;
  bytes: number;
}

/** The age of the instruction text through a report's history. */
export interface InstructionAges {
  /** Stored bytes of trimmed, nonblank instruction lines present at each revision. */
  bytes: number[];
  /** The text present at a revision by the revision it appeared at, oldest first, none empty. */
  at: (index: number) => AgeCohort[];
}

/**
 * Replay each revision's `lineAge` to give the age of the instruction text at any revision. Bytes
 * only ever leave a cohort after the revision that added them, so the bytes at a target revision
 * whose `from` is at or before a baseline revision are exactly the baseline's text that stayed
 * present the whole time.
 *
 * Totals are summed once. Cohorts are replayed on request by one cursor that only moves forward,
 * so asking for revisions in increasing order costs one pass over the history; asking for an
 * earlier revision restarts it. Nothing grows with revisions multiplied by cohorts.
 *
 * The HTML report embeds this function's source, so it must stay self-contained.
 */
export function instructionAges(report: Pick<Report, "revisions">): InstructionAges {
  const revisions = report.revisions;
  const bytes: number[] = [];
  let total = 0;
  for (const revision of revisions) {
    for (const { bytes: removed } of revision.lineAge?.removed ?? []) total -= removed;
    total += revision.lineAge?.added ?? 0;
    bytes.push(total);
  }
  let present = new Map<number, number>();
  let cursor = -1;
  let cohorts: AgeCohort[] = [];
  let stale = true;
  const at = (index: number): AgeCohort[] => {
    if (index < cursor) {
      present = new Map();
      cursor = -1;
      stale = true;
    }
    while (cursor < index) {
      cursor += 1;
      const change = revisions[cursor]?.lineAge;
      if (!change) continue;
      stale = true;
      for (const { from, bytes: removed } of change.removed ?? []) {
        const left = (present.get(from) ?? 0) - removed;
        if (left > 0) present.set(from, left);
        else present.delete(from);
      }
      if (change.added) present.set(cursor, change.added);
    }
    if (stale) {
      cohorts = Array.from(present, ([from, amount]) => ({ from, bytes: amount })).sort((a, b) => a.from - b.from);
      stale = false;
    }
    return cohorts;
  };
  return { bytes, at };
}

/** A period instruction text is grouped by: its sort key and how it is labeled. */
export interface AgePeriod {
  key: string;
  label: string;
}

/**
 * Group the revisions that added instruction text into periods of their author dates, using the
 * date as written (the author's local date, as the report shows it). The period is the finest of
 * week (starting Monday), month, quarter, and year that gives at most `maxPeriods` periods; a
 * history spanning more years than that keeps one period per year. `periodOf` maps each revision
 * that added text to the index of its period.
 *
 * The HTML report embeds this function's source, so it must stay self-contained.
 */
export function instructionAgePeriods(
  report: Pick<Report, "revisions">,
  maxPeriods = 8,
): { kind: string; periods: AgePeriod[]; periodOf: Map<number, number> } {
  const origins: number[] = [];
  report.revisions.forEach((revision, index) => {
    if (revision.lineAge?.added) origins.push(index);
  });
  const day = (index: number) => report.revisions[index]!.date.slice(0, 10);
  const week = (date: string) => {
    const at = new Date(`${date}T00:00:00Z`);
    at.setUTCDate(at.getUTCDate() - ((at.getUTCDay() + 6) % 7));
    return at.toISOString().slice(0, 10);
  };
  const quarter = (date: string) => `${date.slice(0, 4)} Q${Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1}`;
  const kinds: Array<[string, (date: string) => string, (key: string) => string]> = [
    ["week", week, (key) => `Week of ${key}`],
    ["month", (date) => date.slice(0, 7), (key) => key],
    ["quarter", quarter, (key) => key],
    ["year", (date) => date.slice(0, 4), (key) => key],
  ];
  let chosen = { kind: "year", periods: [] as AgePeriod[], periodOf: new Map<number, number>() };
  for (const [kind, key, label] of kinds) {
    const keys = new Map(origins.map((index) => [index, key(day(index))]));
    const distinct = [...new Set(keys.values())].sort();
    const position = new Map(distinct.map((value, index) => [value, index]));
    chosen = {
      kind,
      periods: distinct.map((value) => ({ key: value, label: label(value) })),
      periodOf: new Map(Array.from(keys, ([index, value]) => [index, position.get(value)!])),
    };
    if (distinct.length <= maxPeriods) break;
  }
  return chosen;
}

/**
 * A share as a whole percentage that never rounds a part down to 0% or a part up to 100%.
 *
 * The HTML report embeds this function's source, so it must stay self-contained.
 */
export function sharePercent(fraction: number): string {
  const share = fraction * 100;
  if (share > 0 && share < 1) return "<1%";
  if (share > 99 && share < 100) return ">99%";
  return `${Math.round(share)}%`;
}

export interface InstructionAgeSummary {
  /** Bytes of instruction lines at the last revision. */
  bytes: number;
  /** The index of the revision by which half of those bytes had appeared. */
  median: number;
  /** The first revision with instruction text, its bytes, and the share of them still present at the last. */
  first: number;
  firstBytes: number;
  kept: number;
}

/** The age of the last revision's instruction text in a few figures, or null when it has none. */
export function summarizeInstructionAge(report: Pick<Report, "revisions">): InstructionAgeSummary | null {
  const ages = instructionAges(report);
  const last = report.revisions.length - 1;
  const bytes = ages.bytes[last] ?? 0;
  const first = ages.bytes.findIndex((amount) => amount > 0);
  if (!bytes || first < 0) return null;
  const cohorts = ages.at(last);
  let seen = 0;
  const median = cohorts.find((cohort) => {
    seen += cohort.bytes;
    return seen * 2 >= bytes;
  })!;
  const kept = cohorts.reduce((sum, cohort) => sum + (cohort.from <= first ? cohort.bytes : 0), 0);
  const firstBytes = ages.bytes[first]!;
  return { bytes, median: median.from, first, firstBytes, kept: kept / firstBytes };
}
