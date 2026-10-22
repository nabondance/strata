import type { Report } from "./model.js";

/** Instruction text present at one revision, by the revision it appeared at. */
export interface InstructionAge {
  /** UTF-8 bytes of trimmed, nonblank instruction lines present. */
  bytes: number;
  /** The same bytes split by `from`, the index of the revision they appeared at; oldest first, none empty. */
  cohorts: Array<{ from: number; bytes: number }>;
}

/**
 * Replay each revision's `lineAge` to give the age of the instruction text at every revision.
 * Bytes only ever leave a cohort after the revision that added them, so the bytes at a target
 * revision whose `from` is at or before a baseline revision are exactly the baseline's text that
 * stayed present the whole time. Revisions that moved no line share the previous revision's object.
 *
 * The HTML report embeds this function's source, so it must stay self-contained.
 */
export function instructionAges(report: Pick<Report, "revisions">): InstructionAge[] {
  const present = new Map<number, number>();
  let current: InstructionAge = { bytes: 0, cohorts: [] };
  return report.revisions.map((revision, index) => {
    const change = revision.lineAge;
    if (!change) return current;
    for (const { from, bytes } of change.removed ?? []) {
      const left = (present.get(from) ?? 0) - bytes;
      if (left > 0) present.set(from, left);
      else present.delete(from);
    }
    if (change.added) present.set(index, change.added);
    const cohorts = Array.from(present, ([from, bytes]) => ({ from, bytes })).sort((a, b) => a.from - b.from);
    current = { bytes: cohorts.reduce((sum, cohort) => sum + cohort.bytes, 0), cohorts };
    return current;
  });
}

export interface InstructionAgeSummary {
  /** Bytes of instruction lines at the last revision. */
  bytes: number;
  /** The date of the revision by which half of those bytes had appeared. */
  medianDate: string;
  /** The first revision with instruction text, and the share of its bytes still present at the last. */
  firstDate: string;
  firstBytes: number;
  kept: number;
}

/** The age of the last revision's instruction text in a few figures, or null when it has none. */
export function summarizeInstructionAge(report: Pick<Report, "revisions">): InstructionAgeSummary | null {
  const ages = instructionAges(report);
  const last = ages.at(-1);
  const first = ages.findIndex((age) => age.bytes);
  if (!last?.bytes || first < 0) return null;
  let seen = 0;
  const median = last.cohorts.find((cohort) => {
    seen += cohort.bytes;
    return seen * 2 >= last.bytes;
  })!;
  const kept = last.cohorts.reduce((sum, cohort) => sum + (cohort.from <= first ? cohort.bytes : 0), 0);
  return {
    bytes: last.bytes,
    medianDate: report.revisions[median.from]!.date,
    firstDate: report.revisions[first]!.date,
    firstBytes: ages[first]!.bytes,
    kept: kept / ages[first]!.bytes,
  };
}
