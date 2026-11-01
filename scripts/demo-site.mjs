#!/usr/bin/env node
// Builds the demo site published to GitHub Pages: one Strata report per gallery repository and
// a landing page that links to them. Each repository is cloned without a working tree, since
// Strata reads only Git blobs. Run with a built Strata: `pnpm build && node scripts/demo-site.mjs`.
//
//   --strata <dir>  Strata package directory holding dist/ (default: this checkout)
//   --out <dir>     Where the site goes (default: .strata-output/demo-site)
//   --work <dir>    Where clones go; an existing clone is reused (default: a temporary directory)
//   --self <dir>    Use this local clone for nabondance/strata instead of cloning it
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/** The gallery, in page order. Each is a public repository with a history of agent configuration. */
const gallery = [
  {
    repo: "microsoft/vscode",
    note: "Copilot instructions and skills under .github, shared skills under .agents, and AGENTS.md files across the source tree.",
  },
  {
    repo: "getsentry/sentry",
    note: "Shared skills under .agents, Claude commands, and an AGENTS.md and CLAUDE.md pair for each area of the code.",
  },
  {
    repo: "n8n-io/n8n",
    note: "Shared skills and review rules under .agents, a Claude plugin, and AGENTS.md and CLAUDE.md files across the packages.",
  },
  {
    repo: "pydantic/pydantic-ai",
    note: "Skills kept for Claude and for other agents, with AGENTS.md and CLAUDE.md files beside the tests and packages.",
  },
  {
    repo: "openai/openai-agents-python",
    note: "OpenAI's agent SDK: a root AGENTS.md, a CLAUDE.md that names it, and skills with reference files under .agents.",
  },
  {
    repo: "google-gemini/gemini-cli",
    note: "Google's terminal agent: a GEMINI.md for each package, plus Gemini skills and commands.",
  },
  {
    repo: "microsoft/playwright",
    note: "Claude skills, a root AGENTS.md, and Copilot instructions.",
  },
  {
    repo: "openai/codex",
    note: "OpenAI's coding agent. Its root AGENTS.md and skills were removed in September 2026; a few nested AGENTS.md files remain.",
  },
  {
    repo: "nabondance/strata",
    note: "Strata itself: an AGENTS.md that CLAUDE.md imports, a reviewer agent, and a skill kept for Claude and Codex.",
  },
].map((item) => ({ ...item, slug: item.repo.split("/")[1] }));

const { values } = parseArgs({
  options: {
    strata: { type: "string", default: "." },
    out: { type: "string", default: ".strata-output/demo-site" },
    work: { type: "string" },
    self: { type: "string" },
  },
});
const strataDir = resolve(values.strata);
const out = resolve(values.out);
const work = resolve(values.work ?? mkdtempSync(join(tmpdir(), "strata-demo-")));
const cli = join(strataDir, "dist", "cli.js");
const { brandColors, displayFontFace, displayFontStack, markSvg } = await import(
  pathToFileURL(join(strataDir, "dist", "brand.js")).href
);
const { categoryColors } = await import(pathToFileURL(join(strataDir, "dist", "palette.js")).href);
// A report leaves out what repeats the previous revision; the same Strata build restores it.
const { fillRevisions } = await import(pathToFileURL(join(strataDir, "dist", "expand.js")).href);
const version = JSON.parse(readFileSync(join(strataDir, "package.json"), "utf8")).version;

const run = (command, args) =>
  execFileSync(command, args, { encoding: "utf8", maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "inherit"] });
const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const number = (value) => value.toLocaleString("en-US");
const day = (date) => date.slice(0, 10);

/**
 * Per-category token series for a card's thumbnail, from the first revision with configuration to
 * the latest, in at most `steps` steps; like the report, each step shows the last revision in its group.
 */
function layers(revisions, steps = 160) {
  const start = Math.max(
    0,
    revisions.findIndex((revision) => revision.estimatedTokens > 0),
  );
  const span = revisions.length - start;
  const count = Math.min(steps, span);
  const picks = Array.from({ length: count }, (_, step) => start + Math.floor(((step + 1) * span) / count) - 1);
  return Object.keys(categoryColors)
    .map((category) => ({
      category,
      values: picks.map((index) => revisions[index].categoryTotals[category]?.estimatedTokens ?? 0),
    }))
    .filter(({ values }) => values.some((value) => value > 0));
}

/** A stacked step chart of the layers, stretched to fill its box. */
function thumbnail(series) {
  const count = series[0]?.values.length ?? 0;
  if (!count) return "";
  const width = 400;
  const height = 120;
  const sums = Array.from({ length: count }, (_, i) => series.reduce((sum, { values }) => sum + values[i], 0));
  const scale = (height - 6) / Math.max(1, ...sums);
  const base = new Array(count).fill(0);
  const x = (i) => Math.round((i * width * 100) / count) / 100;
  const y = (value) => Math.round((height - value * scale) * 100) / 100;
  const paths = series.map(({ category, values }) => {
    const top = values.map((value, i) => base[i] + value);
    let d = `M0,${y(top[0])}`;
    for (let i = 0; i < count; i++) d += `H${x(i + 1)}${i + 1 < count ? `V${y(top[i + 1])}` : ""}`;
    d += `V${y(base[count - 1])}`;
    for (let i = count - 1; i >= 0; i--) d += `H${x(i)}${i > 0 ? `V${y(base[i - 1])}` : ""}`;
    for (let i = 0; i < count; i++) base[i] = top[i];
    return `<path d="${d}Z" fill="${categoryColors[category]}"/>`;
  });
  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">${paths.join("")}</svg>`;
}

