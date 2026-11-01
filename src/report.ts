import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { markSvg } from "./brand.js";
import type { Report } from "./model.js";
import { reportBody } from "./report/body.js";
import { clientScript } from "./report/client.js";
import { escapeHtml } from "./report/escape-html.js";
import { reportStyles } from "./report/styles.js";

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

/** The Strata release and the day that wrote a report, for its footer. */
export interface ReportOrigin {
  version: string;
  /** `YYYY-MM-DD`. */
  date: string;
}

/**
 * The self-contained HTML report: styles, markup, and the script that draws each panel from the embedded data.
 * `origin` names the release and day in the footer; without it the footer names neither.
 */
export function renderHtml(report: Report, origin?: ReportOrigin): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; img-src data:">
  <title>Strata — ${escapeHtml(report.repository)}</title>
  <link rel="icon" href="data:image/svg+xml,${encodeURIComponent(markSvg(64))}">
  <style>
${reportStyles}
  </style>
</head>
<body>
${reportBody(report, origin)}
  <script>${d3Bundle()}</script>
  <script>
${clientScript(report)}
  </script>
</body>
</html>`;
}
