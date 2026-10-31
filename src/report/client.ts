import { categories } from "../adapters.js";
import { compareRevisions } from "../compare.js";
import { configMap } from "../config-map.js";
import { expandRevisions } from "../expand.js";
import { importLinks } from "../import-links.js";
import { instructionAgePeriods, instructionAges, sharePercent } from "../instruction-age.js";
import type { Report } from "../model.js";
import { categoryColors, categoryInk, categoryShade, categoryShadeInk } from "../palette.js";
import { providerReads, viewRevision } from "../provider-view.js";
import { timelineBuckets } from "../timeline.js";
import { layoutTreemap } from "../treemap.js";
import { sessionProviderNames, upFrontContext } from "../up-front.js";
import { ageScript } from "./client/age.js";
import { compareScript } from "./client/compare.js";
import { filesScript } from "./client/files.js";
import { historyScript } from "./client/history.js";
import { importsScript } from "./client/imports.js";
import { labelsScript } from "./client/labels.js";
import { mapScript } from "./client/map.js";
import { renderScript } from "./client/render.js";
import { skillsScript } from "./client/skills.js";
import { stateScript } from "./client/state.js";
import { treemapScript } from "./client/treemap.js";
import { upFrontScript } from "./client/up-front.js";
import { viewsScript } from "./client/views.js";

/**
 * The report's script. Its parts share one scope and run in this order, so a part may use what an earlier
 * part declared; functions are hoisted, but a const or let must be declared before code runs that reads it.
 */
export function clientScript(report: Report, tokenAdjective: string): string {
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
  const agesSource = instructionAges.toString();
  const periodsSource = instructionAgePeriods.toString();
  const shareSource = sharePercent.toString();
  const data = `    const data = ${serialized};
    const categories = ${categoryNames};
    const expandRevisions = ${expandSource};
    const compareRevisions = ${compareSource};
    const providerReads = ${readsSource};
    const viewRevision = ${viewSource};
    const timelineBuckets = ${timelineSource};
    const importLinks = ${importsSource};
    const upFrontContext = ${upFrontSource};
    const configMap = ${mapSource};
    const instructionAges = ${agesSource};
    const instructionAgePeriods = ${periodsSource};
    const sharePercent = ${shareSource};
    const agentNames = ${JSON.stringify(sessionProviderNames)};
    const hierarchy = d3.hierarchy;
    const treemap = d3.treemap;
    const layoutTreemap = ${treemapSource};
    const providerColumns = (data.providerMeasurements ?? []).map((measured) => measured.provider);
    const colors = ${JSON.stringify(categoryColors)};
    const inks = ${JSON.stringify(categoryInk)};
    const shades = ${JSON.stringify(categoryShade)};
    const shadeInks = ${JSON.stringify(categoryShadeInk)};`;
  return [
    data,
    stateScript(tokenAdjective),
    historyScript,
    viewsScript,
    filesScript,
    treemapScript,
    skillsScript,
    mapScript,
    importsScript,
    labelsScript,
    upFrontScript,
    compareScript,
    ageScript,
    renderScript,
  ].join("\n\n");
}
