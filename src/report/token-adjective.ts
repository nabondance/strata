import type { Report } from "../model.js";

/** The word before "tokens" in the report's labels: "Encoding" for a local exact count, otherwise "Estimated". */
export function tokenAdjective(report: Report): string {
  return report.measurement.accuracy === "encoding-exact" ? "Encoding" : "Estimated";
}
