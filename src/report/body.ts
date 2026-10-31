import { brandUrl, markSvg } from "../brand.js";
import type { Report } from "../model.js";
import { textRecipients } from "../provider-count.js";
import { providerName } from "../provider-counting.js";
import { escapeHtml } from "./escape-html.js";

/** The page markup: the masthead and every panel, empty until the script fills them. */
export function reportBody(report: Report, tokenAdjective: string): string {
  const accuracyLabels = { "api-counted": "API", "encoding-exact": "local exact", estimate: "estimate" } as const;
  const providerColumns = (report.providerMeasurements ?? [])
    .map(
      (measured) =>
        `<th class="num" title="${escapeHtml([measured.accuracy, measured.model, measured.method, measured.credential].filter(Boolean).join(" · "))}">${providerName[measured.provider]} ${accuracyLabels[measured.accuracy]}</th>`,
    )
    .join("");
  const sentTo = (report.providerMeasurements ?? []).filter((measured) => textRecipients(measured).length);
  const providerNote = report.providerMeasurements
    ? `Provider columns are each provider's own count and are never added together. ${
        sentTo.length
          ? `Text sent to: ${sentTo.map((measured) => `${escapeHtml(textRecipients(measured).join(" and "))} (${providerName[measured.provider]})`).join(", ")}.`
          : "No text was sent to a provider."
      }`
    : "";

  return `  <header>
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
      <p class="muted map-intro">Where each file sits, with a bar for its share of the tokens named under the map. Lines are Claude @path imports, with the arrow at the imported file. A folder only holds its files, and a line does not show that a session loaded a file.</p>
      <div class="legend"><span><i class="map-key"></i>Claude import</span><span><i class="map-key dashed"></i>Import to or from a closed folder</span><span><i class="swatch hollow"></i>Source-only file or folder, measured in bytes</span></div>
      <div class="config-map" id="config-map" role="tree" aria-labelledby="map-heading"></div>
      <p class="treemap-hover" id="map-hover" aria-live="polite"></p>
    </section>
    <details class="panel" id="age-panel" hidden>
      <summary><h2>Instruction age</h2><span class="summary-count" id="age-count"></span></summary>
      <p class="muted">How long the instruction text has stayed: each layer is the text first added in one period that is still there, oldest at the bottom.</p>
      <details class="notice"><summary>How instruction age is measured</summary><p>Lines are matched by their exact text in every instruction file, so a line moved into a skill keeps its age, and an edited line starts again. Text removed and later restored counts as new, including a file that leaves and rejoins because an import was dropped and restored. Weighed by the bytes of nonblank lines, and always across all files, whatever the view. Periods follow author dates.</p></details>
      <div class="legend age-legend" id="age-legend"></div>
      <div class="chart-scroll"><div class="chart age-chart" id="age-chart" role="group" aria-label="Instruction text by the period it was added"></div></div>
      <div class="timeline-meta"><span id="age-start"></span><span id="age-end"></span></div>
      <p class="muted" id="age-note"></p>
    </details>
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
        <span id="compare-kept-wrap" hidden title="Instruction text at the baseline revision that is still present, line for line, at the target revision, across all files"><span id="compare-kept-label">Instruction text kept</span><strong id="compare-kept"></strong></span>
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
  </main>`;
}
