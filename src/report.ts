import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { categories } from "./adapters.js";
import { brandColors, brandUrl, displayFontFace, displayFontStack, markSvg } from "./brand.js";
import { compareRevisions } from "./compare.js";
import { configMap } from "./config-map.js";
import { expandRevisions } from "./expand.js";
import { importLinks } from "./import-links.js";
import type { Report } from "./model.js";
import { categoryColors, categoryInk, categoryShade, categoryShadeInk } from "./palette.js";
import { textRecipients } from "./provider-count.js";
import { providerReads, viewRevision } from "./provider-view.js";
import { timelineBuckets } from "./timeline.js";
import { layoutTreemap } from "./treemap.js";
import { sessionProviderNames, upFrontContext } from "./up-front.js";

let embeddedD3: string | undefined;

/** The report inlines d3-hierarchy with its license so the HTML needs no network or sibling files. */
function d3Bundle(): string {
  if (embeddedD3 === undefined) {
    const directory = resolve(dirname(createRequire(import.meta.url).resolve("d3-hierarchy")), "..");
    const license = readFileSync(resolve(directory, "LICENSE"), "utf8");
    const source = readFileSync(resolve(directory, "dist/d3-hierarchy.min.js"), "utf8");
    embeddedD3 = `/*\n${license.replace(/\*\//g, "* /")}\n*/\n${source}`.replace(/<\/script/gi, "<\\/script");
  }
  return embeddedD3;
}

