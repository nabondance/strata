import { displayFontBase64 } from "./brand-font.js";

/** Masthead and logo colors. Category colors stay in palette.ts. */
export const brandColors = {
  bedrock: "#1d2622",
  bone: "#efeadb",
  ochre: "#d9a441",
  clay: "#b5573a",
  verdigris: "#5f8f8a",
};

/** Where the report's own name links to. The package page is public; it is only followed on click. */
export const brandUrl = "https://www.npmjs.com/package/context-strata";

/** The embedded display face first, then the condensed faces systems ship, for when it cannot load. */
export const displayFontStack = `"Strata Display", "Avenir Next Condensed", "Helvetica Neue Condensed", Bahnschrift, "Arial Narrow", "Roboto Condensed", sans-serif`;

export const displayFontFace = `@font-face { font-family: "Strata Display"; font-weight: 800; font-display: block; src: url(data:font/woff2;base64,${displayFontBase64}) format("woff2"); }`;

const markBands: [top: number, height: number, color: string][] = [
  [-14, 26, brandColors.ochre],
  [16, 11, brandColors.bone],
  [31, 15, brandColors.clay],
  [50, 30, brandColors.verdigris],
];
/** How far the layers right of the fault have slipped, in mark units. */
const markSlip = 9;

/**
 * The Strata mark: layers cut by a fault, with the right side slipped down. Drawn on a 64-unit
 * square; `id` names its clip path and must be unique within the document that holds it.
 */
export function markSvg(size: number, id = "strata-mark"): string {
  const round = (value: number) => Math.round(value * 100) / 100;
  // The fault leans left as it descends; the two edges leave a gap that shows the background.
  const edge = (top: number, y: number) => round(top - (14 * y) / 64);
  const shapes: string[] = [];
  for (const [top, height, color] of markBands) {
    const from = Math.max(0, top);
    const to = Math.min(64, top + height);
    const slippedFrom = Math.max(0, top + markSlip);
    const slippedTo = Math.min(64, top + height + markSlip);
    // Paths, not polygons: in the SVG image polygons are the chart's layers.
    shapes.push(
      `<path d="M0,${from}H${edge(38, from)}L${edge(38, to)},${to}H0Z" fill="${color}"/>`,
      `<path d="M${edge(42, slippedFrom)},${slippedFrom}H64V${slippedTo}H${edge(42, slippedTo)}Z" fill="${color}"/>`,
    );
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true"><clipPath id="${id}"><rect width="64" height="64" rx="10"/></clipPath><g clip-path="url(#${id})"><rect width="64" height="64" fill="${brandColors.bedrock}"/>${shapes.join("")}</g></svg>`;
}
