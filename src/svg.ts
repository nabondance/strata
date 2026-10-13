import { type Category, categories } from "./adapters.js";
import { markSvg } from "./brand.js";
import type { Report } from "./model.js";
import { categoryColors } from "./palette.js";
import { timelineBuckets } from "./timeline.js";

const width = 800;
const left = 32;
const right = width - 32;
const plotLeft = 76;
const plotTop = 196;
const plotHeight = 180;
const plotBottom = plotTop + plotHeight;
const minimalHeight = 200;
const sans = `'Avenir Next', 'Helvetica Neue', Arial, sans-serif`;
const serif = `Georgia, 'Times New Roman', serif`;
const mono = `ui-monospace, SFMono-Regular, Menlo, monospace`;
const numberFormat = new Intl.NumberFormat("en-US");
const compactFormat = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/**
 * Render a static image of the stored-instruction history, sized for a README. It draws the
 * all-files view from stored revision totals: one layer per category, at most 100 steps, starting
 * at the first revision with a tracked file. It holds no paths, commit IDs, or source text, and
 * no script, so it displays wherever SVG images are allowed.
 *
 * With `minimal`, it draws only the layers, edge to edge on a transparent background: no visible
 * text, axes, or legend, and no repository or branch name.
 */
export function renderSvg(report: Report, options: { minimal?: boolean } = {}): string {
  const revisions = report.revisions;
  const latest = revisions.at(-1);
  const chartStart = Math.max(
    0,
    revisions.findIndex((revision) => revision.componentCount > 0),
  );
  const buckets = revisions.length ? timelineBuckets(revisions.length, 100, chartStart) : [];
  const charted = buckets.map((bucket) => revisions[bucket.end]!);
  const first = revisions[chartStart];
  // Like the HTML timeline, the scale and legend cover every charted revision, not only the last in each step.
  const range = revisions.slice(chartStart);
  const layers = categories.filter((category) => range.some((revision) => tokens(revision, category) > 0));
  const max = Math.max(0, ...range.map((revision) => revision.estimatedTokens));
  const tokenAdjective = report.measurement.accuracy === "encoding-exact" ? "Encoding" : "Estimated";
  const latestTotals = `${numberFormat.format(latest?.estimatedTokens ?? 0)} tokens in ${numberFormat.format(latest?.componentCount ?? 0)} tracked files at the latest of ${numberFormat.format(revisions.length)} revisions`;
  if (options.minimal) {
    const minimalStep = width / Math.max(1, charted.length);
    const description = `${tokenAdjective} stored-text tokens in Git-tracked agent configuration through time, one layer per category: ${latestTotals}.`;
    return [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${minimalHeight}" viewBox="0 0 ${width} ${minimalHeight}" role="img" aria-labelledby="strata-title strata-desc">`,
      `<title id="strata-title">Strata: agent context through time</title>`,
      `<desc id="strata-desc">${escapeXml(description)}</desc>`,
      ...layerPolygons(
        charted,
        layers,
        (index) => round(index * minimalStep),
        (value) => round(minimalHeight - (value / Math.max(1, max)) * minimalHeight),
      ),
      `</svg>`,
      "",
    ].join("\n");
  }
  const step = niceStep(max / 4);
  const yMax = Math.max(step, Math.ceil(max / step) * step);
  const y = (value: number) => round(plotBottom - (value / yMax) * plotHeight);
  const stepWidth = (right - plotLeft) / Math.max(1, charted.length);
  const x = (index: number) => round(plotLeft + index * stepWidth);
  const repository = truncate(`${report.repository} / ${report.branch}`, 60);
  const change = latest && first ? latest.estimatedTokens - first.estimatedTokens : 0;

  const parts: string[] = [];
  const add = (line: string) => parts.push(line);

  // The mark is centered on the capitals of the name beside it, whose baseline is at y = 40.
  add(`<g transform="translate(${left} 25)">${markSvg(22)}</g>`);
  add(
    `<text x="${left + 32}" y="40" font-family="${sans}" font-size="12" font-weight="800" letter-spacing="2.6">STRATA</text>`,
  );
  add(
    `<text x="${right}" y="40" text-anchor="end" font-family="${mono}" font-size="11" fill="#5c6a63">${escapeXml(repository)}</text>`,
  );
  add(`<line x1="${left}" y1="54" x2="${right}" y2="54" stroke="#b9b8ac"/>`);
  add(
    `<text x="${left}" y="96" font-family="${serif}" font-size="30" letter-spacing="-1.2">Agent context through time</text>`,
  );

  const stats = [
    [`${tokenAdjective} tokens`, numberFormat.format(latest?.estimatedTokens ?? 0)],
    ["Tracked files", numberFormat.format(latest?.componentCount ?? 0)],
    ["Revisions", numberFormat.format(revisions.length)],
    [first && charted.length ? `Since ${first.date.slice(0, 10)}` : "Change", signed(change)],
  ] as const;
  const statWidth = (right - left) / stats.length;
  add(`<line x1="${left}" y1="120" x2="${right}" y2="120" stroke="#24312c" stroke-width="2"/>`);
  for (const [index, [label, value]] of stats.entries()) {
    const statX = round(left + index * statWidth);
    if (index) add(`<line x1="${statX}" y1="121" x2="${statX}" y2="172" stroke="#c9c8be"/>`);
    const textX = index ? statX + 14 : statX;
    add(
      `<text x="${textX}" y="140" font-family="${mono}" font-size="10" letter-spacing="0.8" fill="#5c6a63">${escapeXml(label.toUpperCase())}</text>`,
    );
    add(
      `<text x="${textX}" y="164" font-family="${sans}" font-size="22" font-weight="650" letter-spacing="-0.6">${escapeXml(value)}</text>`,
    );
  }
  add(`<line x1="${left}" y1="172" x2="${right}" y2="172" stroke="#c9c8be"/>`);

  for (let value = 0; value <= yMax; value += step) {
    const lineY = y(value);
    if (value) add(`<line x1="${plotLeft}" y1="${lineY}" x2="${right}" y2="${lineY}" stroke="#e4e2d9"/>`);
    add(
      `<text x="${plotLeft - 8}" y="${lineY + 4}" text-anchor="end" font-family="${mono}" font-size="10" fill="#5c6a63">${compactFormat.format(value)}</text>`,
    );
  }

  for (const polygon of layerPolygons(charted, layers, x, y)) add(polygon);
  if (max === 0) {
    add(
      `<text x="${round((plotLeft + right) / 2)}" y="${plotTop + plotHeight / 2}" text-anchor="middle" font-family="${sans}" font-size="13" fill="#5c6a63">No instructional text is tracked yet.</text>`,
    );
  }
  add(`<line x1="${plotLeft}" y1="${plotBottom}" x2="${right}" y2="${plotBottom}" stroke="#8b9289"/>`);
  if (first && latest) {
    add(
      `<text x="${plotLeft}" y="${plotBottom + 18}" font-family="${mono}" font-size="11" fill="#5c6a63">${escapeXml(first.date.slice(0, 10))}</text>`,
    );
    add(
      `<text x="${right}" y="${plotBottom + 18}" text-anchor="end" font-family="${mono}" font-size="11" fill="#5c6a63">${escapeXml(latest.date.slice(0, 10))}</text>`,
    );
  }

  // Text cannot be measured here, so legend entries are placed by an estimated label width.
  let legendX = left;
  let legendY = plotBottom + 50;
  for (const category of layers) {
    const itemWidth = 16 + category.length * 7 + 22;
    if (legendX > left && legendX + itemWidth > right) {
      legendX = left;
      legendY += 22;
    }
    add(`<rect x="${legendX}" y="${legendY - 9}" width="10" height="10" fill="${categoryColors[category]}"/>`);
    add(
      `<text x="${legendX + 16}" y="${legendY}" font-family="${sans}" font-size="12" fill="#5c6a63">${category}</text>`,
    );
    legendX += itemWidth;
  }

  const notes = [
    `${report.measurement.label}. Stored configuration in Git, not loaded session context or billing.`,
    ...(buckets.length < range.length
      ? [
          `${numberFormat.format(range.length)} revisions shown as ${buckets.length} steps; each step shows the last revision in its group.`,
        ]
      : []),
    ...(chartStart
      ? [
          `The chart starts at revision ${numberFormat.format(chartStart + 1)}: the ${numberFormat.format(chartStart)} earlier revisions have no tracked configuration.`,
        ]
      : []),
    ...(report.shallow ? ["Shallow clone: earlier history is missing."] : []),
  ];
  let noteY = legendY + (layers.length ? 30 : 0);
  for (const note of notes) {
    add(`<text x="${left}" y="${noteY}" font-family="${sans}" font-size="11" fill="#5c6a63">${escapeXml(note)}</text>`);
    noteY += 16;
  }
  const height = noteY + 14;

  const description = `${tokenAdjective} stored-text tokens in Git-tracked agent configuration of ${repository}: ${latestTotals}.`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="strata-title strata-desc">`,
    `<title id="strata-title">Strata: agent context through time</title>`,
    `<desc id="strata-desc">${escapeXml(description)}</desc>`,
    `<rect width="${width}" height="${height}" fill="#fbfaf6"/>`,
    `<g fill="#24312c">`,
    ...parts,
    `</g>`,
    `</svg>`,
    "",
  ].join("\n");
}

/** Each category is a stepped layer stacked on the ones before it, like strata in a cut. */
function layerPolygons(
  charted: Report["revisions"],
  layers: Category[],
  x: (index: number) => number,
  y: (value: number) => number,
): string[] {
  const below = charted.map(() => 0);
  return layers.map((category) => {
    const bottom = [...below];
    for (const [index, revision] of charted.entries()) below[index]! += tokens(revision, category);
    const top = charted.flatMap((_, index) => [
      `${x(index)},${y(below[index]!)}`,
      `${x(index + 1)},${y(below[index]!)}`,
    ]);
    const base = charted
      .flatMap((_, index) => [`${x(index)},${y(bottom[index]!)}`, `${x(index + 1)},${y(bottom[index]!)}`])
      .reverse();
    return `<polygon points="${[...top, ...base].join(" ")}" fill="${categoryColors[category]}"/>`;
  });
}

function tokens(revision: Report["revisions"][number], category: Category): number {
  return revision.categoryTotals[category].estimatedTokens;
}

/** A 1, 2, 2.5, or 5 multiple of a power of ten, so axis labels stay round; token counts are whole, so 2.5 needs ten or more. */
function niceStep(raw: number): number {
  if (!(raw > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(raw));
  const multiples = power >= 10 ? [1, 2, 2.5, 5, 10] : [1, 2, 5, 10];
  const multiple = multiples.find((candidate) => candidate * power >= raw) ?? 10;
  return Math.max(1, multiple * power);
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function signed(value: number): string {
  return (value > 0 ? "+" : value < 0 ? "−" : "") + numberFormat.format(Math.abs(value));
}

function truncate(value: string, length: number): string {
  const characters = [...value];
  return characters.length > length ? `${characters.slice(0, length - 1).join("")}…` : value;
}

/** Repository and branch names come from the filesystem and Git; XML also forbids most control characters. */
function escapeXml(value: string): string {
  return [...value]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (code >= 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) && code !== 0xfffe && code !== 0xffff;
    })
    .join("")
    .replace(
      /[&<>"']/g,
      (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character] ?? character,
    );
}
