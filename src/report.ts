import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { categories } from "./adapters.js";
import { brandColors, brandUrl, displayFontFace, displayFontStack, markSvg } from "./brand.js";
import { compareRevisions } from "./compare.js";
import { expandRevisions } from "./expand.js";
import type { Report } from "./model.js";
import { categoryColors, categoryInk } from "./palette.js";
import { textRecipients } from "./provider-count.js";
import { providerReads, viewRevision } from "./provider-view.js";
import { timelineBuckets } from "./timeline.js";
import { layoutTreemap } from "./treemap.js";

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
    .chart-scroll { padding: 4px 2px 6px; }
    .chart { display: grid; align-items: end; gap: 2px; height: 220px; width: 100%; border-bottom: 1px solid var(--edge); background: repeating-linear-gradient(to top, transparent 0, transparent 54px, var(--grid) 55px); }
    .bar { border: 0; padding: 0; margin: 0; min-width: 0; background: transparent; display: flex; align-items: end; justify-content: center; height: 100%; cursor: pointer; }
    .bar:focus-visible { outline: 2px solid var(--clay); outline-offset: 2px; }
    .bar.selected .stack { outline: 2px solid var(--ink); outline-offset: 2px; }
    .bar.baseline .stack { box-shadow: 0 0 0 2px var(--ochre); }
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
    .treemap { position: relative; height: 390px; background: var(--hover); overflow: hidden; }
    .treemap-leaf { position: absolute; display: flex; flex-direction: column; align-items: start; justify-content: space-between; gap: 5px; border: 2px solid var(--sheet); padding: 9px; overflow: hidden; text-align: left; cursor: pointer; font: inherit; }
    .treemap-leaf:hover, .treemap-leaf:focus-visible { outline: 3px solid var(--ink); outline-offset: -4px; z-index: 2; }
    .treemap-leaf .leaf-name { display: block; flex-shrink: 0; max-width: 100%; overflow-wrap: anywhere; font-size: 13px; line-height: 1.2; font-weight: 700; }
    .treemap-leaf .leaf-size { flex-shrink: 0; margin-top: auto; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
    .treemap-leaf [hidden] { display: none; }
    .treemap-leaf.upright .leaf-name { writing-mode: vertical-rl; max-width: none; max-height: 100%; overflow: hidden; overflow-wrap: normal; white-space: nowrap; text-overflow: ellipsis; }
    .treemap-leaf.compact { padding: 3px 5px; }
    .treemap-leaf.compact .leaf-name { overflow: hidden; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
    .treemap-leaf.changed::after { content: ""; position: absolute; inset: 2px; border: 2px solid currentColor; pointer-events: none; }
    .treemap-leaf.changed.edited::after { border-style: dashed; }
    .ring { display: inline-block; width: 12px; height: 12px; border: 2px solid var(--ink); }
    .ring.dashed { border-style: dashed; }
    .treemap-group { position: absolute; border: 3px solid var(--sheet); pointer-events: none; z-index: 1; }
    .treemap-hover { min-height: 2.9em; margin: 12px 0 0; color: var(--muted); font-size: 12px; line-height: 1.45; overflow-wrap: anywhere; }
    .treemap-hover.detail { color: var(--ink); }
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
    @media (max-width: 520px) { .masthead { padding: 0 18px; } main { padding: 20px 18px 50px; } .stat strong { font-size: 24px; } .silhouette { height: 76px; } .panel { padding: 18px; } .panel h2 { font-size: 21px; } .treemap { height: 320px; } .treemap-leaf { padding: 6px; } }
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
    <details class="panel" id="skills-panel">
      <summary><h2>Skill bundles</h2><span class="summary-count" id="skill-count"></span></summary>
      <div class="table-wrap"><table><thead><tr><th>Skill directory</th><th>Provider</th><th>Manifest</th><th class="num">Manifest tokens</th><th class="num">Listed tokens</th><th class="num">Resources</th><th class="num">Resource bytes</th></tr></thead><tbody id="skill-groups"></tbody></table></div>
      <p class="muted" id="listing-note"></p>
      <button class="skill-toggle" id="skill-toggle" type="button" aria-expanded="false" hidden></button>
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
        <span id="compare-listing-wrap" hidden><span id="compare-listing-label">Listed skill tokens</span><strong id="compare-listing"></strong></span>
      </div>
      <div class="grid">
        <div class="compare-section"><h3>By provider</h3><div class="table-wrap"><table><thead><tr><th>Provider</th><th class="num">Δ files</th><th class="num">Δ tokens</th></tr></thead><tbody id="compare-providers"></tbody></table></div></div>
        <div class="compare-section"><h3>By category</h3><div class="table-wrap"><table><thead><tr><th>Category</th><th class="num">Δ files</th><th class="num">Δ tokens</th></tr></thead><tbody id="compare-categories"></tbody></table></div></div>
      </div>
      <div class="compare-section"><h3>Changed components</h3><div class="table-wrap"><table><thead><tr><th>Path</th><th>Provider</th><th>Category</th><th>Change</th><th class="num">Δ tokens</th><th class="num">Δ listed</th></tr></thead><tbody id="compare-components"></tbody></table></div><button class="more" id="compare-components-more" type="button" hidden></button></div>
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
    const hierarchy = d3.hierarchy;
    const treemap = d3.treemap;
    const layoutTreemap = ${treemapSource};
    const providerColumns = (data.providerMeasurements ?? []).map((measured) => measured.provider);
    const colors = ${JSON.stringify(categoryColors)};
    const inks = ${JSON.stringify(categoryInk)};
    const $ = (id) => document.getElementById(id);
    const numberFormat = new Intl.NumberFormat();
    const fmt = (n) => numberFormat.format(n);
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
        const label = text('span', category);
        // Source-only categories have no tokens to show, so they give their file count.
        label.append(text('b', total.count && total.count === total.sourceOnlyCount ? fmt(total.count) + (total.count === 1 ? ' file' : ' files') : fmt(total.estimatedTokens)));
        const swatch = text('i', '', 'swatch');
        swatch.style.background = colors[category];
        label.prepend(swatch);
        legend.append(label);
      }
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
        button.title = range + ' · ' + revision.date.slice(0, 10) + ' · ' + fmt(revision.estimatedTokens) + ' ' + measureLabel().stat.toLowerCase() + ' at end';
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
        button.addEventListener('click', () => render(bucket.end));
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

    function renderTreemap() {
      const layout = layoutTreemap(viewRevisions[selected].components);
      const changedHere = new Map(viewRevisions[selected].changes.filter((change) => change.kind !== 'removed').map((change) => [change.path, change]));
      let outlined = 0;
      const root = $('treemap');
      const treeLegend = $('treemap-legend');
      root.replaceChildren();
      treeLegend.replaceChildren();
      treemapLabels = [];
      if (!layout.totalTokens) root.append(text('p', 'No instructional token estimates at this revision.', 'empty'));
      for (const group of layout.groups) {
        for (const leaf of group.leaves) {
          const component = viewRevisions[selected].components[leaf.componentIndex];
          const button = text('button', '', 'treemap-leaf');
          button.type = 'button';
          button.style.left = leaf.x + '%';
          button.style.top = leaf.y + '%';
          button.style.width = leaf.width + '%';
          button.style.height = leaf.height + '%';
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
          if (leaf.width >= 3.5 && leaf.height >= 5.5) {
            const label = component.skill?.role === 'manifest' ? component.skill.root.split('/').at(-1) : component.path.split('/').at(-1);
            const name = text('span', label, 'leaf-name');
            const size = text('span', fmt(leaf.estimatedTokens) + ' tokens', 'leaf-size');
            button.append(name, size);
            treemapLabels.push({ button, name, size });
            if (leaf.width >= 28 && leaf.height >= 22 && leaf.width * leaf.height >= 700) button.classList.add('large');
          }
          const showDetail = () => { $('treemap-hover').textContent = detail; $('treemap-hover').classList.add('detail'); };
          const clearDetail = () => { $('treemap-hover').textContent = treemapNote; $('treemap-hover').classList.remove('detail'); };
          button.addEventListener('mouseenter', showDetail);
          button.addEventListener('focus', showDetail);
          button.addEventListener('mouseleave', clearDetail);
          button.addEventListener('blur', clearDetail);
          button.addEventListener('click', () => {
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
          });
          root.append(button);
        }
        const outline = text('div', '', 'treemap-group');
        outline.style.left = group.x + '%';
        outline.style.top = group.y + '%';
        outline.style.width = group.width + '%';
        outline.style.height = group.height + '%';
        root.append(outline);
      }
      treeLegend.hidden = !outlined;
      if (outlined) {
        for (const [label, className] of [['added at this revision', 'ring'], ['edited or renamed at this revision', 'ring dashed']]) {
          const entry = text('span', label);
          entry.prepend(text('i', '', className));
          treeLegend.append(entry);
        }
      }
      treemapNote = (outlined ? fmt(outlined) + ' outlined files changed at this revision · ' : '') + fmt(layout.groups.reduce((sum, group) => sum + group.leaves.length, 0)) + ' sized · ' + fmt(layout.sourceOnlyCount) + ' source-only · ' + fmt(layout.zeroTokenCount) + ' zero-token files';
      $('treemap-hover').textContent = treemapNote;
      $('treemap-hover').classList.remove('detail');
      drawn.treemap = viewRevisions[selected].components;
      drawn.outlined = outlined;
      fitTreemapLabels();
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
        const nameFits = () => name.getBoundingClientRect().bottom <= bottom + 1 && name.scrollHeight <= name.clientHeight + 1;
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
      $('skill-count').textContent = fmt(groups.length) + ' · ' + fmt(listedTokens) + ' listed' + listingKind() + ' · ' + fmt(manifestTokens) + ' manifest tokens' + (unresolved ? ' · ' + fmt(unresolved) + ' unresolved' : '');
      $('listing-note').textContent = (activeMeasure === 'estimate' ? '' : 'Manifest tokens here are ' + providerNames[activeMeasure] + ' counts, but listed tokens use the ' + listingKind().slice(2, -1) + ' of the whole report, so the two are not comparable. ') +
        'Listed tokens measure the frontmatter name and description an agent keeps in context before a skill is used. They mostly repeat text the manifest tokens already count, so never add the two; a Claude skill without a name is listed by its directory name, which is not in the file. Hidden skills are left out of the listing by their frontmatter; unresolved ones have frontmatter Strata could not read and are not counted.' +
        (activeView === 'cursor' && groups.some((group) => group.provider !== 'cursor') ? " Skills Cursor reads from .claude/skills or .agents/skills keep the listing measured by Claude Code's or Codex and Gemini CLI's rules; Cursor needs a name and description and honors disable-model-invocation, so its own listing of them can differ." : '') +
        (activeView === 'copilot' && groups.some((group) => group.provider !== 'copilot') ? " Skills Copilot reads from .claude/skills or .agents/skills keep the listing measured by Claude Code's or Codex and Gemini CLI's rules; Copilot needs a name and description, so its own listing of them can differ." : '');
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

    // Listings always use the report's own measurement, never a provider's counts, so measured views say which.
    function listingKind() {
      if (activeMeasure === 'estimate') return '';
      return ' (' + (data.measurement.accuracy === 'estimate' ? 'byte estimate' : data.measurement.encoding + ' encoding') + ')';
    }
    // A superseded format, such as .cursorrules, keeps its category but says it is legacy.
    function categoryLabel(component) {
      return component.category + (component.legacy ? ' (legacy)' : '');
    }
    // How a skill manifest is listed before use, as a clause after its stored-text tokens.
    function listingLabel(component) {
      const listing = component.skill?.listing;
      if (!listing) return '';
      if (listing.status === 'listed') return ' · ' + fmt(listing.tokens) + ' listed before use' + listingKind();
      return listing.status === 'hidden' ? ' · hidden from the listing' : ' · listing unresolved';
    }
    function listingCell(listing) {
      if (!listing) return text('td', '—', 'num');
      if (listing.status === 'listed') return text('td', fmt(listing.tokens), 'num');
      const cell = text('td', listing.status, 'num kind');
      cell.title = listing.status === 'hidden' ? 'disable-model-invocation keeps this skill out of the listing until it is invoked' : 'Strata could not read the listed name and description from this frontmatter';
      return cell;
    }

    // Both sides listed: the token change; otherwise each side's state, such as a manifest added or hidden.
    function listingDeltaCell(listing) {
      if (!listing) return text('td', '—', 'num');
      const side = (entry) => !entry ? 'none' : entry.status === 'listed' ? fmt(entry.tokens) : entry.status;
      if (listing.before?.status === 'listed' && listing.after?.status === 'listed') return text('td', signed(listing.deltaTokens), 'num ' + tone(listing.deltaTokens));
      return text('td', side(listing.before) + ' → ' + side(listing.after), 'num');
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
      $('compare-listing-label').textContent = 'Listed skill tokens' + listingKind();
      $('compare-listing').textContent = signed(skills.deltaTokens) + ' (' + fmt(skills.beforeTokens) + ' → ' + fmt(skills.afterTokens) + ')' +
        (skills.beforeUnresolved || skills.afterUnresolved ? ' · unresolved ' + fmt(skills.beforeUnresolved) + ' → ' + fmt(skills.afterUnresolved) : '');
      $('compare-listing').className = tone(skills.deltaTokens);
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
      chartBuckets.forEach((bucket) => bucket.button.classList.toggle('selected', bucket.start <= index && index <= bucket.end));
      $('date').textContent = revision.date.slice(0, 10);
      $('tokens').textContent = fmt(revision.estimatedTokens);
      $('components').textContent = fmt(revision.components.length);
      $('delta').textContent = (delta > 0 ? '+' : '') + fmt(delta);
      $('delta').className = delta > 0 ? 'positive' : delta < 0 ? 'negative' : '';
      $('revision').textContent = (index + 1) + ' / ' + revisions.length + ' · ' + revision.id.slice(0, 10);

      if (drawn.skills !== revision.skillGroups) renderSkills();

      if (drawn.treemap !== revision.components || drawn.outlined || revision.changes.length) renderTreemap();
      clearTimeout(settleTimer);
      if (dragging) settleTimer = setTimeout(renderTables, 120);
      else renderTables();
    }

    function renderTables() {
      const revision = viewRevisions[selected];
      if (drawn.inventory !== revision.components) renderInventory();
      if (drawn.target !== revision.components || drawn.baseline !== baselineRevision().components) renderComparison();
    }
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(fitTreemapLabels).observe($('treemap'));
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
