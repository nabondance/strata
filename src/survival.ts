export interface LineSurvival {
  method: "exact-nonblank-line-multiset-v1";
  originalLines: number;
  survivingLines: number;
  fraction: number | null;
}

function normalizedLines(texts: Iterable<string>): string[] {
  const lines: string[] = [];
  for (const text of texts) {
    for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
      const normalized = line.trim();
      if (normalized) lines.push(normalized);
    }
  }
  return lines;
}

/** Exact-line survival across two sets of instructional files, independent of file path or line order. */
export function measureLineSurvival(beforeTexts: Iterable<string>, afterTexts: Iterable<string>): LineSurvival {
  const before = normalizedLines(beforeTexts);
  const remaining = new Map<string, number>();
  for (const line of normalizedLines(afterTexts)) remaining.set(line, (remaining.get(line) ?? 0) + 1);
  let survivingLines = 0;
  for (const line of before) {
    const count = remaining.get(line) ?? 0;
    if (count > 0) {
      survivingLines += 1;
      remaining.set(line, count - 1);
    }
  }
  return {
    method: "exact-nonblank-line-multiset-v1",
    originalLines: before.length,
    survivingLines,
    fraction: before.length ? survivingLines / before.length : null,
  };
}
