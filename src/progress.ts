import type { AnalysisProgress } from "./analyze.js";

/** A run that finishes sooner than this prints no progress at all. */
export const progressDelayMs = 2000;

export interface ProgressStream {
  isTTY?: boolean | undefined;
  write: (text: string) => unknown;
}

/**
 * Report analysis progress once the run has taken longer than `delayMs`: on a terminal, one line
 * rewritten in place and cleared when done; elsewhere, such as CI logs, a line per tenth of history.
 */
export function progressReporter(
  stream: ProgressStream,
  now: () => number = Date.now,
  delayMs = progressDelayMs,
): (progress: AnalysisProgress) => void {
  const interactive = !!stream.isTTY;
  const start = now();
  let shown = false;
  let finished = false;
  let lastStep = -1;
  return ({ completed, total }) => {
    if (finished || completed === 0 || (!shown && now() - start < delayMs)) return;
    const done = completed >= total;
    const step = Math.floor((completed * (interactive ? 100 : 10)) / total);
    // The first line after the delay is printed whatever the step, so a slow run says where it is.
    if (shown && step === lastStep && !done) return;
    shown = true;
    finished = done;
    lastStep = step;
    if (interactive) {
      stream.write(`\r\x1b[KAnalyzing revisions ${completed}/${total}${done ? "\r\x1b[K" : ""}`);
    } else {
      stream.write(`Processed ${completed}/${total} revisions.\n`);
    }
  };
}
