import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { compareRevisions } from "../dist/compare.js";
import { expandRevisions } from "../dist/expand.js";
import { instructionAgePeriods, instructionAges, sharePercent } from "../dist/instruction-age.js";
import { viewRevision } from "../dist/provider-view.js";
import { timelineBuckets, timelineScale } from "../dist/timeline.js";

/** Run the report's script against a minimal fake DOM and return its elements by ID. */
export function loadReportUi(html) {
  const layout = { crampedLabels: false };
  class Element {
    constructor(tag) {
      this.tag = tag;
      this.children = [];
      this.style = {};
      this.listeners = {};
      this.attributes = {};
      this.classes = new Set();
      this.classList = {
        add: (name) => this.classes.add(name),
        remove: (name) => this.classes.delete(name),
        toggle: (name, force = !this.classes.has(name)) => {
          if (force) this.classes.add(name);
          else this.classes.delete(name);
          return force;
        },
      };
    }
    append(...children) {
      for (const child of children) if (child instanceof Element) child.parentElement = this;
      this.children.push(...children);
    }
    closest(selector) {
      const name = selector.slice(1);
      for (let at = this; at; at = at.parentElement) if (at.className?.split(" ").includes(name)) return at;
      return null;
    }
    prepend(...children) {
      for (const child of children) if (child instanceof Element) child.parentElement = this;
      this.children.unshift(...children);
    }
    remove() {
      if (!this.parentElement) return;
      this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
      this.parentElement = null;
    }
    replaceChildren(...children) {
      this.children = children;
    }
    addEventListener(event, listener) {
      this.listeners[event] = listener;
    }
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    }
    getAttribute(name) {
      return this.attributes[name] ?? null;
    }
    focus() {
      this.focused = true;
      document.activeElement = this;
    }
    scrollIntoView() {
      this.scrolled = true;
    }
    getBoundingClientRect() {
      if (this.className === "treemap-leaf") return { bottom: 100, right: 180 };
      // A test can say which names fit; one that does not runs past the rectangle's lower edge.
      if (this.className === "leaf-name") return { bottom: layout.labelFits?.(this.textContent) === false ? 200 : 40 };
      if (this.className === "leaf-size")
        return layout.crampedLabels ? { top: 42, bottom: 95, right: 165 } : { top: 60, bottom: 80, right: 150 };
      return { bottom: 0, right: 0 };
    }
    get scrollHeight() {
      return 20;
    }
    get clientHeight() {
      return 20;
    }
  }
  const elements = new Map();
  const document = {
    createElement: (tag) => new Element(tag),
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, new Element(id));
      return elements.get(id);
    },
  };
  const d3Script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  const script = html.match(/<script>\n([\s\S]*?)\n {2}<\/script>/)?.[1];
  assert.ok(d3Script);
  assert.ok(script);
  assert.match(html, /Permission to use, copy, modify, and\/or distribute this software/);
  assert.match(html, /d3-hierarchy\/ v3\.1\.2/);
  const timers = new Map();
  const context = {
    document,
    Intl,
    setTimeout: (run) => {
      timers.set(timers.size + 1, run);
      return timers.size;
    },
    clearTimeout: (id) => timers.delete(id),
    getComputedStyle: () => ({ paddingBottom: "9", borderBottomWidth: "2", paddingRight: "9", borderRightWidth: "2" }),
  };
  runInNewContext(d3Script, context);
  runInNewContext(script, context);
  return { get: (id) => elements.get(id), timers, layout };
}

/** The options of a select, inside its month groups or not. */
export function selectOptions(select) {
  return select.children.flatMap((child) => (child.tag === "optgroup" ? child.children : [child]));
}

/** The revision "Previous change" compares with: the one before the latest change at or before `index`. */
export function previousChange(revisions, index) {
  let at = index;
  while (at >= 0 && !revisions[at].changes.length) at -= 1;
  return Math.max(-1, at - 1);
}

const compactFormat = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/** The y-axis labels the history chart should show for these revision totals. */
export function expectedTicks(totals) {
  return timelineScale(Math.max(1, ...totals)).ticks.map((value) => compactFormat.format(value));
}

