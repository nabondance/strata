import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { categories } from "./adapters.js";
import { compareRevisions } from "./compare.js";
import { expandRevisions } from "./expand.js";
import type { Report } from "./model.js";
import { categoryColors } from "./palette.js";
import { viewRevision } from "./provider-view.js";
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
  const timelineSource = timelineBuckets.toString();
  const providerColumns = report.providerMeasurements
    ? '<th class="num">Claude API</th><th class="num">Gemini API</th><th class="num">Codex / OpenAI local</th>'
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
  <title>Strata — ${escapeHtml(report.repository)}</title>
  <style>
    :root { color-scheme: light; --paper: #f2efe7; --sheet: #fbfaf6; --ink: #24312c; --muted: #5c6a63; --line: #c9c8be; --rust: #934e37; font-family: "Avenir Next", "Helvetica Neue", Arial, sans-serif; background: var(--paper); color: var(--ink); }
    * { box-sizing: border-box; }
    body { margin: 0; }
    header { padding: 0 max(24px, calc((100vw - 1200px) / 2)); background: #e8e4d8; border-bottom: 1px solid #b9b8ac; }
    .header-top { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; border-bottom: 1px solid #b9b8ac; padding: 19px 0 15px; }
    .wordmark { font-size: 16px; letter-spacing: .22em; font-weight: 800; }
    .folio, .eyebrow, .repo-label { color: var(--rust); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
    .header-main { display: flex; justify-content: space-between; align-items: end; gap: 32px; padding: 52px 0 46px; }
    h1 { max-width: 760px; font-family: Georgia, "Times New Roman", serif; font-size: clamp(44px, 5.5vw, 78px); font-weight: 400; line-height: .97; letter-spacing: -.065em; margin: 14px 0 0; }
    .dek { max-width: 295px; font-size: 16px; line-height: 1.5; color: var(--muted); margin: 0 0 4px; }
    .repo-strip { border-top: 1px solid #b9b8ac; display: flex; gap: 20px; align-items: baseline; padding: 13px 0 16px; }
    .repo-strip strong { font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
    .muted { color: var(--muted); line-height: 1.5; }
    main { max-width: 1248px; padding: 26px 24px 64px; margin: auto; }
    .notice { max-width: 970px; color: var(--muted); line-height: 1.55; margin: 0 0 24px; font-size: 13px; overflow-wrap: anywhere; }
    .warning { color: #8a442c; font-weight: 600; }
    .stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border-top: 2px solid var(--ink); border-bottom: 1px solid var(--line); margin-bottom: 28px; }
    .stat { padding: 17px 18px 20px; border-right: 1px solid var(--line); min-width: 0; }
    .stat:first-child { padding-left: 0; }
    .stat:last-child { border-right: 0; }
    .stat span { display: block; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; text-transform: uppercase; letter-spacing: .08em; margin-bottom: 10px; }
    .stat strong { font-family: "Avenir Next", "Helvetica Neue", Arial, sans-serif; font-size: clamp(25px, 3vw, 34px); font-weight: 650; letter-spacing: -.035em; font-variant-numeric: tabular-nums lining-nums; }
    .panel { background: var(--sheet); border: 1px solid var(--line); padding: 24px; margin-bottom: 18px; min-width: 0; }
    .panel h2 { font-family: Georgia, "Times New Roman", serif; font-size: 27px; font-weight: 400; letter-spacing: -.035em; margin: 0 0 16px; }
    .panel h2 + p { font-size: 13px; margin: -5px 0 18px; }
    .panel-head { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; align-items: baseline; }
    .revision { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
    .legend { display: flex; flex-wrap: wrap; gap: 9px 20px; margin: 7px 0 17px; color: var(--muted); font-size: 12px; }
    .legend span { display: inline-flex; align-items: center; gap: 7px; }
    .swatch { display: inline-block; width: 10px; height: 10px; }
    .chart-scroll { padding: 4px 2px 6px; }
    .chart { display: grid; align-items: end; gap: 2px; height: 220px; width: 100%; border-bottom: 1px solid #8b9289; background: repeating-linear-gradient(to top, transparent 0, transparent 54px, #e4e2d9 55px); }
    .bar { border: 0; padding: 0; margin: 0; min-width: 0; background: transparent; display: flex; align-items: end; justify-content: center; height: 100%; cursor: pointer; }
    .bar:focus-visible { outline: 2px solid var(--rust); outline-offset: 2px; }
    .bar.selected .stack { outline: 2px solid var(--ink); outline-offset: 2px; }
    .bar.baseline .stack { box-shadow: 0 0 0 2px #b98542; }
    .stack { width: 100%; display: flex; flex-direction: column-reverse; overflow: hidden; min-height: 2px; }
    .segment { display: block; width: 100%; }
    input[type=range] { width: 100%; accent-color: var(--rust); margin-top: 17px; }
    .timeline-meta { display: flex; justify-content: space-between; gap: 12px; margin-top: 6px; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
    .timeline-note { color: var(--muted); font-size: 12px; line-height: 1.4; margin: 8px 0 0; }
    .provider-tabs { display: flex; flex-wrap: wrap; gap: 7px; margin: 0 0 11px; }
    .provider-tab { padding: 9px 14px; border: 1px solid var(--line); background: var(--sheet); color: var(--ink); font: inherit; font-size: 13px; cursor: pointer; }
    .provider-tab[aria-pressed="true"] { background: var(--ink); color: #fff; border-color: var(--ink); }
    .provider-tab:focus-visible { outline: 2px solid var(--rust); outline-offset: 2px; }
    .view-note { margin: 0 0 21px; color: var(--muted); font-size: 13px; line-height: 1.5; }
    .treemap { position: relative; height: 390px; background: #e8e4d8; overflow: hidden; }
    .treemap-leaf { position: absolute; display: flex; flex-direction: column; align-items: start; justify-content: space-between; gap: 5px; border: 2px solid var(--sheet); padding: 9px; overflow: hidden; color: #fff; text-align: left; cursor: pointer; font: inherit; }
    .treemap-leaf:hover, .treemap-leaf:focus-visible { outline: 3px solid var(--ink); outline-offset: -4px; z-index: 2; }
    .treemap-leaf .leaf-name { display: block; flex-shrink: 0; max-width: 100%; overflow-wrap: anywhere; font-size: 13px; line-height: 1.2; font-weight: 700; }
    .treemap-leaf .leaf-size { flex-shrink: 0; margin-top: auto; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
    .treemap-leaf [hidden] { display: none; }
    .treemap-leaf.compact { padding: 3px 5px; }
    .treemap-leaf.compact .leaf-name { overflow: hidden; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
    .treemap-leaf.changed::after { content: ""; position: absolute; inset: 2px; border: 2px solid #f6d26b; pointer-events: none; }
    .treemap-leaf.changed.edited::after { border-style: dashed; }
    .ring { display: inline-block; width: 12px; height: 12px; border: 2px solid #a87a12; }
    .ring.dashed { border-style: dashed; }
    .treemap-group { position: absolute; border: 3px solid var(--sheet); pointer-events: none; z-index: 1; }
    .treemap-note { color: var(--muted); font-size: 12px; line-height: 1.45; margin: 12px 0 0; }
    .treemap-hover { min-height: 42px; padding: 10px 12px; margin: 10px 0 0; border-left: 3px solid var(--rust); background: #f0eee6; color: var(--ink); font-size: 13px; line-height: 1.45; overflow-wrap: anywhere; }
    .skill-count { margin: 0 0 10px; color: var(--muted); font-size: 12px; }
    .skill-toggle { margin-top: 13px; border: 1px solid #9fa99d; padding: 9px 13px; background: transparent; color: var(--ink); font: inherit; cursor: pointer; }
    .skill-toggle:hover { background: #e8e4d8; }
    .skill-toggle:focus-visible { outline: 2px solid var(--rust); outline-offset: 2px; }
    .compare-controls, .inventory-controls { display: flex; flex-wrap: wrap; gap: 12px; margin: 8px 0 18px; align-items: end; }
    .compare-controls label, .inventory-controls label { display: grid; gap: 6px; min-width: min(100%, 230px); color: var(--muted); font-size: 12px; }
    .inventory-controls label { min-width: min(100%, 180px); }
    .inventory-controls label.search { flex: 1 1 240px; }
    :is(.compare-controls, .inventory-controls) :is(select, input) { width: 100%; border: 1px solid #9fa99d; border-radius: 0; padding: 10px 11px; background: #fff; color: var(--ink); font: inherit; }
    :is(.compare-controls, .inventory-controls) :is(select, input, button):focus-visible { outline: 2px solid var(--rust); outline-offset: 2px; }
    .inventory-controls button { border: 1px solid #9fa99d; border-radius: 0; padding: 10px 13px; background: transparent; color: var(--ink); font: inherit; cursor: pointer; }
    .inventory-controls button:hover { background: #e8e4d8; }
    .inventory-count { color: var(--muted); font-size: 12px; margin: 0 0 12px; }
    .compare-summary { display: flex; flex-wrap: wrap; gap: 12px 30px; padding: 16px 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); margin: 0 0 6px; }
    .compare-summary span { color: var(--muted); font-size: 12px; }
    .compare-summary strong { display: block; color: var(--ink); font-family: "Avenir Next", "Helvetica Neue", Arial, sans-serif; font-size: 21px; font-weight: 650; margin-top: 5px; font-variant-numeric: tabular-nums lining-nums; }
    .compare-summary strong.positive { color: #306f55; }
    .compare-summary strong.negative { color: #a44935; }
    .compare-section { margin-top: 18px; }
    .compare-section h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; margin: 0 0 9px; }
    .grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr); gap: 18px; }
    .grid > * { min-width: 0; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { color: var(--muted); text-align: left; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; text-transform: uppercase; letter-spacing: .05em; font-weight: 600; border-bottom: 1px solid #aeb6aa; }
    th, td { padding: 10px 8px; vertical-align: top; }
    tbody tr + tr { border-top: 1px solid #deded5; }
    tbody tr:hover { background: #f0eee6; }
    td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    td.path { overflow-wrap: anywhere; }
    .kind { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
    .change { display: flex; gap: 10px; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #deded5; font-size: 13px; }
    .change span:first-child { overflow-wrap: anywhere; }
    .delta { white-space: nowrap; font-variant-numeric: tabular-nums; }
    .positive { color: #306f55; }
    .negative { color: #a44935; }
    .empty { color: var(--muted); font-size: 13px; }
    .table-wrap { overflow-x: auto; }
    footer { color: var(--muted); border-top: 1px solid var(--line); margin-top: 25px; padding-top: 16px; font-size: 12px; line-height: 1.55; }
    @media (max-width: 800px) { .header-main { align-items: start; flex-direction: column; padding: 38px 0 30px; } .dek { max-width: 470px; } .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); } .stat:nth-child(2) { border-right: 0; } .stat:nth-child(n+3) { border-top: 1px solid var(--line); } .stat:nth-child(3) { padding-left: 0; } .grid { grid-template-columns: minmax(0, 1fr); } }
    @media (max-width: 520px) { header { padding: 0 18px; } .folio { display: none; } main { padding: 20px 18px 50px; } h1 { font-size: 45px; } .stat strong { font-size: 24px; } .panel { padding: 18px; } .panel h2 { font-size: 24px; } .repo-strip { display: block; } .repo-strip strong { display: block; margin-top: 6px; } .treemap { height: 320px; } .treemap-leaf { padding: 6px; } }
  </style>
</head>
<body>
  <header>
    <div class="header-top"><span class="wordmark">STRATA</span><span class="folio">A field report of agent context</span></div>
    <div class="header-main"><div><div class="eyebrow">Context archaeology / Git history</div><h1>Agent context<br>through time.</h1></div><p class="dek">Trace the instructions and tools around an agent as they accumulate, move, and disappear.</p></div>
    <div class="repo-strip"><span class="repo-label">Repository</span><strong id="repo"></strong></div>
  </header>
  <main>
    <p class="notice" id="method"></p>
    <nav class="provider-tabs" id="provider-tabs" aria-label="Configuration view"></nav>
    <p class="view-note" id="view-note"></p>
    <div class="stats">
      <div class="stat"><span>Selected revision</span><strong id="date"></strong></div>
      <div class="stat"><span>${tokenAdjective} tokens</span><strong id="tokens"></strong></div>
      <div class="stat"><span>Tracked components</span><strong id="components"></strong></div>
      <div class="stat"><span>Change since previous</span><strong id="delta"></strong></div>
    </div>
    <section class="panel">
      <div class="panel-head"><h2>Stored instruction history</h2><div class="revision" id="revision"></div></div>
      <div class="legend" id="legend"></div>
      <div class="chart-scroll"><div class="chart" id="chart"></div></div>
      <input id="slider" type="range" aria-label="Select revision">
      <div class="timeline-meta"><span id="timeline-start"></span><span id="timeline-selected"></span><span id="timeline-end"></span></div>
      <p class="timeline-note" id="timeline-note"></p>
    </section>
    <section class="panel" aria-labelledby="treemap-heading">
      <h2 id="treemap-heading">Configuration at this revision</h2>
      <p class="muted">Rectangle area follows ${tokenAdjective.toLowerCase()} stored-text tokens; color groups files by category. Select a rectangle to find its file below.</p>
      <div class="legend" id="treemap-legend"></div>
      <div class="treemap" id="treemap" role="group" aria-label="Token-size treemap of instructional components"></div>
      <p class="treemap-hover" id="treemap-hover" aria-live="polite">Hover or focus a rectangle to see its full path and token count.</p>
      <p class="treemap-note" id="treemap-note"></p>
    </section>
    <section class="panel" aria-labelledby="skills-heading">
      <h2 id="skills-heading">Skill bundles</h2>
      <p class="muted">Manifest estimates and supporting resource bytes are shown separately. A bundle's files are counted once in the inventory.</p>
      <p class="skill-count" id="skill-count"></p>
      <div class="table-wrap"><table><thead><tr><th>Skill directory</th><th>Provider</th><th>Manifest</th><th class="num">Manifest tokens</th><th class="num">Resources</th><th class="num">Resource bytes</th></tr></thead><tbody id="skill-groups"></tbody></table></div>
      <button class="skill-toggle" id="skill-toggle" type="button" aria-expanded="false" hidden></button>
    </section>
    <section class="panel" aria-labelledby="compare-heading">
      <h2 id="compare-heading">Compare revisions</h2>
      <p class="muted">Compare stored configuration at two points on the first-parent timeline. A moved file may appear as a removal and addition.</p>
      <div class="compare-controls">
        <label>Baseline revision<select id="baseline"></select></label>
        <label>Target revision<select id="target"></select></label>
      </div>
      <div class="compare-summary">
        <span>${tokenAdjective} stored-text tokens<strong id="compare-tokens"></strong></span>
        <span>Percent change<strong id="compare-percent"></strong></span>
        <span>Tracked files<strong id="compare-files"></strong></span>
      </div>
      <div class="grid">
        <div class="compare-section"><h3>By provider</h3><div class="table-wrap"><table><thead><tr><th>Provider</th><th class="num">Δ files</th><th class="num">Δ tokens</th></tr></thead><tbody id="compare-providers"></tbody></table></div></div>
        <div class="compare-section"><h3>By category</h3><div class="table-wrap"><table><thead><tr><th>Category</th><th class="num">Δ files</th><th class="num">Δ tokens</th></tr></thead><tbody id="compare-categories"></tbody></table></div></div>
      </div>
      <div class="compare-section"><h3>Changed components</h3><p class="muted">Each row is one file: added is +1 file, removed is −1, edited is 0. The grouped file totals above can be larger.</p><div class="table-wrap"><table><thead><tr><th>Path</th><th>Provider</th><th>Category</th><th>Change</th><th class="num">Δ tokens</th></tr></thead><tbody id="compare-components"></tbody></table></div></div>
    </section>
    <div class="grid">
      <section class="panel"><h2>Composition</h2><div class="table-wrap"><table><thead><tr><th>Category</th><th class="num">Files</th><th class="num">Tokens</th><th class="num">Source only</th></tr></thead><tbody id="categories"></tbody></table></div></section>
      <section class="panel"><h2>Changes at this revision</h2><div id="changes"></div></section>
    </div>
    <section class="panel"><h2>Tracked components</h2>
      <div class="inventory-controls">
        <label>Provider<select id="provider-filter"><option value="">All providers</option></select></label>
        <label>Category<select id="category-filter"><option value="">All categories</option></select></label>
        <label class="search">Path search<input id="path-search" type="search" placeholder="Filter by path" autocomplete="off"></label>
        <button id="clear-filters" type="button">Clear filters</button>
      </div>
      <p class="inventory-count" id="inventory-count" aria-live="polite"></p>
      ${report.providerMeasurements ? `<p class="muted">Provider counts below are separate counts for the selected stored text under each named model. They are not added together; timeline and summary totals continue to use ${escapeHtml(report.measurement.label)}. Claude and Gemini counts were sent to their provider APIs.</p>` : ""}
      <div class="table-wrap"><table><thead><tr><th>Path</th><th>Provider</th><th>Category</th><th class="num">Tokens</th><th class="num">Bytes</th>${providerColumns}</tr></thead><tbody id="files"></tbody></table></div></section>
    <footer>Only Git-tracked files are analyzed. No source text is embedded in this report. Source-only files are listed by byte size and excluded from instruction token estimates.</footer>
  </main>
  <script>${d3Bundle()}</script>
  <script>
    const data = ${serialized};
    const categories = ${categoryNames};
    const expandRevisions = ${expandSource};
    const compareRevisions = ${compareSource};
    const viewRevision = ${viewSource};
    const timelineBuckets = ${timelineSource};
    const hierarchy = d3.hierarchy;
    const treemap = d3.treemap;
    const layoutTreemap = ${treemapSource};
    const providerColumns = data.providerMeasurements ? ['claude', 'gemini', 'codex'] : [];
    const colors = ${JSON.stringify(categoryColors)};
    const $ = (id) => document.getElementById(id);
    const numberFormat = new Intl.NumberFormat();
    const fmt = (n) => numberFormat.format(n);
    const signed = (n) => (n > 0 ? '+' : '') + fmt(n);
    const tone = (n) => n > 0 ? 'positive' : n < 0 ? 'negative' : '';
    const text = (tag, value, className) => { const node = document.createElement(tag); node.textContent = value; if (className) node.className = className; return node; };
    const revisions = expandRevisions(data);
    let selected = revisions.length - 1;
    let baseline = 0;
    let activeView = 'all';
    let viewRevisions = revisions;
    let showAllSkills = false;
    let providerFilter = '';
    let categoryFilter = '';
    let pathSearch = '';
    let inventoryRows = new Map();
    let chartBuckets = [];
    let chartStart = 0;
    let treemapLabels = [];
    // What each panel last drew, so moving between revisions that share an inventory redraws nothing.
    let drawn = {};
    let settleTimer;

    $('repo').textContent = data.repository + ' / ' + data.branch + ' · ' + revisions.length + ' revisions';
    $('method').textContent = (data.privacy.mode === 'shareable' ? 'Shareable export: repository names, paths, commit IDs, and blob IDs are replaced with aliases; dates and measurements remain visible. ' : '') + data.measurement.label + ' — ' + data.measurement.method + '. ' + data.measurement.limitations + (data.shallow ? ' Warning: this is a shallow clone, so earlier history is missing.' : '');
    if (data.shallow) $('method').classList.add('warning');
    function renderLegend() {
      const legend = $('legend');
      legend.replaceChildren();
      for (const category of categories) {
        if (!viewRevisions.some((revision) => revision.categoryTotals[category].count)) continue;
        const label = text('span', category);
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
      const charted = viewRevisions.length - chartStart;
      const buckets = timelineBuckets(viewRevisions.length, 100, chartStart);
      slider.min = chartStart;
      chart.style.gridTemplateColumns = 'repeat(' + buckets.length + ', minmax(0, 1fr))';
      const max = Math.max(1, ...viewRevisions.map((revision) => revision.estimatedTokens));
      for (const bucket of buckets) {
        const revision = viewRevisions[bucket.end];
        const button = text('button', '', 'bar');
        button.type = 'button';
        const range = bucket.start === bucket.end ? 'Revision ' + (bucket.end + 1) : 'Revisions ' + (bucket.start + 1) + '–' + (bucket.end + 1);
        button.title = range + ' · ' + revision.date.slice(0, 10) + ' · ' + fmt(revision.estimatedTokens) + ' stored-text tokens at end';
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
      $('timeline-note').textContent = (buckets.length === charted
        ? 'One bar per revision. Select a bar or use the slider to inspect a commit.'
        : fmt(charted) + ' revisions grouped into ' + fmt(buckets.length) + ' bars. Each bar shows the last revision in its group; the slider selects every charted revision.')
        + (chartStart ? ' The chart starts at revision ' + fmt(chartStart + 1) + ': the ' + fmt(chartStart) + ' earlier revisions have no tracked configuration in this view. They remain available in the comparison selectors.' : '');
      $('timeline-start').textContent = viewRevisions[chartStart].date.slice(0, 10);
      $('timeline-end').textContent = viewRevisions.at(-1).date.slice(0, 10);
    }

    const slider = $('slider');
    slider.max = revisions.length - 1;
    // While the slider is dragged, the file and comparison tables wait until it settles; the rest follows it live.
    slider.addEventListener('input', () => render(Number(slider.value), true));
    slider.addEventListener('change', () => render(Number(slider.value)));
    for (const [index, revision] of revisions.entries()) {
      const label = (index + 1) + ' · ' + revision.date.slice(0, 10) + ' · ' + revision.id.slice(0, 8);
      for (const id of ['baseline', 'target']) {
        const option = text('option', label);
        option.value = String(index);
        $(id).append(option);
      }
    }
    $('baseline').addEventListener('change', () => { baseline = Number($('baseline').value); renderComparison(); });
    $('target').addEventListener('change', () => render(Number($('target').value)));
    const allComponents = data.components;
    const providers = [...new Set(allComponents.map((component) => component.provider))].sort();
    const viewTabs = [{ key: 'all', label: 'All files' },
      ...providers.filter((provider) => provider !== 'shared').map((provider) => ({
        key: provider, label: provider === 'unknown' ? 'Unknown' : provider[0].toUpperCase() + provider.slice(1) + ' + shared',
      })),
      ...(providers.includes('shared') ? [{ key: 'shared', label: 'Shared only' }] : [])];
    for (const view of viewTabs) {
      const button = text('button', view.label, 'provider-tab');
      button.type = 'button';
      button.setAttribute('aria-pressed', String(view.key === activeView));
      button.addEventListener('click', () => {
        activeView = view.key;
        viewRevisions = [];
        for (const [index, revision] of revisions.entries()) {
          const view = viewRevision(revision, activeView, revisions[index - 1]);
          // Revisions that changed nothing keep sharing arrays in a provider view too.
          if (view !== revision && index && revision.components === revisions[index - 1].components) {
            view.components = viewRevisions[index - 1].components;
            view.skillGroups = viewRevisions[index - 1].skillGroups;
          }
          viewRevisions.push(view);
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
        renderLegend();
        renderChart();
        render(selected);
      });
      $('provider-tabs').append(button);
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
        ? 'All tracked configuration files are counted once. Provider views overlap where shared instructions are present; none of these totals measures loaded session context.'
        : activeView === 'shared'
          ? 'Shared instruction candidates are shown on their own here. They also appear in provider views where those providers are present.'
          : activeView === 'unknown'
            ? 'These candidate files are not assigned to a supported provider and are source-only unless explicitly recognized.'
            : 'This view contains ' + activeView + '-labeled files plus shared instruction candidates. Shared files can appear in more than one provider view; adding tab totals would double-count them. Inclusion does not prove an agent loaded a file.';
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
    renderLegend();
    renderChart();

    function renderInventory() {
      const revision = viewRevisions[selected];
      drawn.inventory = revision.components;
      const matching = revision.components.filter((component) =>
        (!providerFilter || component.provider === providerFilter) &&
        (!categoryFilter || component.category === categoryFilter) &&
        (!pathSearch || component.path.toLocaleLowerCase().includes(pathSearch)));
      $('inventory-count').textContent = 'Showing ' + fmt(matching.length) + ' of ' + fmt(revision.components.length) + ' files in this view. Chart and summary totals include all files in this view.';
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
      for (const component of sorted) {
        const row = document.createElement('tr');
        row.tabIndex = -1;
        row.append(text('td', component.path, 'path'), text('td', component.provider, 'kind'), text('td', component.category, 'kind'), text('td', component.estimatedTokens === null ? '—' : fmt(component.estimatedTokens), 'num'), text('td', fmt(component.bytes), 'num'));
        for (const provider of providerColumns) {
          const count = component.providerTokenCounts?.[provider];
          const cell = text('td', count ? fmt(count.tokens) : '—', 'num');
          if (count) cell.title = count.accuracy + ' · ' + count.model + ' · ' + count.method + ' · ' + count.version;
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
      $('treemap-hover').textContent = 'Hover or focus a rectangle to see its full path and token count.';
      if (!layout.totalTokens) root.append(text('p', 'No instructional token estimates at this revision.', 'empty'));
      for (const group of layout.groups) {
        const label = text('span', group.category);
        const swatch = text('i', '', 'swatch');
        swatch.style.background = colors[group.category];
        label.prepend(swatch);
        treeLegend.append(label);
        for (const leaf of group.leaves) {
          const component = viewRevisions[selected].components[leaf.componentIndex];
          const button = text('button', '', 'treemap-leaf');
          button.type = 'button';
          button.style.left = leaf.x + '%';
          button.style.top = leaf.y + '%';
          button.style.width = leaf.width + '%';
          button.style.height = leaf.height + '%';
          button.style.background = colors[component.category];
          const change = changedHere.get(component.path);
          const changeLabel = !change ? '' : change.kind === 'added' ? ' · added at this revision' : change.kind === 'renamed' ? ' · renamed at this revision from ' + change.previousPath : ' · edited at this revision';
          const detail = component.path + ' · ' + component.provider + ' / ' + component.category + ' · ' + fmt(leaf.estimatedTokens) + ' stored-text tokens' + changeLabel;
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
          const showDetail = () => { $('treemap-hover').textContent = detail; };
          const clearDetail = () => { $('treemap-hover').textContent = 'Hover or focus a rectangle to see its full path and token count.'; };
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
      if (outlined) {
        for (const [label, className] of [['added at this revision', 'ring'], ['edited or renamed at this revision', 'ring dashed']]) {
          const entry = text('span', label);
          entry.prepend(text('i', '', className));
          treeLegend.append(entry);
        }
      }
      $('treemap-note').textContent = (outlined ? fmt(outlined) + ' outlined files changed at this revision. ' : '') + fmt(layout.groups.reduce((sum, group) => sum + group.leaves.length, 0)) + ' sized instructional files · ' + fmt(layout.sourceOnlyCount) + ' source-only files · ' + fmt(layout.zeroTokenCount) + ' zero-token instructional files. Source-only and zero-token files remain in the inventory.';
      drawn.treemap = viewRevisions[selected].components;
      drawn.outlined = outlined;
      fitTreemapLabels();
    }

    function fitTreemapLabels() {
      if (typeof getComputedStyle !== 'function') return;
      for (const { button, name, size } of treemapLabels) {
        button.classList.remove('compact');
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
      $('skill-count').textContent = groups.length > 8
        ? 'Showing ' + fmt(visible.length) + ' of ' + fmt(groups.length) + ' skill bundles.'
        : fmt(groups.length) + ' skill bundles at this revision.';
      const toggle = $('skill-toggle');
      toggle.hidden = groups.length <= 8;
      toggle.textContent = showAllSkills ? 'Show first 8 skill bundles' : 'Show all ' + fmt(groups.length) + ' skill bundles';
      toggle.setAttribute('aria-expanded', String(showAllSkills));
      if (!groups.length) {
        const row = document.createElement('tr');
        const cell = text('td', 'No tracked skill bundles at this revision.', 'empty');
        cell.colSpan = 6;
        row.append(cell);
        skillBody.append(row);
      }
      for (const group of visible) {
        const row = document.createElement('tr');
        row.append(text('td', group.root, 'path'), text('td', group.provider), text('td', group.manifestPath ? 'SKILL.md' : 'Missing', 'kind'), text('td', group.manifestPath ? fmt(group.manifestEstimatedTokens) : '—', 'num'), text('td', fmt(group.resourceCount), 'num'), text('td', fmt(group.resourceBytes), 'num'));
        skillBody.append(row);
      }
    }

    function renderComparison() {
      const comparison = compareRevisions(viewRevisions[baseline], viewRevisions[selected]);
      drawn.baseline = viewRevisions[baseline].components;
      drawn.target = viewRevisions[selected].components;
      $('baseline').value = String(baseline);
      chartBuckets.forEach((bucket) => bucket.button.classList.toggle('baseline', bucket.start <= baseline && baseline <= bucket.end));
      $('compare-tokens').textContent = signed(comparison.deltaTokens) + ' (' + fmt(comparison.beforeTokens) + ' → ' + fmt(comparison.afterTokens) + ')';
      $('compare-tokens').className = tone(comparison.deltaTokens);
      $('compare-percent').textContent = comparison.percentChange === null ? '— (baseline is zero)' : (comparison.percentChange > 0 ? '+' : '') + comparison.percentChange.toFixed(1) + '%';
      $('compare-files').textContent = signed(comparison.deltaFiles) + ' (' + fmt(comparison.beforeFiles) + ' → ' + fmt(comparison.afterFiles) + ')';
      $('compare-files').className = tone(comparison.deltaFiles);
      for (const [id, groups] of [['compare-providers', comparison.byProvider], ['compare-categories', comparison.byCategory]]) {
        const body = $(id);
        body.replaceChildren();
        for (const group of groups) {
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
        cell.colSpan = 5;
        row.append(cell);
        body.append(row);
      }
      for (const component of comparison.components) {
        const row = document.createElement('tr');
        row.append(text('td', component.path, 'path'), text('td', component.provider), text('td', component.category), text('td', component.kind), text('td', component.beforeTokens === null && component.afterTokens === null ? 'source only' : signed(component.deltaTokens), 'num ' + tone(component.deltaTokens)));
        body.append(row);
      }
    }

    function render(index, dragging) {
      selected = index;
      const revision = viewRevisions[index];
      const previous = viewRevisions[index - 1];
      const delta = revision.estimatedTokens - (previous?.estimatedTokens ?? 0);
      slider.value = index;
      $('target').value = String(index);
      chartBuckets.forEach((bucket) => bucket.button.classList.toggle('selected', bucket.start <= index && index <= bucket.end));
      $('date').textContent = revision.date.slice(0, 10);
      $('tokens').textContent = fmt(revision.estimatedTokens);
      $('components').textContent = fmt(revision.components.length);
      $('delta').textContent = (delta > 0 ? '+' : '') + fmt(delta);
      $('delta').className = delta > 0 ? 'positive' : delta < 0 ? 'negative' : '';
      $('revision').textContent = (index + 1) + ' / ' + revisions.length + ' · ' + revision.id.slice(0, 10);
      $('timeline-selected').textContent = 'Selected: ' + revision.date.slice(0, 10) + ' (' + (index + 1) + '/' + revisions.length + ')';

      const categoryBody = $('categories');
      categoryBody.replaceChildren();
      for (const category of categories) {
        const total = revision.categoryTotals[category];
        if (!total.count) continue;
        const row = document.createElement('tr');
        row.append(text('td', category), text('td', fmt(total.count), 'num'), text('td', total.count === total.sourceOnlyCount ? '—' : fmt(total.estimatedTokens), 'num'), text('td', fmt(total.sourceOnlyCount), 'num'));
        categoryBody.append(row);
      }

      if (drawn.skills !== revision.skillGroups) renderSkills();

      const changes = $('changes');
      changes.replaceChildren();
      if (!revision.changes.length) changes.append(text('p', 'No tracked configuration changes.', 'empty'));
      for (const change of revision.changes) {
        const row = text('div', '', 'change');
        const name = change.kind + ': ' + (change.previousPath ? change.previousPath + ' → ' : '') + change.path;
        const deltaLabel = change.previousTokens === null && change.estimatedTokens === null ? 'source only' : (change.deltaTokens > 0 ? '+' : '') + fmt(change.deltaTokens);
        row.append(text('span', name), text('span', deltaLabel, 'delta ' + (change.deltaTokens > 0 ? 'positive' : change.deltaTokens < 0 ? 'negative' : '')));
        changes.append(row);
      }

      if (drawn.treemap !== revision.components || drawn.outlined || revision.changes.length) renderTreemap();
      clearTimeout(settleTimer);
      if (dragging) settleTimer = setTimeout(renderTables, 120);
      else renderTables();
    }

    function renderTables() {
      const revision = viewRevisions[selected];
      if (drawn.inventory !== revision.components) renderInventory();
      if (drawn.target !== revision.components || drawn.baseline !== viewRevisions[baseline].components) renderComparison();
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
