import { brandColors, displayFontFace, displayFontStack } from "../brand.js";

// The select arrow, drawn inset from the field's edge. Data URIs cannot read CSS variables, so each theme passes its own color.
function chevron(color: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 8"><path d="M1.5 1.75l4.5 4.5 4.5-4.5" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return `url(data:image/svg+xml,${encodeURIComponent(svg)})`;
}

/** The report's stylesheet, light and dark. */
export const reportStyles = `    ${displayFontFace}
    :root { color-scheme: light dark; --paper: #f2efe7; --sheet: #fbfaf6; --ink: #24312c; --muted: #5c6a63; --line: #c9c8be; --grid: #e4e2d9; --edge: #9fa99d; --hover: #ece9de; --field: #fff; --chevron: ${chevron("#5c6a63")}; --up: #80590a; --down: #2c6b65; --warn: #8a442c; --clay: ${brandColors.clay}; --bedrock: ${brandColors.bedrock}; --bone: ${brandColors.bone}; --ochre: ${brandColors.ochre}; font-family: "Avenir Next", "Helvetica Neue", Arial, sans-serif; background: var(--paper); color: var(--ink); }
    @media (prefers-color-scheme: dark) { :root { --paper: #121815; --sheet: #1a221e; --ink: #e7e3d6; --muted: #c2c8bd; --line: #37423c; --grid: #28322d; --edge: #56625b; --hover: #242e29; --field: #131916; --chevron: ${chevron("#c2c8bd")}; --up: ${brandColors.ochre}; --down: #8fbdb7; --warn: #e39072; } }
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
    .summary-count { color: var(--muted); font-size: 14px; font-weight: 500; font-variant-numeric: tabular-nums; }
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
    /* Instruction age: one hue, oldest text darkest in light mode and lightest in dark mode, a surface gap between layers.
       The newest end keeps 3:1 contrast with the panel, so every layer stays visible, and the two ends are
       as far apart in lightness as in dark mode, so neighboring layers stay distinct. */
    :root { --age-old: #08302c; --age-new: #609890; }
    @media (prefers-color-scheme: dark) { :root { --age-old: #c2e6df; --age-new: #3c7870; } }
    .age-chart { height: 160px; background: repeating-linear-gradient(to top, transparent 0, transparent 39px, var(--grid) 40px); }
    .age-chart .segment { border-top: 2px solid var(--sheet); }
    .age-chart .segment:last-child { border-top: 0; }
    /* No tint behind the selected bar, which would lower the contrast of its top layer; the mark under it shows the selection. */
    .age-chart .bar.selected { background: transparent; }
    .age-legend b { min-width: 3.2em; }
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
    @media (max-width: 520px) { .map-tools { margin-bottom: 10px; } }
    .map-tools button { padding: 6px 11px; border: 1px solid var(--line); background: var(--sheet); color: var(--ink); font: inherit; font-size: 12px; cursor: pointer; }
    .map-tools button:hover { background: var(--hover); }
    .map-tools button:focus-visible { outline: 2px solid var(--clay); outline-offset: 2px; }
    .map-intro { font-size: 13px; margin: 0 0 4px; max-width: 900px; }
    .map-key { display: inline-block; flex: none; width: 9px; height: 14px; border: 2px solid var(--ink); border-left: 0; border-radius: 0 100% 100% 0 / 0 50% 50% 0; }
    .map-key.dashed { border-style: dashed; border-left: 0; }
    .config-map { --gutter: 150px; position: relative; padding-right: var(--gutter); border-top: 1px solid var(--grid); }
    .map-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(48px, 1fr) 8ch; align-items: center; gap: 12px; height: 30px; padding-right: 10px; border-bottom: 1px solid var(--grid); cursor: pointer; font-size: 13px; }
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
    :is(.compare-controls, .inventory-controls) select { appearance: none; padding-right: 38px; background: var(--field) var(--chevron) no-repeat right 14px center / 12px 8px; cursor: pointer; }
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
    @media (max-width: 520px) { .masthead { padding: 0 18px; } main { padding: 20px 18px 50px; } .stat strong { font-size: 24px; } .silhouette { height: 76px; } .panel { padding: 18px; } .panel h2 { font-size: 21px; } details.panel > summary { flex-wrap: wrap; } details.panel > summary .summary-count { order: 1; flex-basis: 100%; } .treemap { height: 320px; } .treemap-leaf { padding: 6px; } .config-map { --gutter: 64px; } .map-row { grid-template-columns: minmax(0, 1fr) 36px 7ch; gap: 8px; } /* Names need the room; the detail line and accessible name still give each tag. */ .map-tag { display: none; } }
    .empty-state h2 { text-transform: none; font-size: 28px; line-height: 1.15; overflow-wrap: anywhere; }
    .empty-state p { max-width: 70ch; font-size: 14px; line-height: 1.55; }
    .empty-state ul { display: flex; flex-wrap: wrap; gap: 8px; list-style: none; margin: 0 0 14px; padding: 0; }
    .empty-state code { display: inline-block; border: 1px solid var(--line); background: var(--paper); padding: 3px 8px; font-size: 13px; }
    .submodule-note { margin-top: -10px; }
    .silhouette .silhouette-mark { left: 0; right: auto; width: 2px; margin-left: -1px; background: var(--bone); opacity: .9; }
    .silhouette .silhouette-mark[hidden] { display: none; }
    /* Stored instruction history: a value axis in the left gutter, calendar labels between the end dates, and a hover card. */
    .history-plot { position: relative; padding-left: 40px; }
    .history-plot .chart-scroll { position: relative; z-index: 1; }
    .history-plot .chart { background: none; }
    .history-ticks { position: absolute; left: 0; right: 0; top: 4px; height: 219px; pointer-events: none; }
    .history-tick { position: absolute; left: 40px; right: 0; height: 0; border-top: 1px solid var(--grid); }
    .history-tick span { position: absolute; right: 100%; padding-right: 7px; transform: translateY(-50%); color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .history-plot .timeline-meta { position: relative; }
    .history-dates { position: absolute; inset: 0; pointer-events: none; }
    .history-dates span { position: absolute; top: 0; transform: translateX(-50%); white-space: nowrap; }
    .history-steps { margin: 6px 0 0; color: var(--muted); font-size: 12px; line-height: 1.45; }
    /* The selected column keeps its stack in full color: a faint tint behind it, and a cap above it in the ink color. */
    .history-plot .bar.selected { background: color-mix(in srgb, var(--ink) 7%, transparent); }
    .history-plot .bar.selected .stack { box-shadow: 0 -2px 0 var(--sheet), 0 -5px 0 var(--ink); }
    .history-plot .bar:focus-visible .stack { box-shadow: 0 -2px 0 var(--sheet), 0 -5px 0 var(--clay); }
    .history-tip { position: absolute; top: 0; z-index: 2; display: grid; gap: 3px; min-width: 170px; max-width: min(260px, calc(100% - 40px)); padding: 9px 11px; border: 1px solid var(--edge); background: var(--sheet); color: var(--ink); font-size: 12px; line-height: 1.35; pointer-events: none; box-shadow: 0 4px 14px color-mix(in srgb, var(--ink) 14%, transparent); }
    .history-tip-date { color: var(--muted); font-variant-numeric: tabular-nums; margin-bottom: 3px; }
    .history-tip-row { display: flex; align-items: center; gap: 7px; color: var(--muted); }
    .history-tip-row b { margin-left: auto; padding-left: 12px; color: var(--ink); font-weight: 600; font-variant-numeric: tabular-nums; }
    .history-tip-total { border-top: 1px solid var(--line); padding-top: 4px; margin-top: 2px; }
    @media (max-width: 520px) { .history-plot { padding-left: 34px; } .history-tick { left: 34px; } .history-dates span:not(.primary) { display: none; } }
    /* Compare revisions: what "Previous change" stands for, the bytes under the kept share, and the MCP servers as a list. */
    .compare-span { margin: -8px 0 16px; font-size: 12px; }
    .compare-summary .compare-kept-bytes { display: block; margin-top: 2px; color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
    .compare-mcp-names { display: flex; flex-wrap: wrap; gap: 10px 36px; margin: 10px 0 0; font-size: 13px; }
    .compare-mcp-heading { display: block; margin-bottom: 4px; color: var(--ink); font-size: 12px; font-weight: 600; }
    .compare-mcp-names ul { margin: 0; padding: 0; list-style: none; }
    .compare-mcp-names li { margin: 2px 0; }
    .compare-mcp-names b { color: var(--ink); font-weight: 600; }
    .compare-mcp-names .path { overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
    .compare-mcp-names summary { cursor: pointer; }
    .compare-mcp-names summary:focus-visible { outline: 2px solid var(--clay); outline-offset: 2px; }
    .compare-mcp-names details ul { margin: 4px 0 6px 14px; }`;
