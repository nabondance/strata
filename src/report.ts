import { categories, type Report } from "./analyze.js";

export function renderHtml(report: Report): string {
  const serialized = JSON.stringify(report)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  const categoryNames = JSON.stringify(categories);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Strata — ${escapeHtml(report.repository)}</title>
  <style>
    :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0d1423; color: #e9edf5; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    header { padding: 36px max(24px, calc((100vw - 1200px) / 2)); background: linear-gradient(130deg, #172849, #0d1423 72%); border-bottom: 1px solid #2c3d5b; }
    .eyebrow { color: #8fc7ff; text-transform: uppercase; letter-spacing: .18em; font-size: 12px; font-weight: 700; }
    h1 { font-size: clamp(30px, 4vw, 46px); letter-spacing: -.04em; margin: 8px 0; }
    header p, .muted { color: #9baac0; }
    header p { margin: 0; }
    main { max-width: 1248px; padding: 28px 24px 60px; margin: auto; }
    .notice { color: #b5c6da; line-height: 1.5; margin: 0 0 22px; }
    .warning { color: #f3cc81; }
    .stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 16px; }
    .stat, .panel { background: #151f32; border: 1px solid #2a3953; border-radius: 14px; }
    .stat { padding: 18px; }
    .stat span { display: block; color: #9baac0; font-size: 12px; margin-bottom: 8px; }
    .stat strong { font-size: 24px; letter-spacing: -.03em; }
    .panel { padding: 20px; margin-bottom: 16px; }
    .panel h2 { font-size: 18px; margin: 0 0 14px; }
    .panel-head { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; align-items: baseline; }
    .revision { color: #9baac0; font-size: 13px; }
    .legend { display: flex; flex-wrap: wrap; gap: 14px; margin: 12px 0; color: #b5c6da; font-size: 12px; }
    .legend span { display: inline-flex; align-items: center; gap: 6px; }
    .swatch { display: inline-block; width: 9px; height: 9px; border-radius: 3px; }
    .chart-scroll { overflow-x: auto; padding: 10px 0 4px; }
    .chart { display: flex; align-items: end; gap: 3px; height: 220px; min-width: 100%; border-bottom: 1px solid #445671; }
    .bar { border: 0; padding: 0; margin: 0; background: transparent; display: flex; align-items: end; justify-content: center; height: 100%; flex: 1 0 9px; max-width: 20px; cursor: pointer; }
    .bar:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
    .bar.selected .stack { outline: 2px solid #fff; outline-offset: 2px; }
    .stack { width: 100%; display: flex; flex-direction: column-reverse; overflow: hidden; border-radius: 3px 3px 0 0; min-height: 2px; }
    .segment { display: block; width: 100%; }
    input[type=range] { width: 100%; accent-color: #91c8ff; margin-top: 18px; }
    .grid { display: grid; grid-template-columns: 1fr 1.4fr; gap: 16px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { color: #9baac0; text-align: left; font-weight: 500; border-bottom: 1px solid #34445d; }
    th, td { padding: 9px 8px; vertical-align: top; }
    tbody tr + tr { border-top: 1px solid #27364e; }
    td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    td.path { overflow-wrap: anywhere; }
    .kind { color: #9baac0; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; }
    .change { display: flex; gap: 10px; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #27364e; font-size: 13px; }
    .change span:first-child { overflow-wrap: anywhere; }
    .delta { white-space: nowrap; font-variant-numeric: tabular-nums; }
    .positive { color: #80d4aa; }
    .negative { color: #f29c9c; }
    .empty { color: #9baac0; font-size: 13px; }
    .table-wrap { overflow-x: auto; }
    footer { color: #8598b2; font-size: 12px; line-height: 1.5; }
    @media (max-width: 800px) { .stats { grid-template-columns: repeat(2, 1fr); } .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <header>
    <div class="eyebrow">Strata / local report</div>
    <h1>Agent context through time</h1>
    <p id="repo"></p>
  </header>
  <main>
    <p class="notice" id="method"></p>
    <div class="stats">
      <div class="stat"><span>Selected revision</span><strong id="date"></strong></div>
      <div class="stat"><span>Estimated tokens</span><strong id="tokens"></strong></div>
      <div class="stat"><span>Tracked components</span><strong id="components"></strong></div>
      <div class="stat"><span>Change since previous</span><strong id="delta"></strong></div>
    </div>
    <section class="panel">
      <div class="panel-head"><h2>Stored instruction history</h2><div class="revision" id="revision"></div></div>
      <div class="legend" id="legend"></div>
      <div class="chart-scroll"><div class="chart" id="chart"></div></div>
      <input id="slider" type="range" aria-label="Select revision">
    </section>
    <div class="grid">
      <section class="panel"><h2>Composition</h2><div class="table-wrap"><table><thead><tr><th>Category</th><th class="num">Files</th><th class="num">Est. tokens</th><th class="num">Source only</th></tr></thead><tbody id="categories"></tbody></table></div></section>
      <section class="panel"><h2>Changes at this revision</h2><div id="changes"></div></section>
    </div>
    <section class="panel"><h2>Tracked components</h2><div class="table-wrap"><table><thead><tr><th>Path</th><th>Provider</th><th>Category</th><th class="num">Est. tokens</th><th class="num">Bytes</th></tr></thead><tbody id="files"></tbody></table></div></section>
    <footer>Only Git-tracked files are analyzed. No source text is embedded in this report. Source-only files are listed by byte size and excluded from instruction token estimates.</footer>
  </main>
  <script>
    const data = ${serialized};
    const categories = ${categoryNames};
    const colors = {instructions:'#7aa9ef', skills:'#72d5be', agents:'#d4a1ef', rules:'#edbd77', commands:'#e890a3', memory:'#9bc283', settings:'#8595ac', tools:'#a5a7d8', other:'#80929c'};
    const $ = (id) => document.getElementById(id);
    const fmt = (n) => new Intl.NumberFormat().format(n);
    const text = (tag, value, className) => { const node = document.createElement(tag); node.textContent = value; if (className) node.className = className; return node; };
    let selected = data.revisions.length - 1;
    const chartButtons = [];

    $('repo').textContent = data.repository + ' / ' + data.branch + ' · ' + data.revisions.length + ' revisions';
    $('method').textContent = data.measurement.label + ' — ' + data.measurement.method + '. ' + data.measurement.limitations + (data.shallow ? ' Warning: this is a shallow clone, so earlier history is missing.' : '');
    if (data.shallow) $('method').classList.add('warning');
    const legend = $('legend');
    for (const category of categories) {
      if (!data.revisions.some((revision) => revision.categoryTotals[category].count)) continue;
      const label = text('span', category);
      const swatch = text('i', '', 'swatch');
      swatch.style.background = colors[category];
      label.prepend(swatch);
      legend.append(label);
    }

    const max = Math.max(1, ...data.revisions.map((revision) => revision.estimatedTokens));
    for (const [index, revision] of data.revisions.entries()) {
      const button = text('button', '', 'bar');
      button.type = 'button';
      button.title = revision.date.slice(0, 10) + ' · ' + revision.id.slice(0, 8) + ' · ' + fmt(revision.estimatedTokens) + ' estimated tokens';
      button.setAttribute('aria-label', 'Select revision ' + (index + 1));
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
      button.addEventListener('click', () => render(index));
      $('chart').append(button);
      chartButtons.push(button);
    }

    const slider = $('slider');
    slider.min = 0;
    slider.max = data.revisions.length - 1;
    slider.addEventListener('input', () => render(Number(slider.value)));

    function render(index) {
      selected = index;
      const revision = data.revisions[index];
      const previous = data.revisions[index - 1];
      const delta = revision.estimatedTokens - (previous?.estimatedTokens ?? 0);
      slider.value = index;
      chartButtons.forEach((button, position) => button.classList.toggle('selected', position === index));
      $('date').textContent = revision.date.slice(0, 10);
      $('tokens').textContent = fmt(revision.estimatedTokens);
      $('components').textContent = fmt(revision.components.length);
      $('delta').textContent = (delta > 0 ? '+' : '') + fmt(delta);
      $('delta').className = delta > 0 ? 'positive' : delta < 0 ? 'negative' : '';
      $('revision').textContent = (index + 1) + ' / ' + data.revisions.length + ' · ' + revision.id.slice(0, 10);

      const categoryBody = $('categories');
      categoryBody.replaceChildren();
      for (const category of categories) {
        const total = revision.categoryTotals[category];
        if (!total.count) continue;
        const row = document.createElement('tr');
        row.append(text('td', category), text('td', fmt(total.count), 'num'), text('td', total.count === total.sourceOnlyCount ? '—' : fmt(total.estimatedTokens), 'num'), text('td', fmt(total.sourceOnlyCount), 'num'));
        categoryBody.append(row);
      }

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

      const files = $('files');
      files.replaceChildren();
      const sorted = [...revision.components].sort((a, b) => (b.estimatedTokens ?? -1) - (a.estimatedTokens ?? -1) || a.path.localeCompare(b.path));
      for (const component of sorted) {
        const row = document.createElement('tr');
        row.append(text('td', component.path, 'path'), text('td', component.provider, 'kind'), text('td', component.category, 'kind'), text('td', component.estimatedTokens === null ? '—' : fmt(component.estimatedTokens), 'num'), text('td', fmt(component.bytes), 'num'));
        files.append(row);
      }
    }
    render(selected);
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}