const percent = (part, whole) => {
  const value = (100 * part) / whole;
  return value > 0 && value < 1 ? "<1%" : `${Math.round(value)}%`;
};

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
mkdirSync(work, { recursive: true });

const entries = [];
for (const item of gallery) {
  const started = Date.now();
  // Strata names a report after the folder, so each clone's folder is the repository's own name.
  let dir = join(work, item.repo);
  if (item.repo === "nabondance/strata" && values.self) dir = resolve(values.self);
  else if (!existsSync(dir)) {
    run("git", ["clone", "--quiet", "--no-checkout", "--single-branch", `https://github.com/${item.repo}.git`, dir]);
  }
  const jsonPath = join(work, `${item.slug}.json`);
  run("node", [cli, "analyze", dir, "--output", join(out, `${item.slug}.html`), "--quiet"]);
  run("node", [cli, "analyze", dir, "--format", "json", "--output", jsonPath, "--quiet"]);
  const report = JSON.parse(readFileSync(jsonPath, "utf8"));
  const revisions = fillRevisions(report.revisions);
  const first = revisions.find((revision) => revision.estimatedTokens > 0) ?? revisions[0];
  const latest = revisions.at(-1);
  const peak = revisions.reduce((max, revision) => (revision.estimatedTokens > max.estimatedTokens ? revision : max));
  const totals = latest.categoryTotals;
  const categories = Object.entries(totals)
    .filter(([, total]) => total.estimatedTokens > 0)
    .sort(([, a], [, b]) => b.estimatedTokens - a.estimatedTokens)
    .map(([category, total]) => ({ category, tokens: total.estimatedTokens }));
  entries.push({
    ...item,
    branch: report.branch,
    revisions: revisions.length,
    first,
    latest,
    peak,
    categories,
    layers: layers(revisions),
  });
  console.log(
    `${item.repo}: ${revisions.length} revisions, ${latest.estimatedTokens} tokens (${Date.now() - started} ms)`,
  );
}

const commandLine = "npx context-strata analyze --open";
const card = (entry) => {
  const total = entry.latest.estimatedTokens || 1;
  const bar = entry.categories
    .map(
      ({ category, tokens }) =>
        `<span style="flex:${tokens};background:${categoryColors[category] ?? categoryColors.other}" title="${escapeHtml(category)}: ${number(tokens)}"></span>`,
    )
    .join("");
  const legend = entry.categories
    .map(
      ({ category, tokens }) =>
        `<li><i style="background:${categoryColors[category] ?? categoryColors.other}"></i>${escapeHtml(category)} <b>${escapeHtml(percent(tokens, total))}</b></li>`,
    )
    .join("");
  return `      <article class="card">
        <a class="thumb" href="${entry.slug}.html" aria-label="Open the report for ${escapeHtml(entry.repo)}" tabindex="-1">${thumbnail(entry.layers)}</a>
        <div class="body">
          <h2><a href="${entry.slug}.html">${escapeHtml(entry.repo)}</a></h2>
          <p class="note">${escapeHtml(entry.note)}</p>
          <dl>
            <div><dt>Now</dt><dd>${number(entry.latest.estimatedTokens)}</dd></div>
            <div><dt>Peak</dt><dd>${number(entry.peak.estimatedTokens)}</dd></div>
            <div><dt>Files</dt><dd>${number(entry.latest.componentCount)}</dd></div>
            <div><dt title="First-parent commits on the default branch, with or without configuration">Revisions</dt><dd>${number(entry.revisions)}</dd></div>
          </dl>
          <div class="bar" aria-hidden="true">${bar}</div>
          <ul class="legend">${legend}</ul>
          <p class="meta">${escapeHtml(entry.branch)} · configured ${day(entry.first.date)} → ${day(entry.latest.date)}</p>
          <p class="links"><a class="open" href="${entry.slug}.html">Open report</a><a href="https://github.com/${escapeHtml(entry.repo)}" rel="noopener">Repository</a></p>
        </div>
      </article>`;
};