export function renderHtml(report: Report): string {
  const tokenAdjective = report.measurement.accuracy === "encoding-exact" ? "Encoding" : "Estimated";
  const serialized = JSON.stringify(report)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  const categoryNames = JSON.stringify(categories);
  const compareSource = compareRevisions.toString();
  const expandSource = expandRevisions.toString();
  const treemapSource = layoutTreemap.toString();
  const viewSource = viewRevision.toString();
  const readsSource = providerReads.toString();
  const timelineSource = timelineBuckets.toString();
  const importsSource = importLinks.toString();
  const upFrontSource = upFrontContext.toString();
  const mapSource = configMap.toString();
  const accuracyLabels = { "api-counted": "API", "encoding-exact": "local exact", estimate: "estimate" } as const;
  const providerNames = { claude: "Claude", gemini: "Gemini", codex: "Codex" } as const;
  const providerColumns = (report.providerMeasurements ?? [])
    .map(
      (measured) =>
        `<th class="num" title="${escapeHtml([measured.accuracy, measured.model, measured.method, measured.credential].filter(Boolean).join(" · "))}">${providerNames[measured.provider]} ${accuracyLabels[measured.accuracy]}</th>`,
    )
    .join("");
  const sentTo = (report.providerMeasurements ?? []).filter((measured) => textRecipients(measured).length);
  const providerNote = report.providerMeasurements
    ? `Provider columns are each provider's own count and are never added together. ${
        sentTo.length
          ? `Text sent to: ${sentTo.map((measured) => `${escapeHtml(textRecipients(measured).join(" and "))} (${providerNames[measured.provider]})`).join(", ")}.`
          : "No text was sent to a provider."
      }`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; img-src data:">
  <title>Strata — ${escapeHtml(report.repository)}</title>
  <link rel="icon" href="data:image/svg+xml,${encodeURIComponent(markSvg(64))}">
  <style>
    ${displayFontFace}
    :root { color-scheme: light dark; --paper: #f2efe7; --sheet: #fbfaf6; --ink: #24312c; --muted: #5c6a63; --line: #c9c8be; --grid: #e4e2d9; --edge: #9fa99d; --hover: #ece9de; --field: #fff; --up: #80590a; --down: #2c6b65; --warn: #8a442c; --clay: ${brandColors.clay}; --bedrock: ${brandColors.bedrock}; --bone: ${brandColors.bone}; --ochre: ${brandColors.ochre}; font-family: "Avenir Next", "Helvetica Neue", Arial, sans-serif; background: var(--paper); color: var(--ink); }
    @media (prefers-color-scheme: dark) { :root { --paper: #121815; --sheet: #1a221e; --ink: #e7e3d6; --muted: #9ba499; --line: #37423c; --grid: #28322d; --edge: #56625b; --hover: #242e29; --field: #131916; --up: ${brandColors.ochre}; --down: #8fbdb7; --warn: #e39072; } }
    * { box-sizing: border-box; }
    body { margin: 0; }
    header { background: var(--bedrock); color: var(--bone); }
    .masthead { padding: 0 max(24px, calc((100vw - 1200px) / 2)); }
    .header-top { display: flex; gap: 12px; align-items: center; padding-top: 18px; }
    .header-top svg { flex: none; }
    .brand { display: flex; gap: 12px; align-items: center; color: inherit; text-decoration: none; }
    .brand:hover .wordmark, .brand:focus-visible .wordmark { color: var(--ochre); }
    .wordmark { font-family: ${displayFontStack}; font-size: 24px; font-weight: 800; letter-spacing: .03em; line-height: 1; }
    h1 { font-family: ${displayFontStack}; font-size: clamp(44px, 7vw, 84px); font-weight: 800; line-height: .92; overflow-wrap: anywhere; margin: 26px 0 10px; }
    .repo-meta { color: #a9b0a4; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; letter-spacing: .04em; line-height: 1.5; margin: 0; overflow-wrap: anywhere; }
    .stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0 16px; border-top: 1px solid #4a554f; margin-top: 26px; }
    .stat { padding: 14px 0 20px; min-width: 0; }
    .stat span { display: block; color: #a9b0a4; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; text-transform: uppercase; letter-spacing: .08em; margin-bottom: 6px; }
    .stat strong { font-family: ${displayFontStack}; font-size: clamp(25px, 3vw, 34px); font-weight: 800; letter-spacing: .01em; font-variant-numeric: tabular-nums lining-nums; }
    header .positive { color: var(--ochre); }
    header .negative { color: #8fbdb7; }
    .silhouette { position: relative; height: 110px; }
    .silhouette i { position: absolute; inset: 0; }
    .muted { color: var(--muted); line-height: 1.5; }
    main { max-width: 1248px; padding: 26px 24px 64px; margin: auto; }
    .notice { max-width: 970px; color: var(--muted); line-height: 1.55; margin: 0 0 18px; font-size: 13px; overflow-wrap: anywhere; }
    .notice summary { cursor: pointer; width: fit-content; }
    .notice summary:focus-visible { outline: 2px solid var(--clay); outline-offset: 2px; }
    .notice p { margin: 8px 0 0; }
    .notice summary .counting-summary { color: var(--ink); }
    .counting { width: auto; margin: 6px 0 0; }
    .counting td { padding: 4px 14px 4px 0; border: 0; vertical-align: baseline; }
    .counting tr.active td:first-child { font-weight: 700; color: var(--ink); }
    .counting .badge { display: inline-block; padding: 1px 7px; border: 1px solid currentColor; font-size: 12px; font-weight: 600; white-space: nowrap; }
    .counting .badge.exact { color: var(--down); }
    .counting .badge.estimate { color: var(--warn); }
    .warning { color: var(--warn); font-weight: 600; }
    .panel { background: var(--sheet); border: 1px solid var(--line); padding: 24px; margin-bottom: 18px; min-width: 0; }
    .panel h2 { font-family: ${displayFontStack}; font-size: 24px; font-weight: 800; letter-spacing: .02em; line-height: 1.05; text-transform: uppercase; margin: 0 0 14px; }
    .panel h2 + p { font-size: 13px; margin: -5px 0 18px; }
    details.panel > summary { display: flex; align-items: baseline; gap: 12px; cursor: pointer; list-style: none; }
    details.panel > summary::-webkit-details-marker { display: none; }
    details.panel > summary::after { content: "+"; margin-left: auto; font-family: ${displayFontStack}; font-size: 24px; font-weight: 800; line-height: 1; }
    details.panel[open] > summary::after { content: "−"; }
    details.panel[open] > summary { margin-bottom: 16px; }
    details.panel > summary:focus-visible { outline: 2px solid var(--clay); outline-offset: 4px; }
    details.panel > summary h2 { margin: 0; }
    .summary-count { color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
    .panel-head { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; align-items: baseline; }
    .revision { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
    .legend { display: flex; flex-wrap: wrap; gap: 9px 20px; margin: 7px 0 17px; color: var(--muted); font-size: 12px; }
    .legend span { display: inline-flex; align-items: center; gap: 7px; }
    .legend b { color: var(--ink); font-weight: 600; font-variant-numeric: tabular-nums; }
    .swatch { display: inline-block; width: 10px; height: 10px; }
    .swatch.hollow { border: 2px solid; }
    .legend-link { display: inline-flex; align-items: center; gap: 7px; padding: 0; border: 0; background: none; color: inherit; font: inherit; cursor: pointer; }
    .legend-link:hover { color: var(--ink); text-decoration: underline; text-underline-offset: 3px; }
    .legend-link:focus-visible { outline: 2px solid var(--clay); outline-offset: 2px; }
    .chart-scroll { padding: 4px 2px 6px; }
    .chart { display: grid; align-items: end; gap: 2px; height: 220px; width: 100%; border-bottom: 1px solid var(--edge); background: repeating-linear-gradient(to top, transparent 0, transparent 54px, var(--grid) 55px); }
    .bar { position: relative; border: 0; padding: 0; margin: 0; min-width: 0; background: transparent; display: flex; align-items: end; justify-content: center; height: 100%; cursor: pointer; }
    /* A ring around a bar would cover its neighbors, so focus turns the mark under the axis clay and thickens it. */
    .bar:focus-visible { outline: none; }
    /* The selected column is tinted and marked under the axis, so nothing overlaps its neighbors. */
    .bar.selected { background: color-mix(in srgb, var(--ink) 16%, transparent); }
    .bar.selected::after, .bar.baseline::before { content: ""; position: absolute; left: 0; right: 0; bottom: -6px; height: 3px; background: var(--ink); }
    .bar.baseline::before { background: var(--ochre); }
    .bar:focus-visible::after { content: ""; position: absolute; left: -1px; right: -1px; bottom: -7px; height: 5px; background: var(--clay); }
    .stack { width: 100%; display: flex; flex-direction: column-reverse; overflow: hidden; min-height: 2px; }
    .segment { display: block; width: 100%; }
    input[type=range] { width: 100%; accent-color: var(--clay); margin-top: 17px; }
    .timeline-meta { display: flex; justify-content: space-between; gap: 12px; margin-top: 6px; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
    .provider-tabs { display: flex; flex-wrap: wrap; gap: 7px; margin: 0 0 11px; }
    .provider-tab { padding: 9px 14px; border: 1px solid var(--line); background: var(--sheet); color: var(--ink); font: inherit; font-size: 13px; cursor: pointer; }
    .provider-tab[aria-pressed="true"] { background: var(--ink); color: var(--sheet); border-color: var(--ink); }
    .provider-tab:focus-visible { outline: 2px solid var(--clay); outline-offset: 2px; }
    [hidden] { display: none !important; }
    .view-note { margin: 0 0 21px; color: var(--muted); font-size: 13px; line-height: 1.5; }
    .treemap { position: relative; height: 390px; background: var(--sheet); overflow: hidden; }
    .treemap-leaf, .treemap-group { transition: left .32s ease, top .32s ease, width .32s ease, height .32s ease; }
    .treemap-leaf { position: absolute; z-index: 1; display: flex; flex-direction: column; align-items: start; justify-content: space-between; gap: 5px; border: 0; padding: 8px 9px; overflow: hidden; text-align: left; cursor: pointer; font: inherit; }
    /* A rectangle too small for a label has no padding, which would otherwise make it taller than its share. */
    .treemap-leaf:empty { padding: 0; }
    .treemap-leaf.entering { animation: treemap-in .32s ease both; }
    @keyframes treemap-in { from { opacity: 0; } }
    .treemap-leaf:hover, .treemap-leaf:focus-visible { outline: 3px solid var(--ink); outline-offset: -3px; z-index: 2; }
    .treemap-leaf .leaf-name { display: block; flex-shrink: 0; max-width: 100%; overflow-wrap: normal; font-size: 13px; line-height: 1.2; font-weight: 700; }
    .treemap-leaf .leaf-size { flex-shrink: 0; margin-top: auto; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; opacity: .78; }
    .treemap-leaf [hidden] { display: none; }
    .treemap-leaf.upright .leaf-name { writing-mode: vertical-rl; max-width: none; max-height: 100%; overflow: hidden; overflow-wrap: normal; white-space: nowrap; text-overflow: ellipsis; }
    .treemap-leaf.compact { padding: 3px 5px; }
    .treemap-leaf.compact .leaf-name { overflow: hidden; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
    .treemap-leaf.changed::after { content: ""; position: absolute; inset: 2px; border: 2px solid currentColor; pointer-events: none; }
    .treemap-leaf.changed.edited::after { border-style: dashed; }
    .ring { display: inline-block; width: 13px; height: 13px; border: 2px solid var(--ink); }
    /* Browsers draw a dashed border this short as solid, so the dashes are painted: 3px on, 2px off, a dash at each corner. */
    .ring.dashed { --dash: linear-gradient(90deg, var(--ink) 3px, transparent 0); --dash-v: linear-gradient(var(--ink) 3px, transparent 0); border: 0; background: var(--dash) top left / 5px 2px repeat-x, var(--dash) bottom left / 5px 2px repeat-x, var(--dash-v) top left / 2px 5px repeat-y, var(--dash-v) top right / 2px 5px repeat-y; }
    .treemap-group { position: absolute; z-index: 0; pointer-events: none; overflow: hidden; }
    .treemap-group .group-name { display: block; padding: 0 9px; overflow: hidden; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; text-overflow: ellipsis; white-space: nowrap; }
    .treemap-group .group-name b { margin-left: 8px; font-weight: 400; opacity: .72; }
    @media (prefers-reduced-motion: reduce) { .treemap-leaf, .treemap-group { transition: none; } .treemap-leaf.entering { animation: none; } }
    .treemap-hover { min-height: 2.9em; margin: 12px 0 0; color: var(--muted); font-size: 12px; line-height: 1.45; overflow-wrap: anywhere; }
    .treemap-hover.detail { color: var(--ink); }
    .map-tools { display: flex; flex-wrap: wrap; gap: 7px; }
    .map-tools button { padding: 6px 11px; border: 1px solid var(--line); background: var(--sheet); color: var(--ink); font: inherit; font-size: 12px; cursor: pointer; }
    .map-tools button:hover { background: var(--hover); }
    .map-tools button:focus-visible { outline: 2px solid var(--clay); outline-offset: 2px; }
    .map-intro { font-size: 13px; margin: 0 0 4px; max-width: 900px; }
    .map-key { display: inline-block; flex: none; width: 9px; height: 14px; border: 2px solid var(--ink); border-left: 0; border-radius: 0 100% 100% 0 / 0 50% 50% 0; }
    .map-key.dashed { border-style: dashed; border-left: 0; }
    .config-map { --gutter: 150px; position: relative; padding-right: var(--gutter); border-top: 1px solid var(--grid); }
    .map-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(48px, 28%) 8ch; align-items: center; gap: 12px; height: 30px; padding-right: 10px; border-bottom: 1px solid var(--grid); cursor: pointer; font-size: 13px; }
    .map-row:hover, .map-row.linked { background: var(--hover); }
    .map-row:focus-visible { outline: 2px solid var(--clay); outline-offset: -2px; }
    .map-name { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .map-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .map-row.folder .map-label { font-weight: 700; }
    .map-caret { flex: none; width: 10px; color: var(--muted); font-size: 10px; }
    .map-tag { flex: none; padding: 0 5px; border: 1px solid var(--line); color: var(--muted); font-size: 10px; letter-spacing: .05em; line-height: 16px; text-transform: uppercase; white-space: nowrap; }
    .map-tag.warn { border-color: currentColor; color: var(--warn); }
    .map-bar { display: flex; height: 10px; min-width: 0; overflow: hidden; background: var(--grid); }
    .map-bar i { display: block; flex: none; min-width: 2px; height: 100%; }
    .map-bar.source-only { background: none; }
    .map-bar.source-only i { width: 10px; border: 2px solid; }
    .map-size { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
    .map-gutter { position: absolute; top: 0; right: 0; width: var(--gutter); pointer-events: none; }
    .map-arc { position: absolute; left: 0; border: 1.5px solid var(--ink); border-left: 0; border-radius: 0 100% 100% 0 / 0 50% 50% 0; opacity: .5; }
    .map-arc.dashed { border-style: dashed; border-left: 0; }
    .map-arrow { position: absolute; left: 0; width: 0; height: 0; border: 4px solid transparent; border-left: 0; border-right: 6px solid var(--ink); opacity: .5; }
    .config-map.tracing :is(.map-arc, .map-arrow) { opacity: .12; }
    .config-map.tracing .map-arc.lit { border-color: var(--clay); border-width: 2.5px; border-left: 0; opacity: 1; }
    .config-map.tracing .map-arrow.lit { border-right-color: var(--clay); opacity: 1; }
    .skill-toggle, .more { margin-top: 13px; border: 1px solid var(--edge); padding: 9px 13px; background: transparent; color: var(--ink); font: inherit; cursor: pointer; }
    .skill-toggle:hover, .more:hover { background: var(--hover); }
    .skill-toggle:focus-visible, .more:focus-visible { outline: 2px solid var(--clay); outline-offset: 2px; }
    .compare-controls, .inventory-controls { display: flex; flex-wrap: wrap; gap: 12px; margin: 8px 0 18px; align-items: end; }
    .compare-controls label, .inventory-controls label { display: grid; gap: 6px; min-width: min(100%, 230px); color: var(--muted); font-size: 12px; }
    .inventory-controls label { min-width: min(100%, 180px); }
    .inventory-controls label.search { flex: 1 1 240px; }
    :is(.compare-controls, .inventory-controls) :is(select, input) { width: 100%; border: 1px solid var(--edge); border-radius: 0; padding: 10px 11px; background: var(--field); color: var(--ink); font: inherit; }
    :is(.compare-controls, .inventory-controls) :is(select, input, button):focus-visible { outline: 2px solid var(--clay); outline-offset: 2px; }
    .inventory-controls button { border: 1px solid var(--edge); border-radius: 0; padding: 10px 13px; background: transparent; color: var(--ink); font: inherit; cursor: pointer; }
    .inventory-controls button:hover { background: var(--hover); }
    .provider-note { font-size: 13px; margin: 0 0 12px; }
    .measure-switch { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; margin: -4px 0 14px; font-size: 13px; color: var(--muted); }
    .measure-switch button { padding: 6px 11px; border: 1px solid var(--line); background: var(--sheet); color: var(--ink); font: inherit; font-size: 12px; cursor: pointer; }
    .measure-switch button[aria-pressed="true"] { background: var(--ink); color: var(--sheet); border-color: var(--ink); }
    .measure-switch button:focus-visible { outline: 2px solid var(--clay); outline-offset: 2px; }
    .inventory-count { color: var(--muted); font-size: 12px; margin: 0 0 12px; }
    .compare-summary { display: flex; flex-wrap: wrap; gap: 12px 30px; padding: 16px 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); margin: 0 0 6px; }
    .compare-summary span { color: var(--muted); font-size: 12px; }
    .compare-summary strong { display: block; color: var(--ink); font-family: ${displayFontStack}; font-size: 28px; font-weight: 800; letter-spacing: .01em; margin-top: 4px; font-variant-numeric: tabular-nums lining-nums; }
    .compare-summary strong.positive { color: var(--up); }
    .compare-summary strong.negative { color: var(--down); }
    .compare-section { margin-top: 18px; }
    .compare-section p { font-size: 13px; margin: 0 0 8px; }
    .compare-section h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; margin: 0 0 9px; }
    .grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr); gap: 18px; }
    .grid > * { min-width: 0; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { color: var(--muted); text-align: left; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; text-transform: uppercase; letter-spacing: .05em; font-weight: 600; border-bottom: 1px solid var(--edge); }
    th, td { padding: 10px 8px; vertical-align: top; }
    tbody tr + tr { border-top: 1px solid var(--grid); }
    tbody tr:hover { background: var(--hover); }
    td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    td.path { overflow-wrap: anywhere; }
    .kind { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
    .delta { white-space: nowrap; font-variant-numeric: tabular-nums; }
    .positive { color: var(--up); }
    .negative { color: var(--down); }
    .empty { color: var(--muted); font-size: 13px; }
    .table-wrap { overflow-x: auto; }
    footer a { color: inherit; }
    footer { color: var(--muted); border-top: 1px solid var(--line); margin-top: 25px; padding-top: 16px; font-size: 12px; line-height: 1.55; }
    @media (max-width: 800px) { .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); } .stat:nth-child(n+3) { border-top: 1px solid #4a554f; } .grid { grid-template-columns: minmax(0, 1fr); } }
    @media (max-width: 520px) { .masthead { padding: 0 18px; } main { padding: 20px 18px 50px; } .stat strong { font-size: 24px; } .silhouette { height: 76px; } .panel { padding: 18px; } .panel h2 { font-size: 21px; } .treemap { height: 320px; } .treemap-leaf { padding: 6px; } .config-map { --gutter: 64px; } .map-row { grid-template-columns: minmax(0, 1fr) 36px 7ch; gap: 8px; } /* Names need the room; the detail line and accessible name still give each tag. */ .map-tag { display: none; } }
  </style>
</head>
<body>
  <header>
    <div class="masthead">
      <div class="header-top"><a class="brand" href="${brandUrl}" target="_blank" rel="noopener noreferrer" title="Strata on npm">${markSvg(30)}<span class="wordmark">STRATA</span></a></div>
      <h1 id="repo"></h1>
      <p class="repo-meta" id="repo-meta"></p>
      <div class="stats">
        <div class="stat"><span>Selected revision</span><strong id="date"></strong></div>
        <div class="stat"><span id="tokens-label">${tokenAdjective} tokens</span><strong id="tokens"></strong></div>
        <div class="stat"><span>Tracked components</span><strong id="components"></strong></div>
        <div class="stat"><span>Change since previous</span><strong id="delta"></strong></div>
      </div>
    </div>
    <div class="silhouette" id="silhouette" aria-hidden="true"></div>
  </header>
  <main>
    <p class="notice warning" id="shallow" hidden>Shallow clone: earlier history is missing.</p>
    <p class="notice warning" id="submodules" hidden></p>
    ${report.privacy.mode === "shareable" ? '<p class="notice">Shareable export: names, paths, and IDs are replaced with aliases.</p>' : ""}
    <details class="notice"><summary>Stored text, not session context · how tokens are counted<span class="counting-summary" id="counting-summary"></span></summary><p id="method"></p><table class="counting" id="counting" hidden><tbody id="counting-rows"></tbody></table><p id="counting-note" hidden></p></details>
    <nav class="provider-tabs" id="provider-tabs" aria-label="Configuration view"></nav>
    <p class="view-note" id="view-note"></p>
    <div class="measure-switch" id="measure-switch" role="group" aria-label="Count with" hidden></div>
    <section class="panel">
      <div class="panel-head"><h2>Stored instruction history</h2><div class="revision" id="revision"></div></div>
      <div class="legend" id="legend"></div>
      <div class="chart-scroll"><div class="chart" id="chart"></div></div>
      <input id="slider" type="range" aria-label="Select revision">
      <div class="timeline-meta"><span id="timeline-start"></span><span id="timeline-end"></span></div>
    </section>
    <section class="panel" aria-labelledby="treemap-heading">
      <h2 id="treemap-heading">Configuration at this revision</h2>
      <div class="legend" id="treemap-legend" hidden></div>
      <div class="treemap" id="treemap" role="group" aria-label="Token-size treemap of instructional components"></div>
      <p class="treemap-hover" id="treemap-hover" aria-live="polite"></p>
    </section>
    <section class="panel" aria-labelledby="map-heading">
      <div class="panel-head"><h2 id="map-heading">Configuration map</h2><div class="map-tools" role="group" aria-label="Folders"><button type="button" id="map-expand">Open all folders</button><button type="button" id="map-collapse">Close all folders</button></div></div>
      <p class="muted map-intro">Where each file sits, with a bar for its share of the stored-text tokens. Lines are Claude @path imports, with the arrow at the imported file. A folder only holds its files, and a line does not show that a session loaded a file.</p>
      <div class="legend"><span><i class="map-key"></i>Claude import</span><span><i class="map-key dashed"></i>Import to or from a closed folder</span><span><i class="swatch hollow"></i>Source-only file, measured in bytes</span></div>
      <div class="config-map" id="config-map" role="tree" aria-labelledby="map-heading"></div>
      <p class="treemap-hover" id="map-hover" aria-live="polite"></p>
    </section>
    <details class="panel" id="upfront-panel" hidden>
      <summary><h2>At session start</h2><span class="summary-count" id="upfront-count"></span></summary>
      <p class="muted">What each agent reads as soon as a session opens at the repository root, and what it reads only when needed.</p>
      <div class="table-wrap"><table><thead><tr><th>Agent</th><th class="num" title="Files read when the session opens">Files</th><th class="num" title="Root instructions, always-on rules, and the files they import">Instructions</th><th class="num" title="Each skill's name and description; the rest of a skill is read when it is used">Skill summaries</th><th class="num" title="Instructions plus skill summaries: everything read when the session opens">Total at start</th><th class="num" title="Skills, scoped rules, commands, agents, and instructions in subfolders">When needed</th></tr></thead><tbody id="upfront-rows"></tbody></table></div>
      <p class="muted" id="upfront-note" style="white-space: pre-line"></p>
      <div class="table-wrap" id="upfront-files-wrap" hidden><table><thead><tr><th>Read at start</th><th>Kind</th><th class="num">Tokens</th></tr></thead><tbody id="upfront-files"></tbody></table></div>
    </details>
    <details class="panel" id="skills-panel">
      <summary><h2>Skill bundles</h2><span class="summary-count" id="skill-count"></span></summary>
      <div class="table-wrap"><table><thead><tr><th>Skill</th><th>Provider</th><th>Main file</th><th class="num" title="Tokens in SKILL.md, read when the skill is used">Full text</th><th class="num" title="Name and description, seen before the skill is used">Summary</th><th class="num">Extra files</th><th class="num">Extra bytes</th></tr></thead><tbody id="skill-groups"></tbody></table></div>
      <p class="muted" id="listing-note"></p>
      <button class="skill-toggle" id="skill-toggle" type="button" aria-expanded="false" hidden></button>
    </details>
    <details class="panel" id="imports-panel" hidden>
      <summary><h2>Claude imports</h2><span class="summary-count" id="imports-count"></span></summary>
      <p class="muted">Files that CLAUDE.md, CLAUDE.local.md, or AGENTS.md pull in with @path, up to four levels deep. Broken imports come first.</p>
      <div class="table-wrap"><table><thead><tr><th>File</th><th class="num">Line</th><th>Imports</th><th class="num" title="1 means imported directly by the starting file">Depth</th><th>Status</th></tr></thead><tbody id="imports"></tbody></table></div>
      <button class="more" id="imports-more" type="button" hidden></button>
    </details>
    <details class="panel" id="mcp-panel" hidden>
      <summary><h2>MCP servers</h2><span class="summary-count" id="mcp-count"></span></summary>
      <p class="muted">Servers the tracked MCP and settings files define, by name. Defined is not loaded: some tools ask before starting a project server and others start it once the folder is trusted, and user configuration is outside Git. Strata never starts a server, so the tool definitions a server sends are not measured.</p>
      <div class="table-wrap"><table><thead><tr><th>Server</th><th title="Local starts a process on your machine; remote connects to a URL">Runs</th><th>Defined in</th><th>Provider</th></tr></thead><tbody id="mcp-servers"></tbody></table></div>
      <button class="more" id="mcp-servers-more" type="button" hidden></button>
    </details>
    <section class="panel" aria-labelledby="compare-heading">
      <h2 id="compare-heading">Compare revisions</h2>
      <p class="muted">A moved file can appear as a removal plus an addition.</p>
      <div class="compare-controls">
        <label>Baseline revision<select id="baseline"></select></label>
        <label>Target revision<select id="target"></select></label>
      </div>
      <div class="compare-summary">
        <span><span id="compare-tokens-label">${tokenAdjective} stored-text tokens</span><strong id="compare-tokens"></strong></span>
        <span>Tracked files<strong id="compare-files"></strong></span>
        <span id="compare-mcp-wrap" hidden>MCP servers<strong id="compare-mcp"></strong></span>
        <span id="compare-listing-wrap" hidden><span id="compare-listing-label">Skill summary tokens</span><strong id="compare-listing"></strong></span>
      </div>
      <p class="muted" id="compare-mcp-names" hidden></p>
      <div class="grid">
        <div class="compare-section"><h3>By provider</h3><div class="table-wrap"><table><thead><tr><th>Provider</th><th class="num">Δ files</th><th class="num">Δ tokens</th></tr></thead><tbody id="compare-providers"></tbody></table></div></div>
        <div class="compare-section"><h3>By category</h3><div class="table-wrap"><table><thead><tr><th>Category</th><th class="num">Δ files</th><th class="num">Δ tokens</th></tr></thead><tbody id="compare-categories"></tbody></table></div></div>
      </div>
      <div class="compare-section"><h3>Changed components</h3><div class="table-wrap"><table><thead><tr><th>Path</th><th>Provider</th><th>Category</th><th>Change</th><th class="num">Δ tokens</th><th class="num">Δ summary</th></tr></thead><tbody id="compare-components"></tbody></table></div><button class="more" id="compare-components-more" type="button" hidden></button></div>
    </section>
    <details class="panel" id="files-panel"${report.providerMeasurements ? " open" : ""}>
      <summary><h2>Tracked components</h2><span class="summary-count" id="files-total"></span></summary>
      <div class="inventory-controls">
        <label>Provider<select id="provider-filter"><option value="">All providers</option></select></label>
        <label>Category<select id="category-filter"><option value="">All categories</option></select></label>
        <label class="search">Path search<input id="path-search" type="search" placeholder="Filter by path" autocomplete="off"></label>
        <button id="clear-filters" type="button">Clear filters</button>
      </div>
      <p class="inventory-count" id="inventory-count" aria-live="polite" hidden></p>
      ${report.providerMeasurements ? `<p class="muted provider-note">${providerNote}</p>` : ""}
      <div class="table-wrap"><table><thead><tr><th>Path</th><th>Provider</th><th>Category</th><th class="num">Tokens</th><th class="num">Bytes</th>${providerColumns}</tr></thead><tbody id="files"></tbody></table></div><button class="more" id="files-more" type="button" hidden></button></details>
    <footer>Made with <a href="${brandUrl}" target="_blank" rel="noopener noreferrer">Strata</a>.</footer>
  </main>
  <script>${d3Bundle()}</script>
  <script>
    const data = ${serialized};
    const categories = ${categoryNames};
    const expandRevisions = ${expandSource};
    const compareRevisions = ${compareSource};
    const providerReads = ${readsSource};
    const viewRevision = ${viewSource};
    const timelineBuckets = ${timelineSource};
    const importLinks = ${importsSource};
    const upFrontContext = ${upFrontSource};
    const configMap = ${mapSource};
    const agentNames = ${JSON.stringify(sessionProviderNames)};
    const hierarchy = d3.hierarchy;
    const treemap = d3.treemap;
    const layoutTreemap = ${treemapSource};
    const providerColumns = (data.providerMeasurements ?? []).map((measured) => measured.provider);
    const colors = ${JSON.stringify(categoryColors)};
    const inks = ${JSON.stringify(categoryInk)};
    const shades = ${JSON.stringify(categoryShade)};
    const shadeInks = ${JSON.stringify(categoryShadeInk)};
    const $ = (id) => document.getElementById(id);
    const numberFormat = new Intl.NumberFormat();
    const fmt = (n) => numberFormat.format(n);
    const plural = (count, word) => fmt(count) + ' ' + word + (count === 1 ? '' : 's');
    const signed = (n) => (n > 0 ? '+' : '') + fmt(n);
    const tone = (n) => n > 0 ? 'positive' : n < 0 ? 'negative' : '';
    const text = (tag, value, className) => { const node = document.createElement(tag); node.textContent = value; if (className) node.className = className; return node; };
    const revisions = expandRevisions(data);
    let selected = revisions.length - 1;
    // The baseline follows the revision before the selected one until a specific revision is chosen.
    let baseline = 'previous';
    const beforeHistory = { components: [], estimatedTokens: 0 };
    const baselineRevision = () => baseline === 'previous' ? viewRevisions[selected - 1] ?? beforeHistory : viewRevisions[baseline];
    let activeView = 'all';
    // 'estimate', or a provider whose own counts the provider view is drawn with.
    let activeMeasure = 'estimate';
    let viewRevisions = revisions;
    const tokenAdjective = ${JSON.stringify(tokenAdjective)};
    const providerNames = { claude: 'Claude', gemini: 'Gemini', codex: 'Codex' };
    const accuracyNames = { 'api-counted': 'API-counted', 'encoding-exact': 'exact (local encoding)', estimate: 'byte estimate' };
    // Providers counted with something better than the estimate can chart their own counts.
    const measures = new Map((data.providerMeasurements ?? []).filter((measured) => measured.accuracy !== 'estimate').map((measured) => [measured.provider, measured]));
    const measuredHistory = new Map();
    /** The history with each file's tokens taken from one provider's counts, rebuilt once per provider. */
    function measuredRevisions(provider) {
      if (!measuredHistory.has(provider)) {
        const components = data.components.map((component) => {
          const count = component.providerTokenCounts?.[provider];
          return count ? { ...component, estimatedTokens: count.tokens } : component;
        });
        measuredHistory.set(provider, { components, revisions: expandRevisions({ ...data, components }) });
      }
      return measuredHistory.get(provider);
    }
    function describeMeasurement(measured) {
      if (measured.accuracy === 'estimate') return providerNames[measured.provider] + ': byte estimate' + (measured.fallbacks?.length ? ' (more precise methods unavailable: ' + measured.fallbacks.join('; ') + ')' : '') + (measured.alsoSentTo?.length ? '; instruction text went to ' + measured.alsoSentTo.join(' and ') + ' through a method that then failed' : '') + '.';
      return providerNames[measured.provider] + ': ' + accuracyNames[measured.accuracy] + ' with ' + measured.model + ' — ' + measured.method + ' (' + measured.version + ')' +
        (measured.recipient ? ', counted by ' + measured.recipient : ', counted on this machine') +
        (measured.credential ? ' using ' + measured.credential : '') +
        (measured.alsoSentTo?.length ? '; instruction text also went to ' + measured.alsoSentTo.join(' and ') + ' through a method that then failed' : '') +
        (measured.fallbacks?.length ? '; more precise methods unavailable: ' + measured.fallbacks.join('; ') : '') + '.';
    }
    // The measure's name inside a sentence: provider names and acronyms keep their case.
    const inlineStat = () => activeMeasure === 'estimate' ? measureLabel().stat.toLowerCase() : measureLabel().stat;
    function measureLabel() {
      if (activeMeasure === 'estimate') return { stat: tokenAdjective + ' tokens', compare: tokenAdjective + ' stored-text tokens', meta: data.measurement.label };
      const measured = measures.get(activeMeasure);
      const kind = measured.accuracy === 'api-counted' ? 'API-counted' : 'exact';
      const name = providerNames[activeMeasure];
      return { stat: name + ' ' + kind + ' tokens', compare: name + ' ' + kind + ' tokens', meta: name + ' ' + kind + ' tokens under ' + measured.model };
    }
    // A count endpoint's result is the provider's own count, which it does not promise is exact; a local encoding is.
    const badgeNames = { 'api-counted': 'API count', 'encoding-exact': 'Exact · local', estimate: 'Estimate' };
    /** A few words per provider on how its files were counted; the full description is the row's tooltip. */
    function renderCounting() {
      const measurements = data.providerMeasurements ?? [];
      $('counting').hidden = $('counting-note').hidden = !measurements.length;
      $('counting-summary').textContent = measurements.map((measured) => ' · ' + providerNames[measured.provider] + ' ' + { 'api-counted': 'API count', 'encoding-exact': 'exact (local)', estimate: 'estimate' }[measured.accuracy]).join('');
      $('counting-rows').replaceChildren(...measurements.map((measured) => {
        const row = document.createElement('tr');
        if (measured.provider === activeMeasure) row.className = 'active';
        row.title = describeMeasurement(measured);
        const badge = text('span', badgeNames[measured.accuracy], 'badge ' + (measured.accuracy === 'estimate' ? 'estimate' : 'exact'));
        const failed = measured.fallbacks?.some((reason) => / failed: /.test(reason));
        // Missing credentials are the common case; anything else, such as a key a header cannot carry, is "unusable".
        const missing = measured.fallbacks?.every((reason) => /not installed|is not set|are not set|no signed-in|no local exact/.test(reason));
        const detail = measured.accuracy === 'estimate'
          ? (measured.alsoSentTo?.length ? 'count failed after text was sent to ' + measured.alsoSentTo.join(' and ') : failed ? 'counting failed' : missing ? 'no account or API key found' : 'no usable account or API key')
          : measured.recipient
            ? measured.model + ', counted by ' + measured.recipient + ' with ' + measured.credential
            : measured.model + ', on this machine';
        const cells = [text('td', providerNames[measured.provider]), document.createElement('td'), text('td', detail)];
        cells[1].append(badge);
        row.append(...cells);
        return row;
      }));
      $('counting-note').textContent = activeView === 'all'
        ? 'All files adds providers together, so it uses the estimate. Open a provider tab for its own count.'
        : activeMeasure === 'estimate' ? 'This view: the estimate.' : 'This view: ' + providerNames[activeMeasure] + "'s own count.";
    }
    function renderMethod() {
      renderCounting();
      // A provider view's own count is described by its row and the note below the table.
      $('method').hidden = activeMeasure !== 'estimate';
      $('method').textContent = data.measurement.accuracy === 'estimate' ? 'Estimate: UTF-8 bytes ÷ 4 per file.' : data.measurement.label + ', counted on this machine.';
      const label = measureLabel();
      $('tokens-label').textContent = label.stat;
      $('compare-tokens-label').textContent = label.compare;
      $('repo-meta').textContent = data.branch + ' · ' + fmt(revisions.length) + ' revisions · ' + revisions[0].date.slice(0, 10) + ' → ' + revisions.at(-1).date.slice(0, 10) + ' · ' + label.meta;
    }
    function renderMeasureSwitch() {
      const container = $('measure-switch');
      container.replaceChildren();
      const measured = measures.get(activeView);
      container.hidden = !measured;
      if (!measured) return;
      container.append(text('span', 'Count with'));
      for (const [key, label] of [[activeView, providerNames[activeView] + ' ' + (measured.accuracy === 'api-counted' ? 'API' : 'exact') + ' · ' + measured.model], ['estimate', 'Byte estimate']]) {
        const button = text('button', label);
        button.type = 'button';
        button.setAttribute('aria-pressed', String(activeMeasure === key));
        button.addEventListener('click', () => { if (activeMeasure !== key) setView(activeView, key); });
        container.append(button);
      }
    }
    let showAllSkills = false;
    let providerFilter = '';
    let categoryFilter = '';
    let pathSearch = '';
    let inventoryRows = new Map();
    let chartBuckets = [];
    let chartStart = 0;
    let treemapLabels = [];
    // What the line under the treemap says while no rectangle is hovered or focused.
    let treemapNote = '';
    // What each panel last drew, so moving between revisions that share an inventory redraws nothing.
    let drawn = {};
    // Long lists show their first rows until asked for the rest.
    const expanded = {};
    let settleTimer;

    $('repo').textContent = data.repository;
    renderMethod();
    $('shallow').hidden = !data.shallow;
    // Name the submodules holding agent configuration that was not analyzed; count those that could not be checked.
    const configuredSubmodules = (data.submodules || []).filter((submodule) => submodule.configFiles);
    const uncheckedSubmodules = (data.submodules || []).filter((submodule) => submodule.configFiles === null).length;
    const configFileCount = (count) => fmt(count) + ' recognized agent configuration file' + (count === 1 ? '' : 's');
    const submoduleNotes = [];
    if (configuredSubmodules.length === 1) {
      submoduleNotes.push('Not analyzed: the Git submodule ' + configuredSubmodules[0].path + ' holds ' + configFileCount(configuredSubmodules[0].configFiles) + '. Run Strata on it to see its history.');
    } else if (configuredSubmodules.length) {
      const listed = configuredSubmodules.slice(0, 5).map((submodule) => submodule.path + ' (' + fmt(submodule.configFiles) + ')');
      if (configuredSubmodules.length > 5) listed.push('and ' + fmt(configuredSubmodules.length - 5) + ' more');
      submoduleNotes.push('Not analyzed: ' + fmt(configuredSubmodules.length) + ' Git submodules hold recognized agent configuration files: ' + listed.join(', ') + '. Run Strata on one to see its history.');
    }
    if (uncheckedSubmodules) {
      submoduleNotes.push(fmt(uncheckedSubmodules) + ' Git submodule' + (uncheckedSubmodules === 1 ? ' was' : 's were') + ' not checked for agent configuration because ' + (uncheckedSubmodules === 1 ? 'it is' : 'they are') + ' not checked out at the recorded commit.');
    }
    $('submodules').hidden = !submoduleNotes.length;
    $('submodules').textContent = submoduleNotes.join(' ');
    function capped(id, items, limit, redraw) {
      const button = $(id + '-more');
      button.hidden = items.length <= limit;
      button.textContent = expanded[id] ? 'Show first ' + fmt(limit) : 'Show all ' + fmt(items.length);
      button.setAttribute('aria-expanded', String(Boolean(expanded[id])));
      button.onclick = () => { expanded[id] = !expanded[id]; redraw(); };
      return expanded[id] ? items : items.slice(0, limit);
    }
    function renderLegend() {
      const legend = $('legend');
      legend.replaceChildren();
      for (const category of categories) {
        if (!viewRevisions.some((revision) => revision.categoryTotals[category].count)) continue;
        const total = viewRevisions[selected].categoryTotals[category];
        const sourceOnly = total.count && total.count === total.sourceOnlyCount;
        const files = plural(total.count, 'file');
        // Source-only categories have no tokens and no area in the chart or treemap, so they give their
        // file count, draw a hollow swatch, and lead to their files instead.
        const label = text(sourceOnly ? 'button' : 'span', category, sourceOnly ? 'legend-link' : '');
        label.append(text('b', sourceOnly ? files : fmt(total.estimatedTokens)));
        const swatch = text('i', '', sourceOnly ? 'swatch hollow' : 'swatch');
        if (sourceOnly) {
          label.type = 'button';
          label.title = category + ': ' + files + ' measured in bytes, not tokens, so not drawn. Show in the file list.';
          label.setAttribute('aria-label', label.title);
          swatch.style.borderColor = colors[category];
          label.addEventListener('click', () => showCategoryFiles(category));
        } else {
          swatch.style.background = colors[category];
        }
        label.prepend(swatch);
        legend.append(label);
      }
    }

    function showCategoryFiles(category) {
      providerFilter = '';
      categoryFilter = category;
      pathSearch = '';
      $('provider-filter').value = '';
      $('category-filter').value = category;
      $('path-search').value = '';
      $('files-panel').open = true;
      renderInventory();
      $('files-panel').scrollIntoView({ block: 'start', behavior: 'smooth' });
    }

    function renderChart() {
      const chart = $('chart');
      chart.replaceChildren();
      chartBuckets = [];
      // Leading revisions with nothing tracked in this view would only flatten the chart.
      chartStart = Math.max(0, viewRevisions.findIndex((revision) => revision.components.length));
      const buckets = timelineBuckets(viewRevisions.length, 100, chartStart);
      slider.min = chartStart;
      chart.style.gridTemplateColumns = 'repeat(' + buckets.length + ', minmax(0, 1fr))';
      const max = Math.max(1, ...viewRevisions.map((revision) => revision.estimatedTokens));
      for (const bucket of buckets) {
        const revision = viewRevisions[bucket.end];
        const button = text('button', '', 'bar');
        button.type = 'button';
        const range = bucket.start === bucket.end ? 'Revision ' + (bucket.end + 1) : 'Revisions ' + (bucket.start + 1) + '–' + (bucket.end + 1);
        button.title = range + ' · ' + revision.date.slice(0, 10) + ' · ' + fmt(revision.estimatedTokens) + ' ' + inlineStat() + ' at end';
        button.setAttribute('aria-label', 'Select ' + range + ', ending ' + revision.date.slice(0, 10));
        const stack = text('span', '', 'stack');
        stack.style.height = Math.max(2, revision.estimatedTokens / max * 210) + 'px';
        for (const category of categories) {
          const amount = revision.categoryTotals[category].estimatedTokens;
          if (!amount) continue;
          const segment = text('span', '', 'segment');
          segment.style.height = amount / revision.estimatedTokens * 100 + '%';
          segment.style.background = colors[category];
          stack.append(segment);
        }
        button.append(stack);
        // Safari does not focus a clicked button, and arrow keys need the focus on a bar.
        button.addEventListener('click', () => {
          render(bucket.end);
          button.focus();
        });
        chart.append(button);
        chartBuckets.push({ ...bucket, button });
      }
      $('timeline-start').textContent = viewRevisions[chartStart].date.slice(0, 10);
      $('timeline-end').textContent = viewRevisions.at(-1).date.slice(0, 10);
      // The masthead's lower edge repeats the chart as stepped layers.
      const tops = buckets.map(() => 0);
      const layers = [];
      for (const category of categories) {
        if (!buckets.some((bucket) => viewRevisions[bucket.end].categoryTotals[category].estimatedTokens)) continue;
        const points = ['0% 100%'];
        buckets.forEach((bucket, index) => {
          tops[index] += viewRevisions[bucket.end].categoryTotals[category].estimatedTokens;
          const y = (100 - tops[index] / max * 100).toFixed(2) + '%';
          points.push((index / buckets.length * 100).toFixed(2) + '% ' + y, ((index + 1) / buckets.length * 100).toFixed(2) + '% ' + y);
        });
        points.push('100% 100%');
        const layer = text('i', '');
        layer.style.clipPath = 'polygon(' + points.join(',') + ')';
        layer.style.background = colors[category];
        // Upper layers come first so each lower one paints over them down to the baseline.
        layers.unshift(layer);
      }
      $('silhouette').replaceChildren(...layers);
    }

    const slider = $('slider');
    slider.max = revisions.length - 1;
    // While the slider is dragged, the file and comparison tables wait until it settles; the rest follows it live.
    slider.addEventListener('input', () => render(Number(slider.value), true));
    slider.addEventListener('change', () => render(Number(slider.value)));
    // The bars are one tab stop; arrow keys, Home, and End move the selection between them.
    $('chart').addEventListener('keydown', (event) => {
      const at = chartBuckets.findIndex((bucket) => bucket.button === event.target);
      const next = { ArrowLeft: at - 1, ArrowRight: at + 1, Home: 0, End: chartBuckets.length - 1 }[event.key];
      if (at < 0 || next === undefined) return;
      event.preventDefault();
      const bucket = chartBuckets[Math.max(0, Math.min(chartBuckets.length - 1, next))];
      render(bucket.end);
      bucket.button.focus();
    });
    $('baseline').append(text('option', 'Previous revision'));
    $('baseline').children[0].value = 'previous';
    for (const [index, revision] of revisions.entries()) {
      const label = (index + 1) + ' · ' + revision.date.slice(0, 10) + ' · ' + revision.id.slice(0, 8);
      for (const id of ['baseline', 'target']) {
        const option = text('option', label);
        option.value = String(index);
        $(id).append(option);
      }
    }
    $('baseline').addEventListener('change', () => { baseline = $('baseline').value === 'previous' ? 'previous' : Number($('baseline').value); renderComparison(); });
    $('target').addEventListener('change', () => render(Number($('target').value)));
    const allComponents = data.components;
    // A provider that only reads shared files, such as Codex with only .agents/skills, still gets a view.
    const providers = [...new Set(allComponents.flatMap((component) => [component.provider, ...(component.readers ?? [])]))].sort();
    const viewTabs = [{ key: 'all', label: 'All files' },
      ...providers.filter((provider) => provider !== 'shared').map((provider) => ({
        key: provider, label: provider === 'unknown' ? 'Unknown' : provider[0].toUpperCase() + provider.slice(1) + ' + shared',
      })),
      ...(providers.includes('shared') ? [{ key: 'shared', label: 'Shared only' }] : [])];
    for (const view of viewTabs) {
      const button = text('button', view.label, 'provider-tab');
      button.type = 'button';
      button.setAttribute('aria-pressed', String(view.key === activeView));
      // A provider view opens on that provider's own counts when the report has them.
      button.addEventListener('click', () => setView(view.key, measures.has(view.key) ? view.key : 'estimate'));
      $('provider-tabs').append(button);
    }
    function setView(view, measure) {
      activeView = view;
      activeMeasure = measure;
      const base = measure === 'estimate' ? { components: data.components, revisions } : measuredRevisions(measure);
      viewRevisions = [];
      for (const [index, revision] of base.revisions.entries()) {
        const projected = viewRevision(revision, activeView, base.revisions[index - 1], base.components);
        // Revisions that changed nothing keep sharing arrays in a provider view too.
        if (projected !== revision && index && revision.components === base.revisions[index - 1].components) {
          projected.components = viewRevisions[index - 1].components;
          projected.skillGroups = viewRevisions[index - 1].skillGroups;
        }
        viewRevisions.push(projected);
      }
      drawn = {};
      showAllSkills = false;
      providerFilter = '';
      categoryFilter = '';
      pathSearch = '';
      $('category-filter').value = '';
      $('path-search').value = '';
      Array.from($('provider-tabs').children).forEach((tab, index) => tab.setAttribute('aria-pressed', String(viewTabs[index].key === activeView)));
      renderProviderOptions();
      renderViewNote();
      renderMeasureSwitch();
      renderMethod();
      renderChart();
      render(selected);
    }
    function renderProviderOptions() {
      const select = $('provider-filter');
      const all = text('option', 'All providers in this view');
      all.value = '';
      select.replaceChildren(all);
      for (const provider of [...new Set(viewRevisions.flatMap((revision) => revision.components.map((component) => component.provider)))].sort()) {
        const option = text('option', provider);
        option.value = provider;
        select.append(option);
      }
      select.value = '';
    }
    function renderViewNote() {
      $('view-note').textContent = activeView === 'all'
        ? ''
        : activeView === 'shared'
          ? 'Files labeled shared because more than one tool reads them by convention, such as AGENTS.md. Each also appears in the view of every provider that reads it. Files Cursor or Copilot reads from another tool, such as .claude/skills or CLAUDE.md, keep the label of the tool that owns them.'
          : activeView === 'unknown'
            ? 'Files not assigned to a supported provider; source-only unless recognized.'
            : activeView[0].toUpperCase() + activeView.slice(1) + ' files plus the shared files it reads' + (activeView === 'gemini' ? '; .gemini/settings.json context.fileName decides whether AGENTS.md and GEMINI.md are included, GEMINI.md alone by default' : activeView === 'cursor' ? '. Cursor also reads AGENTS.md, .agents/skills, and .claude/skills, which it includes only at revisions that track Cursor configuration' : activeView === 'copilot' ? '. Copilot also reads AGENTS.md, CLAUDE.md, REVIEW.md, GEMINI.md, .claude/agents, .claude/rules, .claude/skills, .agents/skills, and .mcp.json, which it includes only at revisions that track Copilot configuration. Which Copilot client (chat, cloud agent, code review, CLI, or an IDE) reads a file is not resolved' : '') + '. Shared files can appear in more than one provider view, so view totals do not add up.';
      $('view-note').hidden = activeView === 'all';
    }
    for (const category of categories) {
      if (!allComponents.some((component) => component.category === category)) continue;
      const option = text('option', category);
      option.value = category;
      $('category-filter').append(option);
    }
    $('provider-filter').addEventListener('change', () => { providerFilter = $('provider-filter').value; renderInventory(); });
    $('category-filter').addEventListener('change', () => { categoryFilter = $('category-filter').value; renderInventory(); });
    $('path-search').addEventListener('input', () => { pathSearch = $('path-search').value.trim().toLocaleLowerCase(); renderInventory(); });
    $('clear-filters').addEventListener('click', () => {
      providerFilter = '';
      categoryFilter = '';
      pathSearch = '';
      $('provider-filter').value = '';
      $('category-filter').value = '';
      $('path-search').value = '';
      renderInventory();
      $('path-search').focus();
    });
    $('skill-toggle').addEventListener('click', () => { showAllSkills = !showAllSkills; renderSkills(); });
    renderProviderOptions();
    renderViewNote();
    renderMeasureSwitch();
    renderChart();

    function renderInventory() {
      const revision = viewRevisions[selected];
      drawn.inventory = revision.components;
      const matching = revision.components.filter((component) =>
        (!providerFilter || component.provider === providerFilter) &&
        (!categoryFilter || component.category === categoryFilter) &&
        (!pathSearch || component.path.toLocaleLowerCase().includes(pathSearch)));
      $('files-total').textContent = fmt(revision.components.length);
      $('inventory-count').hidden = matching.length === revision.components.length;
      $('inventory-count').textContent = 'Showing ' + fmt(matching.length) + ' of ' + fmt(revision.components.length) + ' files. Filters do not change the totals above.';
      const files = $('files');
      files.replaceChildren();
      inventoryRows = new Map();
      if (!matching.length) {
        const row = document.createElement('tr');
        const cell = text('td', 'No files match these filters.', 'empty');
        cell.colSpan = 5 + providerColumns.length;
        row.append(cell);
        files.append(row);
      }
      const sorted = [...matching].sort((a, b) => (b.estimatedTokens ?? -1) - (a.estimatedTokens ?? -1) || a.path.localeCompare(b.path));
      for (const component of capped('files', sorted, 25, renderInventory)) {
        const row = document.createElement('tr');
        row.tabIndex = -1;
        const tokensCell = text('td', component.estimatedTokens === null ? '—' : fmt(component.estimatedTokens), 'num');
        if (component.skill?.listing) tokensCell.title = listingLabel(component).slice(3);
        row.append(text('td', component.path, 'path'), text('td', component.provider, 'kind'), text('td', categoryLabel(component), 'kind'), tokensCell, text('td', fmt(component.bytes), 'num'));
        for (const provider of providerColumns) {
          // A Gemini context file has a Gemini count only for revisions whose settings make Gemini read it.
          const count = providerReads(component, provider, revision.geminiContextFiles) ? component.providerTokenCounts?.[provider] : undefined;
          const cell = text('td', count ? fmt(count.tokens) : '—', 'num');
          if (count) cell.title = [count.accuracy, count.model, count.method, count.version].filter(Boolean).join(' · ');
          row.append(cell);
        }
        files.append(row);
        inventoryRows.set(component.path, row);
      }
    }

    // Opens the file table filtered to one file and moves to its row.
    function locateComponent(component) {
      providerFilter = component.provider;
      categoryFilter = component.category;
      pathSearch = component.path.toLocaleLowerCase();
      $('provider-filter').value = providerFilter;
      $('category-filter').value = categoryFilter;
      $('path-search').value = component.path;
      $('files-panel').open = true;
      renderInventory();
      const row = inventoryRows.get(component.path);
      row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      row?.focus({ preventScroll: true });
    }

    // Gaps and the category header are in pixels, so the layout is redone when the treemap is resized.
    const treemapFrame = { gap: 4, seam: 1, header: 22, wide: 2 };
    // What each rectangle was drawn for, so the next revision can move it rather than redraw it.
    let treemapDrawn = new Map();

    function renderTreemap(animate = true) {
      const root = $('treemap');
      const box = root.getBoundingClientRect();
      const frame = box.width > 0 && box.height > 0 ? { ...treemapFrame, width: box.width, height: box.height } : undefined;
      const layout = layoutTreemap(viewRevisions[selected].components, frame);
      const toPercent = (rect) => ({ x: rect.x / (frame?.width ?? 100) * 100, y: rect.y / (frame?.height ?? 100) * 100, width: rect.width / (frame?.width ?? 100) * 100, height: rect.height / (frame?.height ?? 100) * 100 });
      const place = (node, rect) => {
        node.style.left = rect.x + '%';
        node.style.top = rect.y + '%';
        node.style.width = rect.width + '%';
        node.style.height = rect.height + '%';
      };
      // Where each rectangle is on screen now, partway through a move included, to start the next move from.
      const motion = frame && animate && treemapDrawn.size && !(typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
      const before = new Map();
      if (motion) {
        for (const [key, node] of treemapDrawn) {
          const at = node.getBoundingClientRect();
          before.set(key, { x: (at.left - box.left) / box.width * 100, y: (at.top - box.top) / box.height * 100, width: at.width / box.width * 100, height: at.height / box.height * 100 });
        }
      }
      const drawnNow = new Map();
      const changedHere = new Map(viewRevisions[selected].changes.filter((change) => change.kind !== 'removed').map((change) => [change.path, change]));
      let outlined = 0;
      const treeLegend = $('treemap-legend');
      root.replaceChildren();
      treeLegend.replaceChildren();
      treemapLabels = [];
      if (!layout.totalTokens) root.append(text('p', 'No instructional token estimates at this revision.', 'empty'));
      for (const group of layout.groups) {
        // The category's block shows through as the band holding its name and the seams between its files.
        const block = text('div', '', 'treemap-group');
        block.setAttribute('aria-hidden', 'true');
        place(block, toPercent(group));
        block.style.background = shades[group.category];
        block.style.color = shadeInks[group.category];
        if (group.headed) {
          const name = text('span', group.category, 'group-name');
          name.style.lineHeight = treemapFrame.header + 'px';
          name.append(text('b', fmt(group.estimatedTokens)));
          block.append(name);
        }
        root.append(block);
        drawnNow.set('category:' + group.category, block);
        for (const leaf of group.leaves) {
          const component = viewRevisions[selected].components[leaf.componentIndex];
          const share = toPercent(leaf);
          const button = text('button', '', 'treemap-leaf');
          button.type = 'button';
          place(button, share);
          button.style.background = colors[component.category];
          button.style.color = inks[component.category];
          const change = changedHere.get(component.path);
          const changeLabel = !change ? '' : change.kind === 'added' ? ' · added at this revision' : change.kind === 'renamed' ? ' · renamed at this revision from ' + change.previousPath : ' · edited at this revision';
          const detail = component.path + ' · ' + component.provider + ' / ' + categoryLabel(component) + ' · ' + fmt(leaf.estimatedTokens) + ' stored-text tokens' + listingLabel(component) + changeLabel;
          button.setAttribute('aria-label', detail);
          if (change) {
            button.classList.add('changed');
            if (change.kind !== 'added') button.classList.add('edited');
            outlined += 1;
          }
          // Rectangles too small for even one short line stay unlabeled; fitTreemapLabels decides the rest.
          if (share.width >= 3.5 && share.height >= 5.5) {
            const label = component.skill?.role === 'manifest' ? component.skill.root.split('/').at(-1) : component.path.split('/').at(-1);
            const name = text('span', label, 'leaf-name');
            const size = text('span', fmt(leaf.estimatedTokens) + ' tokens', 'leaf-size');
            button.append(name, size);
            treemapLabels.push({ button, name, size });
            if (share.width >= 28 && share.height >= 22 && share.width * share.height >= 700) button.classList.add('large');
          }
          const showDetail = () => { $('treemap-hover').textContent = detail; $('treemap-hover').classList.add('detail'); };
          const clearDetail = () => { $('treemap-hover').textContent = treemapNote; $('treemap-hover').classList.remove('detail'); };
          button.addEventListener('mouseenter', showDetail);
          button.addEventListener('focus', showDetail);
          button.addEventListener('mouseleave', clearDetail);
          button.addEventListener('blur', clearDetail);
          button.addEventListener('click', () => locateComponent(component));
          root.append(button);
          drawnNow.set('file:' + component.path, button);
        }
      }
      treeLegend.hidden = !outlined;
      if (outlined) {
        for (const [label, className] of [['added at this revision', 'ring'], ['edited or renamed at this revision', 'ring dashed']]) {
          const entry = text('span', label);
          entry.prepend(text('i', '', className));
          treeLegend.append(entry);
        }
      }
      treemapNote = (outlined ? fmt(outlined) + ' outlined files changed at this revision · ' : '') + fmt(layout.groups.reduce((sum, group) => sum + group.leaves.length, 0)) + ' sized · ' + fmt(layout.sourceOnlyCount) + ' source-only' + sourceOnlyCategories() + ' · ' + fmt(layout.zeroTokenCount) + ' zero-token files';
      $('treemap-hover').textContent = treemapNote;
      $('treemap-hover').classList.remove('detail');
      drawn.treemap = viewRevisions[selected].components;
      drawn.outlined = outlined;
      fitTreemapLabels();
      treemapDrawn = drawnNow;
      if (!motion) return;
      // Labels were fitted to where each rectangle ends up; now start each one from where it was and let it move.
      const moving = [];
      for (const [key, node] of drawnNow) {
        const from = before.get(key);
        if (!from) {
          if (node.className === 'treemap-leaf') node.classList.add('entering');
          continue;
        }
        moving.push([node, { left: node.style.left, top: node.style.top, width: node.style.width, height: node.style.height }]);
        node.style.transition = 'none';
        place(node, from);
      }
      root.getBoundingClientRect();
      for (const [node, to] of moving) {
        node.style.transition = '';
        Object.assign(node.style, to);
      }
    }

    function fitTreemapLabels() {
      if (typeof getComputedStyle !== 'function') return;
      for (const { button, name, size } of treemapLabels) {
        button.classList.remove('compact');
        // A tall, narrow rectangle reads its name top to bottom instead of breaking it mid-word.
        const shape = button.getBoundingClientRect();
        if (shape.width < 90 && shape.height > shape.width * 1.8) button.classList.add('upright');
        else button.classList.remove('upright');
        name.hidden = false;
        name.style.fontSize = '';
        size.hidden = false;
        const inner = () => {
          const box = button.getBoundingClientRect();
          const style = getComputedStyle(button);
          return [box.bottom - parseFloat(style.paddingBottom) - parseFloat(style.borderBottomWidth), box.right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth)];
        };
        let [bottom, right] = inner();
        // A name breaks only where it has a hyphen, so a part wider than the rectangle does not fit either.
        const nameFits = () => name.getBoundingClientRect().bottom <= bottom + 1 && name.scrollHeight <= name.clientHeight + 1 && !(name.scrollWidth > name.clientWidth + 1);
        const nameBox = name.getBoundingClientRect();
        const sizeBox = size.getBoundingClientRect();
        if (!nameFits() || sizeBox.top < nameBox.bottom + 5 || sizeBox.bottom > bottom + 1 || sizeBox.right > right + 1) {
          size.hidden = true;
        }
        if (!nameFits()) {
          name.style.fontSize = '11px';
          if (!nameFits()) {
            // Last resort: one small line, cut short with an ellipsis.
            name.style.fontSize = '';
            button.classList.add('compact');
            [bottom, right] = inner();
            const compactBox = name.getBoundingClientRect();
            if (right - compactBox.left < 28 || compactBox.bottom > bottom + 1) name.hidden = true;
          }
        }
      }
    }

    function renderSkills() {
      const groups = viewRevisions[selected].skillGroups;
      drawn.skills = groups;
      const visible = showAllSkills ? groups : groups.slice(0, 8);
      const skillBody = $('skill-groups');
      skillBody.replaceChildren();
      $('skills-panel').hidden = !groups.length;
      const manifestTokens = groups.reduce((sum, group) => sum + (group.manifestPath ? group.manifestEstimatedTokens : 0), 0);
      const listedTokens = groups.reduce((sum, group) => sum + (group.listing?.tokens ?? 0), 0);
      const unresolved = groups.filter((group) => group.listing?.status === 'unresolved').length;
      $('skill-count').textContent = plural(groups.length, 'skill') + ' · summaries ' + fmt(listedTokens) + listingKind() + ' · full text ' + fmt(manifestTokens) + ' tokens' + (unresolved ? ' · ' + fmt(unresolved) + ' unresolved' : '');
      const borrowed = (activeView === 'cursor' || activeView === 'copilot') && groups.some((group) => group.provider !== activeView);
      $('listing-note').textContent = (activeMeasure === 'estimate' ? '' : 'Full text uses ' + providerNames[activeMeasure] + ' counts and summaries the ' + listingKind().slice(2, -1) + ', so do not compare them. ') +
        'Summary: the name and description an agent sees before using a skill. It is part of the full text, so do not add the two. Hidden skills have no summary; unresolved ones could not be read and are not counted.' +
        (borrowed ? ' ' + activeView[0].toUpperCase() + activeView.slice(1) + ' may summarize skills from .claude/skills or .agents/skills differently.' : '');
      const toggle = $('skill-toggle');
      toggle.hidden = groups.length <= 8;
      toggle.textContent = showAllSkills ? 'Show first 8 skill bundles' : 'Show all ' + fmt(groups.length) + ' skill bundles';
      toggle.setAttribute('aria-expanded', String(showAllSkills));
      if (!groups.length) {
        const row = document.createElement('tr');
        const cell = text('td', 'No tracked skill bundles at this revision.', 'empty');
        cell.colSpan = 7;
        row.append(cell);
        skillBody.append(row);
      }
      for (const group of visible) {
        const row = document.createElement('tr');
        row.append(text('td', group.root, 'path'), text('td', group.provider), text('td', group.manifestPath ? 'SKILL.md' : 'Missing', 'kind'), text('td', group.manifestPath ? fmt(group.manifestEstimatedTokens) : '—', 'num'), listingCell(group.listing), text('td', fmt(group.resourceCount), 'num'), text('td', fmt(group.resourceBytes), 'num'));
        skillBody.append(row);
      }
    }

    // The map draws the view's files; its import lines come from the whole inventory, like the imports table.
    const mapRowHeight = 30;
    // Folders the reader opened or closed, by path; they stay that way across revisions and views.
    const mapToggled = new Map();
    let mapFallback = 'auto';
    // The row that takes the Tab stop, by path, so it survives redrawing.
    let mapCurrent = '';
    let mapDrawn = { map: { rows: [] }, components: [], nodes: [], details: [], lines: [] };
    let mapNote = '';
    // What the last hover or focus lit, so the next one clears only that.
    let mapLit = [];
    // The row under the pointer, so losing focus goes back to it.
    let mapHovered = -1;
    let mapTabStop = null;
    // The imports table and the map both need a revision's links; they are found once per inventory.
    let linksCache = { components: null, links: [] };
    function revisionLinks(components) {
      if (linksCache.components !== components) linksCache = { components, links: importLinks(components) };
      return linksCache.links;
    }
    $('map-expand').addEventListener('click', () => { mapToggled.clear(); mapFallback = 'expanded'; renderMap(); });
    $('map-collapse').addEventListener('click', () => { mapToggled.clear(); mapFallback = 'collapsed'; renderMap(); });

    function renderMap(focus) {
      const revision = viewRevisions[selected];
      const links = revisionLinks(revisions[selected].components);
      drawn.map = revision.components;
      drawn.mapImports = revisions[selected].components;
      drawn.mapChanges = revision.changes;
      const map = configMap(revision.components, links, { toggled: mapToggled, fallback: mapFallback });
      const changedHere = new Map(revision.changes.filter((change) => change.kind !== 'removed').map((change) => [change.path, change]));
      // A closed folder counts the changed files it hides.
      const changedUnder = map.rows.map(() => 0);
      revision.components.forEach((component, index) => {
        if (changedHere.has(component.path) && map.rows[map.rowOf[index]].kind === 'folder') changedUnder[map.rowOf[index]] += 1;
      });
      const root = $('config-map');
      root.replaceChildren();
      root.classList.remove('tracing');
      mapLit = [];
      mapHovered = -1;
      mapTabStop = null;
      if (!map.rows.some((row) => row.path === mapCurrent)) mapCurrent = map.rows[0]?.path ?? '';
      // Imports are read from the whole inventory, so a file can import, or be imported by, one this view leaves out.
      const inView = new Set(revision.components.map((component) => component.path));
      const names = (paths) => {
        const named = paths.map((path) => inView.has(path) ? path : path + ' (outside this view)');
        return named.length > 3 ? named.slice(0, 3).join(', ') + ' and ' + fmt(named.length - 3) + ' more' : named.join(', ');
      };
      const nodes = [];
      const details = [];
      for (const [index, row] of map.rows.entries()) {
        const folder = row.kind === 'folder';
        const component = folder ? null : revision.components[row.component];
        const change = folder ? null : changedHere.get(row.path);
        const parts = [folder ? row.path + '/' : row.path];
        if (folder) {
          parts.push(plural(row.files, 'file') + (row.sourceOnly ? ' (' + fmt(row.sourceOnly) + ' source-only)' : ''), fmt(row.tokens) + ' stored-text tokens', row.collapsed ? 'closed' : 'open');
          if (changedUnder[index]) parts.push(fmt(changedUnder[index]) + ' changed at this revision');
        } else {
          parts.push(component.provider + ' / ' + categoryLabel(component), (component.estimatedTokens === null ? 'source-only, ' + fmt(component.bytes) + ' bytes' : fmt(component.estimatedTokens) + ' stored-text tokens') + listingLabel(component));
          if (map.targets.has(row.path)) parts.push('imports ' + names(map.targets.get(row.path)));
          if (map.sources.has(row.path)) parts.push('imported by ' + names(map.sources.get(row.path)));
          if (change) parts.push(change.kind === 'added' ? 'added at this revision' : change.kind === 'renamed' ? 'renamed at this revision from ' + change.previousPath : 'edited at this revision');
        }
        if (row.unresolved) parts.push(plural(row.unresolved, 'unresolved import'));
        const detail = parts.join(' · ');
        const node = text('div', '', 'map-row ' + row.kind);
        node.setAttribute('role', 'treeitem');
        node.setAttribute('aria-level', String(row.depth + 1));
        node.setAttribute('aria-setsize', String(row.siblings));
        node.setAttribute('aria-posinset', String(row.position));
        node.setAttribute('aria-label', detail);
        if (folder) node.setAttribute('aria-expanded', String(!row.collapsed));
        node.tabIndex = row.path === mapCurrent ? 0 : -1;
        if (node.tabIndex === 0) mapTabStop = node;
        const name = text('span', '', 'map-name');
        // Indenting the name, not the row, keeps every bar on the same scale and starting point.
        name.style.paddingLeft = 8 + row.depth * 18 + 'px';
        name.append(text('span', folder ? (row.collapsed ? '▸' : '▾') : '', 'map-caret'), text('span', row.label + (folder ? '/' : ''), 'map-label'));
        if (folder && row.collapsed) name.append(text('span', plural(row.files, 'file'), 'map-tag'));
        const changed = change ? (change.kind === 'added' ? 'new' : change.kind === 'renamed' ? 'renamed' : 'edited') : changedUnder[index] ? fmt(changedUnder[index]) + ' changed' : '';
        if (changed) name.append(text('span', changed, 'map-tag'));
        if (row.unresolved) name.append(text('span', fmt(row.unresolved) + ' unresolved', 'map-tag warn'));
        const bar = text('span', '', 'map-bar');
        // A source-only file, or a folder of nothing else, has no stored text to draw.
        if (row.tokens === null || row.sourceOnly === row.files) {
          bar.classList.add('source-only');
          const mark = text('i', '');
          mark.style.borderColor = colors[row.categories[0].category];
          bar.append(mark);
        } else {
          for (const part of row.categories) {
            if (!part.tokens || !map.totalTokens) continue;
            const segment = text('i', '');
            segment.style.width = part.tokens / map.totalTokens * 100 + '%';
            segment.style.background = colors[part.category];
            bar.append(segment);
          }
        }
        const sized = row.tokens !== null && row.sourceOnly < row.files;
        node.append(name, bar, text('span', sized ? fmt(row.tokens) : '—', 'map-size'));
        node.addEventListener('mouseenter', () => {
          mapHovered = index;
          traceMap(index);
        });
        node.addEventListener('focus', () => {
          mapCurrent = row.path;
          if (mapTabStop && mapTabStop !== node) mapTabStop.tabIndex = -1;
          node.tabIndex = 0;
          mapTabStop = node;
          traceMap(index);
        });
        // Leaving a row with the mouse goes back to the focused row, and losing focus to the hovered one.
        node.addEventListener('mouseleave', () => {
          mapHovered = -1;
          traceMap(nodes.indexOf(document.activeElement));
        });
        node.addEventListener('blur', () => traceMap(mapHovered));
        node.addEventListener('click', () => activateMapRow(index));
        nodes.push(node);
        details.push(detail);
        root.append(node);
      }
      // Each import is a half ellipse in the gutter, from the importing row down or up to the imported one.
      const gutter = text('div', '', 'map-gutter');
      gutter.setAttribute('aria-hidden', 'true');
      gutter.style.height = map.rows.length * mapRowHeight + 'px';
      const lines = map.rows.map(() => []);
      for (const edge of map.edges) {
        const span = Math.abs(edge.to - edge.from);
        const arc = text('i', '', 'map-arc');
        if (map.rows[edge.from].kind === 'folder' || map.rows[edge.to].kind === 'folder') arc.classList.add('dashed');
        arc.style.top = (Math.min(edge.from, edge.to) + 0.5) * mapRowHeight + 'px';
        arc.style.height = span * mapRowHeight + 'px';
        // Width grows with the span, scaled to the map's height so long lines never share one width.
        arc.style.width = 'max(10px, calc((var(--gutter) - 12px) * ' + (span / Math.max(16, map.rows.length - 1)).toFixed(4) + '))';
        const arrow = text('i', '', 'map-arrow');
        arrow.style.top = (edge.to + 0.5) * mapRowHeight - 4 + 'px';
        gutter.append(arc, arrow);
        for (const end of [edge.from, edge.to]) lines[end].push({ arc, arrow, other: end === edge.from ? edge.to : edge.from });
      }
      if (map.edges.length) root.append(gutter);
      mapDrawn = { map, components: revision.components, nodes, details, lines };
      const counts = [plural(map.folders, 'folder'), plural(revision.components.length, 'file')];
      if (map.edges.length || links.length) counts.push(plural(map.edges.length, 'import line'));
      if (map.folded) counts.push(fmt(map.folded) + ' inside closed folders');
      if (map.unresolved) counts.push(fmt(map.unresolved) + ' unresolved, listed under Claude imports');
      if (map.offMap) counts.push(fmt(map.offMap) + ' with a file outside this view');
      // Imports are Claude's; another agent's tab can still show one between two files it reads.
      const borrowed = map.edges.length && activeView !== 'all' && activeView !== 'claude' ? ' Lines are Claude imports; they do not show that ' + (agentNames[activeView] ?? 'another agent') + ' follows them.' : '';
      // An empty tree holds nothing, so the note under it says why.
      mapNote = !map.rows.length ? 'No tracked files at this revision.' : (data.privacy.mode === 'shareable' ? 'Paths are aliases in this export, so files are not grouped into folders. ' : '') + counts.join(' · ') + '. Bars share ' + fmt(map.totalTokens) + ' ' + inlineStat() + '.' + borrowed;
      $('map-hover').textContent = mapNote;
      $('map-hover').classList.remove('detail');
      if (focus) nodes[map.rows.findIndex((row) => row.path === mapCurrent)]?.focus();
    }

    // Hovering or focusing a row lights its import lines and the rows at their other ends; -1 clears it.
    function traceMap(index) {
      const { nodes, details, lines } = mapDrawn;
      const root = $('config-map');
      for (const [node, name] of mapLit) node.classList.remove(name);
      mapLit = [];
      if (index < 0) {
        root.classList.remove('tracing');
        $('map-hover').textContent = mapNote;
        $('map-hover').classList.remove('detail');
        return;
      }
      if (lines[index].length) root.classList.add('tracing');
      else root.classList.remove('tracing');
      for (const { arc, arrow, other } of lines[index]) {
        arc.classList.add('lit');
        arrow.classList.add('lit');
        nodes[other].classList.add('linked');
        mapLit.push([arc, 'lit'], [arrow, 'lit'], [nodes[other], 'linked']);
      }
      $('map-hover').textContent = details[index];
      $('map-hover').classList.add('detail');
    }

    // A folder opens or closes; a file is located in the file table, as from the treemap.
    function activateMapRow(index) {
      const row = mapDrawn.map.rows[index];
      if (row.kind === 'folder') {
        mapCurrent = row.path;
        // Opening opens every folder the row stands for; closing closes only the deepest, which holds what the
        // row shows, so an outer folder stays open at revisions where it holds more.
        if (row.collapsed) for (const path of row.chain) mapToggled.set(path, false);
        else mapToggled.set(row.path, true);
        renderMap(true);
      } else {
        // While the slider is dragged the map can show an earlier revision; it catches up first, and the file is
        // located only if the selected revision has it.
        clearTimeout(settleTimer);
        renderTables();
        const component = viewRevisions[selected].components.find((candidate) => candidate.path === row.path);
        if (component) locateComponent(component);
        else mapDrawn.nodes[mapDrawn.map.rows.findIndex((shown) => shown.path === mapCurrent)]?.focus();
      }
    }

    // The map is one Tab stop; arrow keys move between rows and open or close folders, as in a file tree.
    $('config-map').addEventListener('keydown', (event) => {
      const { map, nodes } = mapDrawn;
      const at = nodes.indexOf(event.target);
      // Modified keys stay the browser's, such as Alt+Left for Back.
      if (at < 0 || event.altKey || event.ctrlKey || event.metaKey) return;
      const row = map.rows[at];
      const folder = row.kind === 'folder';
      let next;
      if (event.key === 'ArrowDown') next = at + 1;
      else if (event.key === 'ArrowUp') next = at - 1;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = nodes.length - 1;
      else if (event.key === 'ArrowRight') {
        if (folder && row.collapsed) { event.preventDefault(); activateMapRow(at); return; }
        next = folder ? at + 1 : undefined;
      } else if (event.key === 'ArrowLeft') {
        if (folder && !row.collapsed) { event.preventDefault(); activateMapRow(at); return; }
        next = row.parent >= 0 ? row.parent : undefined;
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activateMapRow(at);
        return;
      }
      if (next === undefined) return;
      event.preventDefault();
      nodes[Math.max(0, Math.min(nodes.length - 1, next))].focus();
    });

    // Imports are links between stored files, so they follow the whole inventory whatever the view.
    const importStatus = { resolved: 'resolved', missing: 'missing', external: 'outside the repository', 'depth-limit': 'too deep' };
    const unresolvedFirst = { missing: 0, external: 1, 'depth-limit': 2, resolved: 3 };
    function renderImports() {
      const components = revisions[selected].components;
      drawn.imports = components;
      const links = revisionLinks(components);
      $('imports-panel').hidden = !links.length;
      const unresolved = links.filter((link) => link.status !== 'resolved').length;
      $('imports-count').textContent = fmt(links.length) + (unresolved ? ' · ' + fmt(unresolved) + ' unresolved' : '');
      const body = $('imports');
      body.replaceChildren();
      const sorted = [...links].sort((a, b) => unresolvedFirst[a.status] - unresolvedFirst[b.status] || a.source.localeCompare(b.source) || a.line - b.line);
      for (const link of capped('imports', sorted, 25, renderImports)) {
        const row = document.createElement('tr');
        row.append(text('td', link.source, 'path'), text('td', fmt(link.line), 'num'), text('td', link.target ?? (link.status === 'external' ? '—' : 'not a tracked path'), 'path'), text('td', fmt(link.hop), 'num'), text('td', importStatus[link.status], 'kind'));
        body.append(row);
      }
    }

    // MCP servers follow the provider view, like the files that define them.
    function renderMcp() {
      const components = viewRevisions[selected].components.filter((component) => component.mcp);
      drawn.mcp = viewRevisions[selected].components;
      $('mcp-panel').hidden = !components.length;
      const rows = components.flatMap((component) => component.mcp.status === 'listed'
        ? component.mcp.servers.map((server) => ({ component, server }))
        : [{ component, server: null }]);
      const servers = rows.filter((row) => row.server).length;
      const unresolved = rows.length - servers;
      $('mcp-count').textContent = plural(servers, 'server') + ' · ' + plural(components.length, 'file') + (unresolved ? ' · ' + fmt(unresolved) + ' unresolved' : '');
      const body = $('mcp-servers');
      body.replaceChildren();
      if (!rows.length) {
        const row = document.createElement('tr');
        const cell = text('td', 'The tracked MCP files define no servers at this revision.', 'empty');
        cell.colSpan = 4;
        row.append(cell);
        body.append(row);
      }
      // Unreadable files come first, so a parse failure is not mistaken for no servers.
      const sorted = [...rows].sort((a, b) => Number(Boolean(a.server)) - Number(Boolean(b.server)) || a.component.path.localeCompare(b.component.path));
      for (const { component, server } of capped('mcp-servers', sorted, 25, renderMcp)) {
        const row = document.createElement('tr');
        const runs = !server ? 'unresolved' : server.transport + (server.disabled ? ' (disabled)' : '');
        const name = text('td', server ? server.name : 'Could not read this file', server ? 'path' : 'kind');
        row.append(name, text('td', runs, 'kind'), text('td', component.path, 'path'), text('td', component.provider));
        body.append(row);
      }
    }

    // Listings always use the report's own measurement, never a provider's counts, so measured views say which.
    function listingKind() {
      if (activeMeasure === 'estimate') return '';
      return ' (' + (data.measurement.accuracy === 'estimate' ? 'byte estimate' : data.measurement.encoding + ' encoding') + ')';
    }
    // A superseded format, such as .cursorrules, keeps its category but says it is legacy.
    // The categories of the selected revision's source-only files, as a clause after their count.
    function sourceOnlyCategories() {
      const found = [...new Set(viewRevisions[selected].components.filter((component) => component.estimatedTokens === null).map((component) => component.category))];
      return found.length ? ' (' + found.join(', ') + ')' : '';
    }
    function categoryLabel(component) {
      return component.category + (component.legacy ? ' (legacy)' : '') + (component.imported ? ' (imported)' : '');
    }
    // How a skill manifest is listed before use, as a clause after its stored-text tokens.
    function listingLabel(component) {
      const listing = component.skill?.listing;
      if (!listing) return '';
      if (listing.status === 'listed') return ' · ' + fmt(listing.tokens) + ' in its summary' + listingKind();
      return listing.status === 'hidden' ? ' · no summary (hidden)' : ' · summary unresolved';
    }
    function listingCell(listing) {
      if (!listing) return text('td', '—', 'num');
      if (listing.status === 'listed') return text('td', fmt(listing.tokens), 'num');
      const cell = text('td', listing.status, 'num kind');
      cell.title = listing.status === 'hidden' ? 'Hidden until invoked (disable-model-invocation)' : 'Strata could not read the name and description';
      return cell;
    }

    // Both sides listed: the token change; otherwise each side's state, such as a manifest added or hidden.
    function listingDeltaCell(listing) {
      if (!listing) return text('td', '—', 'num');
      const side = (entry) => !entry ? 'none' : entry.status === 'listed' ? fmt(entry.tokens) : entry.status;
      if (listing.before?.status === 'listed' && listing.after?.status === 'listed') return text('td', signed(listing.deltaTokens), 'num ' + tone(listing.deltaTokens));
      return text('td', side(listing.before) + ' → ' + side(listing.after), 'num');
    }

    // Up-front text follows the whole inventory under the report's own measurement, whatever the view counts with.
    function renderUpFront() {
      const revision = revisions[selected];
      drawn.upFront = revision.components;
      const single = Object.hasOwn(agentNames, activeView);
      const entries = (single ? [activeView] : Object.keys(agentNames))
        .map((provider) => upFrontContext(revision.components, provider, revision.geminiContextFiles))
        .filter((entry) => entry.tokens || entry.onDemandTokens || entry.files.length || entry.skipped || entry.listingUnresolved || entry.unresolved);
      $('upfront-panel').hidden = !entries.length;
      $('upfront-count').textContent = entries.map((entry) => agentNames[entry.provider] + ' ' + fmt(entry.tokens)).join(' · ');
      const body = $('upfront-rows');
      body.replaceChildren();
      for (const entry of entries) {
        const row = document.createElement('tr');
        row.append(text('td', agentNames[entry.provider]), text('td', fmt(entry.files.length), 'num'), text('td', fmt(entry.fileTokens), 'num'), text('td', fmt(entry.listingTokens), 'num'), text('td', fmt(entry.tokens), 'num'), text('td', fmt(entry.onDemandTokens), 'num'));
        body.append(row);
      }
      const notes = [];
      const unsure = entries.filter((entry) => entry.unresolved);
      if (unsure.length) notes.push('Maybe read at start, counted as when needed: ' + unsure.map((entry) => agentNames[entry.provider] + ' ' + plural(entry.unresolved, 'file')).join(', ') + '.');
      for (const entry of entries.filter((item) => item.skipped)) notes.push(agentNames[entry.provider] + ' skips AGENTS.md because ' + (entry.provider === 'claude' ? 'CLAUDE.md' : 'AGENTS.override.md') + ' exists (' + fmt(entry.skippedTokens) + ' tokens, left out).');
      const unreadable = entries.filter((entry) => entry.listingUnresolved);
      if (unreadable.length) notes.push('Skills with unreadable descriptions, not counted: ' + unreadable.map((entry) => agentNames[entry.provider] + ' ' + fmt(entry.listingUnresolved)).join(', ') + '.');
      if (activeMeasure !== 'estimate') notes.push('Uses the report\u2019s ' + listingKind().slice(2, -1) + ', not ' + providerNames[activeMeasure] + ' counts.');
      notes.push('Personal and global settings outside the repository are not included.');
      $('upfront-note').textContent = notes.join('\\n');
      const files = single && entries.length ? entries[0].files : [];
      $('upfront-files-wrap').hidden = !files.length;
      const fileBody = $('upfront-files');
      fileBody.replaceChildren();
      for (const component of files) {
        const row = document.createElement('tr');
        row.append(text('td', component.path, 'path'), text('td', categoryLabel(component)), text('td', component.estimatedTokens === null ? 'source only' : fmt(component.estimatedTokens), 'num'));
        fileBody.append(row);
      }
    }

    function renderComparison() {
      const comparison = compareRevisions(baselineRevision(), viewRevisions[selected]);
      drawn.baseline = baselineRevision().components;
      drawn.target = viewRevisions[selected].components;
      $('baseline').value = String(baseline);
      chartBuckets.forEach((bucket) => bucket.button.classList.toggle('baseline', baseline !== 'previous' && bucket.start <= baseline && baseline <= bucket.end));
      $('compare-tokens').textContent = signed(comparison.deltaTokens) + ' (' + fmt(comparison.beforeTokens) + ' → ' + fmt(comparison.afterTokens) + ')';
      $('compare-tokens').className = tone(comparison.deltaTokens);
      $('compare-files').textContent = signed(comparison.deltaFiles) + ' (' + fmt(comparison.beforeFiles) + ' → ' + fmt(comparison.afterFiles) + ')';
      $('compare-files').className = tone(comparison.deltaFiles);
      const skills = comparison.skillListing;
      $('compare-listing-wrap').hidden = !skills.beforeManifests && !skills.afterManifests;
      $('compare-listing-label').textContent = 'Skill summary tokens' + listingKind();
      $('compare-listing').textContent = signed(skills.deltaTokens) + ' (' + fmt(skills.beforeTokens) + ' → ' + fmt(skills.afterTokens) + ')' +
        (skills.beforeUnresolved || skills.afterUnresolved ? ' · unresolved ' + fmt(skills.beforeUnresolved) + ' → ' + fmt(skills.afterUnresolved) : '');
      $('compare-listing').className = tone(skills.deltaTokens);
      const mcp = comparison.mcp;
      $('compare-mcp-wrap').hidden = !mcp;
      if (mcp) {
        $('compare-mcp').textContent = signed(mcp.deltaServers) + ' (' + fmt(mcp.beforeServers) + ' → ' + fmt(mcp.afterServers) + ')' +
          (mcp.beforeUnresolved || mcp.afterUnresolved ? ' · unresolved ' + fmt(mcp.beforeUnresolved) + ' → ' + fmt(mcp.afterUnresolved) : '');
        $('compare-mcp').className = tone(mcp.deltaServers);
        const names = (refs) => refs.slice(0, 10).map((ref) => ref.name + ' (' + ref.path + ')').join(', ') + (refs.length > 10 ? ', and ' + fmt(refs.length - 10) + ' more' : '');
        $('compare-mcp-names').textContent = [mcp.added.length ? 'MCP servers added: ' + names(mcp.added) + '.' : '', mcp.removed.length ? 'MCP servers removed: ' + names(mcp.removed) + '.' : ''].filter(Boolean).join(' ');
      }
      $('compare-mcp-names').hidden = !mcp || (!mcp.added.length && !mcp.removed.length);
      for (const [id, groups] of [['compare-providers', comparison.byProvider], ['compare-categories', comparison.byCategory]]) {
        const body = $(id);
        body.replaceChildren();
        const moved = groups.filter((group) => group.deltaFiles || group.deltaTokens);
        if (!moved.length) {
          const row = document.createElement('tr');
          const cell = text('td', 'No change.', 'empty');
          cell.colSpan = 3;
          row.append(cell);
          body.append(row);
        }
        for (const group of moved) {
          const row = document.createElement('tr');
          row.append(text('td', group.key), text('td', signed(group.deltaFiles), 'num ' + tone(group.deltaFiles)), text('td', signed(group.deltaTokens), 'num ' + tone(group.deltaTokens)));
          body.append(row);
        }
      }
      const body = $('compare-components');
      body.replaceChildren();
      if (!comparison.components.length) {
        const row = document.createElement('tr');
        const cell = text('td', 'No component changes between these revisions.', 'empty');
        cell.colSpan = 6;
        row.append(cell);
        body.append(row);
      }
      for (const component of capped('compare-components', comparison.components, 25, renderComparison)) {
        const row = document.createElement('tr');
        row.append(text('td', component.path, 'path'), text('td', component.provider), text('td', categoryLabel(component)), text('td', component.kind), text('td', component.beforeTokens === null && component.afterTokens === null ? 'source only' : signed(component.deltaTokens), 'num ' + tone(component.deltaTokens)), listingDeltaCell(component.listing));
        body.append(row);
      }
    }

    function render(index, dragging) {
      selected = index;
      const revision = viewRevisions[index];
      const previous = viewRevisions[index - 1];
      const delta = revision.estimatedTokens - (previous?.estimatedTokens ?? 0);
      slider.value = index;
      renderLegend();
      $('target').value = String(index);
      for (const bucket of chartBuckets) {
        const isSelected = bucket.start <= index && index <= bucket.end;
        bucket.button.classList.toggle('selected', isSelected);
        bucket.button.tabIndex = isSelected ? 0 : -1;
        bucket.button.setAttribute('aria-current', String(isSelected));
      }
      // A revision before the chart's first bar still leaves the chart reachable by Tab.
      if (chartBuckets.length && !chartBuckets.some((bucket) => bucket.button.tabIndex === 0)) chartBuckets[0].button.tabIndex = 0;
      $('date').textContent = revision.date.slice(0, 10);
      $('tokens').textContent = fmt(revision.estimatedTokens);
      $('components').textContent = fmt(revision.components.length);
      $('delta').textContent = (delta > 0 ? '+' : '') + fmt(delta);
      $('delta').className = delta > 0 ? 'positive' : delta < 0 ? 'negative' : '';
      $('revision').textContent = (index + 1) + ' / ' + revisions.length + ' · ' + revision.id.slice(0, 10);

      if (drawn.skills !== revision.skillGroups) renderSkills();
      if (drawn.upFront !== revisions[index].components) renderUpFront();

      if (drawn.treemap !== revision.components || drawn.outlined || revision.changes.length) renderTreemap();
      clearTimeout(settleTimer);
      if (dragging) settleTimer = setTimeout(renderTables, 120);
      else renderTables();
    }

    function renderTables() {
      const revision = viewRevisions[selected];
      if (drawn.inventory !== revision.components) renderInventory();
      if (drawn.imports !== revisions[selected].components) renderImports();
      // Changes only matter to the map when the drawn or the selected revision tags a file.
      const mapTags = drawn.mapChanges !== revision.changes && (drawn.mapTagged || revision.changes.some((change) => change.kind !== 'removed'));
      if (drawn.map !== revision.components || drawn.mapImports !== revisions[selected].components || mapTags) renderMap();
      if (drawn.mcp !== revision.components) renderMcp();
      if (drawn.target !== revision.components || drawn.baseline !== baselineRevision().components) renderComparison();
    }
    if (typeof ResizeObserver !== 'undefined') {
      let treemapWidth = 0;
      new ResizeObserver(([entry]) => {
        if (Math.abs(entry.contentRect.width - treemapWidth) < 1) return;
        treemapWidth = entry.contentRect.width;
        renderTreemap(false);
      }).observe($('treemap'));
    }
    render(selected);
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character] ?? character,
  );
}