export function exerciseReportUi(html, report) {
  const revisions = expandRevisions(report);
  const { get, timers, layout } = loadReportUi(html);
  // The value axis labels round steps of the largest total; the step caption appears only when bars group revisions.
  const tickLabels = () => get("chart-ticks").children.map((tick) => tick.children[0].textContent);
  assert.deepEqual(tickLabels(), expectedTicks(revisions.map((revision) => revision.estimatedTokens)));
  assert.ok(tickLabels().length >= 3 && tickLabels().length <= 5);
  assert.equal(get("chart-ticks").children.at(-1).style.bottom, "210.0px");
  const charted =
    revisions.length -
    Math.max(
      0,
      revisions.findIndex((revision) => revision.components.length),
    );
  assert.equal(get("chart-steps").hidden, charted <= 100);
  if (charted > 100)
    assert.equal(
      get("chart-steps").textContent,
      `${new Intl.NumberFormat().format(charted)} revisions shown as 100 steps; each step shows the last revision in its group.`,
    );
  // The selects list the first, the latest, and every revision that changed something, after the two relative choices.
  const listed = revisions.filter(
    (revision, index) => !index || index === revisions.length - 1 || revision.changes.length,
  );
  assert.deepEqual(
    selectOptions(get("baseline")).map((option) => option.value),
    ["change", "previous", ...listed.map((revision) => String(revisions.indexOf(revision)))],
  );
  assert.equal(selectOptions(get("target")).length, listed.length);
  assert.equal(
    get("baseline").children.some((child) => child.tag === "optgroup"),
    listed.length > 50,
  );
  // The masthead silhouette has a layer for each category holding tokens; the legend also lists source-only ones.
  const tokenCategories = Object.values(revisions.at(-1).categoryTotals).filter((total) => total.estimatedTokens > 0);
  const silhouetteLayers = get("silhouette").children.filter((child) => child.className !== "silhouette-mark");
  assert.ok(silhouetteLayers.length >= tokenCategories.length);
  assert.ok(silhouetteLayers.length <= get("legend").children.length);
  // A line in the silhouette marks the selected revision.
  const mark = get("silhouette").children.at(-1);
  assert.equal(mark.className, "silhouette-mark");
  assert.equal(mark.hidden, !silhouetteLayers.length);
  assert.equal(get("repo").textContent, report.repository);
  // Long lists start with their first rows; the rest of this exercise runs with them expanded.
  assert.equal(get("files").children.length, Math.min(25, revisions.at(-1).components.length) || 1);
  assert.equal(get("files-more").hidden, revisions.at(-1).components.length <= 25);
  for (const id of ["files", "compare-components"]) get(`${id}-more`).onclick();
  assert.equal(get("files").children.length, revisions.at(-1).components.length || 1);
  assert.equal(get("target").value, String(revisions.length - 1));
  assert.equal(get("skill-groups").children.length, Math.min(8, revisions.at(-1).skillGroups.length) || 1);
  if (revisions.at(-1).skillGroups.length > 8) {
    assert.equal(get("skill-toggle").hidden, false);
    assert.match(get("skill-toggle").textContent, /Show all/);
    get("skill-toggle").listeners.click();
    assert.equal(get("skill-groups").children.length, revisions.at(-1).skillGroups.length);
  }
  // The comparison starts against the previous change, so it lists what the latest change did.
  assert.equal(get("baseline").value, "change");
  assert.equal(get("compare-span").hidden, false);
  assert.equal(
    get("compare-components").children.length,
    compareRevisions(
      revisions[previousChange(revisions, revisions.length - 1)] ?? { components: [], estimatedTokens: 0 },
      revisions.at(-1),
    ).components.length || 1,
  );
  // The legend carries the selected revision's figure for each category, and the two long panels start closed.
  assert.ok(get("legend").children.every((entry) => entry.children.at(-1).tag === "b"));
  assert.equal(get("skills-panel").hidden, !revisions.at(-1).skillGroups.length);
  assert.notEqual(get("files-panel")?.open, true);
  get("baseline").value = "2";
  get("baseline").listeners.change();
  get("target").value = "3";
  get("target").listeners.change();
  assert.equal(get("skill-groups").children.length, revisions[3].skillGroups.length);
  const expected = compareRevisions(revisions[2], revisions[3]);
  assert.match(get("compare-tokens").textContent, new RegExp(String(expected.deltaTokens)));
  assert.equal(get("compare-components").children.length, expected.components.length);
  // Providers and categories that did not move are left out of the comparison.
  assert.equal(
    get("compare-categories").children.length,
    expected.byCategory.filter((group) => group.deltaFiles || group.deltaTokens).length || 1,
  );
  assert.equal(get("slider").value, 3);
  // Instruction age: one bar per charted revision, a legend entry per period present, and the text kept from the baseline.
  const ages = instructionAges(report);
  const ageStart = ages.bytes.findIndex((amount) => amount > 0);
  assert.equal(get("age-panel").hidden, ageStart < 0);
  if (ageStart >= 0) {
    const periods = instructionAgePeriods(report);
    assert.equal(get("age-chart").children.length, Math.min(100, ages.bytes.length - ageStart));
    const presentPeriods = new Set(ages.at(3).map((cohort) => periods.periodOf.get(cohort.from)));
    assert.equal(get("age-legend").children.length, presentPeriods.size);
    assert.ok(get("age-legend").children.every((entry) => /%$/.test(entry.children.at(-1).textContent)));
    assert.match(
      get("age-count").textContent,
      ages.bytes[3] ? /^half added by \d{4}-\d{2}-\d{2} · / : /no instruction text/,
    );
    const kept = (from, to) =>
      sharePercent(
        ages.at(to).reduce((sum, cohort) => sum + (cohort.from <= from ? cohort.bytes : 0), 0) / ages.bytes[from],
      );
    assert.equal(get("compare-kept-wrap").hidden, !ages.bytes[2]);
    // The share is the headline; the bytes it is a share of are named under it.
    if (ages.bytes[2]) {
      assert.equal(get("compare-kept").textContent, kept(2, 3));
      assert.equal(
        get("compare-kept-bytes").textContent,
        `of ${new Intl.NumberFormat().format(ages.bytes[2])} bytes of instruction text`,
      );
    }
    assert.equal(get("compare-kept-label").textContent, "Instruction text kept");
    // A baseline after the target has nothing to keep.
    get("baseline").value = "4";
    get("baseline").listeners.change();
    assert.equal(get("compare-kept-wrap").hidden, true);
    // "Previous revision" compares with the revision just before the target.
    get("baseline").value = "previous";
    get("baseline").listeners.change();
    assert.equal(get("compare-span").hidden, true);
    get("target").value = "4";
    get("target").listeners.change();
    assert.equal(get("compare-kept-wrap").hidden, !ages.bytes[3]);
    if (ages.bytes[3]) assert.equal(get("compare-kept").textContent, kept(3, 4));
    // A bar selects the last revision it covers, like the history chart.
    get("age-chart").children[0].listeners.click();
    const firstBucket = timelineBuckets(ages.bytes.length, 100, ageStart)[0];
    assert.equal(get("target").value, String(firstBucket.end));
    get("baseline").value = "2";
    get("baseline").listeners.change();
    get("target").value = "3";
    get("target").listeners.change();
  }
  // Rectangles of files this revision added or edited are outlined; removed and source-only files have none.
  const sized = revisions[3].changes.filter(
    (change) => change.component !== null && report.components[change.component].estimatedTokens > 0,
  );
  const outlined = get("treemap").children.filter((child) => child.classes.has("changed"));
  assert.equal(outlined.length, sized.length);
  assert.equal(
    outlined.filter((child) => child.classes.has("edited")).length,
    sized.filter((change) => change.kind !== "added").length,
  );
  if (sized.length) {
    outlined[0].listeners.focus();
    assert.match(get("treemap-hover").textContent, / at this revision/);
    assert.match(get("treemap-hover").textContent, / at this revision/);
  }
  const chartStart = Math.max(
    0,
    revisions.findIndex((revision) => revision.components.length),
  );
  assert.equal(get("chart").children.length, Math.min(100, revisions.length - chartStart));
  assert.equal(get("slider").min, chartStart);
  get("provider-filter").value = "claude";
  get("provider-filter").listeners.change();
  const claudeFiles = revisions[3].components.filter((component) => component.provider === "claude").length;
  assert.equal(get("files").children.length, claudeFiles);
  get("target").value = "4";
  get("target").listeners.change();
  assert.equal(get("provider-filter").value, "claude");
  assert.equal(
    get("files").children.length,
    revisions[4].components.filter((component) => component.provider === "claude").length,
  );
  const fullTokens = get("tokens").textContent;
  get("path-search").value = "does-not-exist";
  get("path-search").listeners.input();
  assert.equal(get("files").children.length, 1);
  assert.equal(get("files").children[0].children[0].textContent, "No files match these filters.");
  assert.match(get("inventory-count").textContent, /Showing 0 of/);
  assert.equal(get("tokens").textContent, fullTokens);
  get("clear-filters").listeners.click();
  assert.equal(get("files").children.length, revisions[4].components.length);
  assert.equal(get("provider-filter").value, "");
  assert.equal(get("path-search").value, "");
  assert.equal(get("path-search").focused, true);
  const firstLeaf = get("treemap").children.find((child) => child.className === "treemap-leaf");
  assert.ok(firstLeaf);
  assert.equal(firstLeaf.title, undefined);
  assert.match(firstLeaf.style.color, /^#(ffffff|10140f)$/);
  firstLeaf.listeners.mouseenter();
  assert.match(get("treemap-hover").textContent, /stored-text tokens/);
  firstLeaf.listeners.mouseleave();
  assert.match(get("treemap-hover").textContent, /source-only/);
  firstLeaf.listeners.click();
  // The path filter is a substring search, so CLAUDE.md also lists .claude/CLAUDE.md.
  assert.equal(get("files-panel").open, true);
  const located = get("files").children.filter((row) => row.scrolled);
  assert.equal(located.length, 1);
  assert.equal(located[0].focused, true);
  assert.ok(get("files").children.length <= 2);
  assert.match(get("treemap-hover").textContent, /source-only/);
  // A provider tab opens on that provider's own counts when the report has them; the switch returns to the estimate.
  const openOnEstimate = (provider) => {
    const measured = report.providerMeasurements?.find(
      (entry) => entry.provider === provider && entry.accuracy !== "estimate",
    );
    assert.equal(get("measure-switch").hidden, !measured);
    if (!measured) return;
    assert.equal(
      get("tokens").textContent,
      new Intl.NumberFormat().format(report.revisions[4].providerTokenTotals[provider] ?? 0),
    );
    assert.match(get("tokens-label").textContent, new RegExp(`^${provider[0].toUpperCase()}${provider.slice(1)} `));
    assert.ok(get("counting-rows").children.some((row) => row.title.includes(measured.model)));
    get("measure-switch")
      .children.find((child) => child.textContent === "Byte estimate")
      .listeners.click();
    assert.match(get("tokens-label").textContent, /^(Estimated|Encoding) tokens$/);
  };
  const claudeTab = get("provider-tabs").children.find((child) => child.textContent === "Claude + shared");
  assert.ok(claudeTab);
  claudeTab.listeners.click();
  openOnEstimate("claude");
  // The value axis follows the view's own scale.
  assert.deepEqual(
    tickLabels(),
    expectedTicks(
      revisions.map(
        (revision, index) => viewRevision(revision, "claude", revisions[index - 1], report.components).estimatedTokens,
      ),
    ),
  );
  // Kept text covers all files, and says so outside the All files view.
  assert.equal(get("compare-kept-label").textContent, "Instruction text kept (all files)");
  const claudeView = viewRevision(revisions[4], "claude", revisions[3]);
  assert.equal(get("tokens").textContent, new Intl.NumberFormat().format(claudeView.estimatedTokens));
  assert.equal(get("components").textContent, new Intl.NumberFormat().format(claudeView.components.length));
  assert.equal(get("files").children.length, claudeView.components.length);
  assert.equal(get("path-search").value, "");
  assert.match(get("view-note").textContent, /Shared files can appear in more than one provider view/);
  const codexTab = get("provider-tabs").children.find((child) => child.textContent === "Codex + shared");
  assert.ok(codexTab);
  codexTab.listeners.click();
  openOnEstimate("codex");
  const codexView = viewRevision(revisions[4], "codex", revisions[3]);
  assert.equal(get("tokens").textContent, new Intl.NumberFormat().format(codexView.estimatedTokens));
  assert.equal(get("files").children.length, codexView.components.length);
  const geminiTab = get("provider-tabs").children.find((child) => child.textContent === "Gemini + shared");
  assert.ok(geminiTab);
  geminiTab.listeners.click();
  openOnEstimate("gemini");
  const geminiView = viewRevision(revisions[4], "gemini", revisions[3]);
  assert.equal(get("tokens").textContent, new Intl.NumberFormat().format(geminiView.estimatedTokens));
  assert.equal(get("files").children.length, geminiView.components.length);
  const allTab = get("provider-tabs").children.find((child) => child.textContent === "All files");
  allTab.listeners.click();
  assert.equal(get("tokens").textContent, new Intl.NumberFormat().format(revisions[4].estimatedTokens));
  // Dragging the slider updates the summary at once and the file table once it settles.
  assert.notEqual(revisions[2].components, revisions[4].components);
  get("slider").value = "2";
  get("slider").listeners.input();
  assert.equal(get("tokens").textContent, new Intl.NumberFormat().format(revisions[2].estimatedTokens));
  assert.equal(get("files").children.length, revisions[4].components.length);
  const comparedRows = get("compare-components").children.length;
  assert.equal(timers.size, 1);
  for (const run of timers.values()) run();
  assert.equal(get("files").children.length, revisions[2].components.length);
  assert.equal(
    get("compare-components").children.length,
    compareRevisions(revisions[2], revisions[2]).components.length || 1,
  );
  assert.notEqual(get("compare-components").children.length, comparedRows);
  get("slider").value = "3";
  get("slider").listeners.input();
  get("slider").listeners.change();
  assert.equal(get("files").children.length, revisions[3].components.length);
  layout.crampedLabels = true;
  get("target").value = "4";
  get("target").listeners.change();
  const fittedLeaf = get("treemap").children.find(
    (child) => child.className === "treemap-leaf" && child.children.length === 2,
  );
  assert.ok(fittedLeaf);
  assert.equal(fittedLeaf.children[0].hidden, false);
  assert.equal(fittedLeaf.children[1].hidden, true);
  return get;
}
