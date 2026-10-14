import type { Report } from "./model.js";

const numberFormat = new Intl.NumberFormat("en-US");

/**
 * The badge JSON follows the shields.io endpoint schema, so a README can show the latest
 * stored-text token total with `https://img.shields.io/endpoint?url=<published file>`.
 * It carries the number and its kind only: no names, paths, commit IDs, or dates.
 */
export function renderBadge(report: Report): string {
  const latest = report.revisions.at(-1);
  const tokens = numberFormat.format(latest?.estimatedTokens ?? 0);
  const exact = report.measurement.accuracy === "encoding-exact";
  const badge = {
    schemaVersion: 1,
    label: "agent context",
    message: `${exact ? "" : "≈"}${tokens} tokens`,
    color: "d9a441",
    labelColor: "1d2622",
  };
  return `${JSON.stringify(badge, null, 2)}\n`;
}