const generated = new Date().toISOString().slice(0, 10);
const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Strata: agent context through Git history</title>
  <meta name="description" content="See how the agent configuration of well-known open-source repositories grew, commit by commit. Reports made with Strata.">
  <style>
    ${displayFontFace}
    :root { color-scheme: light dark; --paper: #f2efe7; --sheet: #fbfaf6; --ink: #24312c; --muted: #5c6a63; --line: #c9c8be; --link: #80590a; }
    @media (prefers-color-scheme: dark) { :root { --paper: #121815; --sheet: #1a221e; --ink: #e7e3d6; --muted: #c2c8bd; --line: #37423c; --link: ${brandColors.ochre}; } }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--paper); color: var(--ink); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
    a { color: var(--link); }
    .wrap { padding: 0 max(24px, calc((100vw - 1200px) / 2)); }
    header { background: ${brandColors.bedrock}; color: ${brandColors.bone}; padding-bottom: 40px; }
    .brand { display: flex; gap: 12px; align-items: center; padding-top: 18px; font-family: ${displayFontStack}; font-size: 24px; font-weight: 800; letter-spacing: .03em; }
    h1 { font-family: ${displayFontStack}; font-size: clamp(40px, 6.5vw, 76px); font-weight: 800; line-height: .95; margin: 28px 0 14px; max-width: 16ch; }
    .lede { color: #c9cec4; font-size: 19px; max-width: 60ch; margin: 0 0 22px; }
    .cli { display: inline-flex; align-items: center; gap: 14px; flex-wrap: wrap; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .cli code { background: #2b3530; border: 1px solid #4a554f; color: ${brandColors.bone}; padding: 10px 14px; font-size: 15px; }
    .cli a { color: ${brandColors.ochre}; }
    main.wrap { padding-top: 34px; padding-bottom: 40px; }
    .intro { color: var(--muted); max-width: 75ch; margin: 0 0 26px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 22px; }
    .card { background: var(--sheet); border: 1px solid var(--line); display: flex; flex-direction: column; }
    .thumb { display: block; background: ${brandColors.bedrock}; padding: 16px 0 0; }
    .thumb svg { display: block; width: 100%; height: 120px; }
    .body { padding: 18px 20px 20px; display: flex; flex-direction: column; flex: 1; }
    h2 { font-family: ${displayFontStack}; font-size: 25px; font-weight: 800; letter-spacing: .01em; margin: 0 0 4px; overflow-wrap: anywhere; }
    h2 a { color: inherit; text-decoration: none; }
    h2 a:hover { text-decoration: underline; }
    /* Fixed heights keep the numbers, bars, and buttons aligned across a row of cards. */
    .note { color: var(--muted); font-size: 14.5px; line-height: 1.5; height: 4.5em; overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; margin: 0 0 14px; }
    dl { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 0 0 14px; }
    dt { color: var(--muted); font: 10px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; text-transform: uppercase; letter-spacing: .08em; }
    dd { margin: 0; font-family: ${displayFontStack}; font-size: 22px; font-weight: 800; font-variant-numeric: tabular-nums lining-nums; }
    .bar { display: flex; height: 8px; gap: 2px; margin-bottom: 8px; }
    .legend { list-style: none; padding: 0; margin: 0 0 12px; display: flex; flex-wrap: wrap; align-content: flex-start; gap: 4px 14px; font-size: 13px; line-height: 1.5; min-height: calc(3em + 4px); color: var(--muted); }
    .legend i { display: inline-block; width: 9px; height: 9px; margin-right: 5px; }
    .legend b { color: var(--ink); font-weight: 600; }
    .meta { color: var(--muted); font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0 0 14px; }
    .links { margin: auto 0 0; display: flex; gap: 18px; align-items: center; font-size: 15px; }
    .open { background: ${brandColors.clay}; color: #fff; text-decoration: none; padding: 7px 14px; font-weight: 600; }
    .open:hover { background: #9c4529; }
    footer.wrap { border-top: 1px solid var(--line); color: var(--muted); font-size: 14px; padding-top: 18px; padding-bottom: 40px; }
    footer p { margin: 0 0 6px; max-width: 90ch; }
  </style>
</head>
<body>
  <header>
    <div class="wrap">
      <div class="brand">${markSvg(30)}<span>STRATA</span></div>
      <h1>See how agent context grows, commit by commit.</h1>
      <p class="lede">Strata reads a repository's Git history and shows how its CLAUDE.md, AGENTS.md, skills, rules, and agent definitions grew, when, and which files made them grow. Here it is on a few open-source projects.</p>
      <div class="cli"><code>${commandLine}</code><a href="https://github.com/nabondance/strata">Get Strata on GitHub</a></div>
    </div>
  </header>
  <main class="wrap">
    <p class="intro">Each card opens the full report: the timeline, a treemap and a configuration map of any revision, what each agent reads at session start, and a comparison of any two revisions. Numbers are stored-text tokens, estimated as UTF-8 bytes divided by four: what the repository stores, not what a session loaded or what anyone was billed.</p>
    <section class="grid">
${entries.map(card).join("\n")}
    </section>
  </main>
  <footer class="wrap">
    <p>Made with Strata ${escapeHtml(version)} on ${generated}, from each repository's default branch. The reports hold paths, commit IDs, dates, and measurements, never the text of the files.</p>
    <p><a href="https://github.com/nabondance/strata">GitHub</a> · <a href="https://www.npmjs.com/package/context-strata">npm</a> · <a href="https://github.com/marketplace/actions/strata-agent-context-check">GitHub Action</a></p>
  </footer>
</body>
</html>
`;
writeFileSync(join(out, "index.html"), page);
writeFileSync(join(out, ".nojekyll"), "");
console.log(`Site: ${join(out, "index.html")}`);
