import assert from "node:assert/strict";
import test from "node:test";
import { analyzeRepository } from "../dist/analyze.js";
import { expandRevisions } from "../dist/expand.js";
import { renderHtml } from "../dist/report.js";
import { timelineDateTicks, timelineScale } from "../dist/timeline.js";
import { loadReportUi, previousChange, selectOptions } from "./report-ui.mjs";
import { syntheticRepo } from "./synthetic-repo.mjs";

const day = 24 * 60 * 60 * 1000;

/** A short real history padded to 161 revisions every four days; every other padded revision repeats the last change. */
async function longHistory() {
  const { repo, put, commit, cleanup } = syntheticRepo("strata-timeline-ui-");
  try {
    put("CLAUDE.md", "Claude instructions.\n");
    commit("claude", { date: "2024-01-02T12:00:00Z" });
    put("AGENTS.md", `${"Shared instructions. ".repeat(40)}\n`);
    commit("agents", { date: "2024-01-20T12:00:00Z" });
    put("CLAUDE.md", `${"More Claude instructions. ".repeat(200)}\n`);
    commit("more claude", { date: "2024-02-10T12:00:00Z" });
    const report = await analyzeRepository(repo);
    // Line ages refer to revisions by index, so the padded history leaves them out.
    const real = report.revisions.map(({ lineAge: _lineAge, ...revision }) => revision);
    const last = real.at(-1);
    const padded = Array.from({ length: 158 }, (_, index) => ({
      ...last,
      id: index.toString(16).padStart(40, "0"),
      date: new Date(Date.parse("2024-03-01T12:00:00Z") + index * 4 * day).toISOString(),
      changes: index % 2 ? [] : last.changes,
    }));
    return { ...report, revisions: [...real, ...padded] };
  } finally {
    cleanup();
  }
}

test("the history chart labels its axes, says when bars group revisions, and shows a hover card", async () => {
  const report = await longHistory();
  const revisions = expandRevisions(report);
  const { get } = loadReportUi(renderHtml(report));
  const chart = get("chart");
  assert.equal(chart.children.length, 100);
  assert.equal(get("chart-steps").hidden, false);
  assert.equal(
    get("chart-steps").textContent,
    "161 revisions shown as 100 steps; each step shows the last revision in its group.",
  );

  // Round y-axis steps in the SVG image's compact style, the top one at the top of the plot.
  const ticks = get("chart-ticks").children;
  const largest = Math.max(...revisions.map((revision) => revision.estimatedTokens));
  assert.ok(largest > 1000);
  assert.deepEqual(
    ticks.map((tick) => tick.children[0].textContent),
    timelineScale(largest).ticks.map((value) =>
      new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value),
    ),
  );
  assert.ok(ticks.every((tick) => /^\d+(\.\d)?K?$/.test(tick.children[0].textContent)));
  assert.equal(ticks[0].style.bottom, "0.0px");
  assert.equal(ticks.at(-1).style.bottom, "210.0px");
  // A bar's stack is drawn on the same scale as the ticks.
  const top = timelineScale(largest).top;
  assert.equal(chart.children.at(-1).children[0].style.height, `${(revisions.at(-1).estimatedTokens / top) * 210}px`);

  // Two to four calendar labels between the end dates, in order, apart, and one marked for narrow screens.
  const dates = get("timeline-dates").children;
  assert.ok(dates.length >= 2 && dates.length <= 4, `${dates.length} date labels`);
  assert.ok(dates.every((label) => /^\d{4}(-\d{2})?$/.test(label.textContent)));
  const positions = dates.map((label) => Number.parseFloat(label.style.left));
  assert.ok(positions.every((at, index) => at >= 12 && at <= 88 && (!index || at - positions[index - 1] >= 12)));
  assert.equal(dates.filter((label) => label.className === "primary").length, 1);

  // The hover card names the revisions, the date shown, and the tokens per category, top layer first.
  const tip = get("chart-tip");
  assert.equal(tip.hidden, true);
  const bar = chart.children.find((child) => child.getAttribute("aria-label").startsWith("Revisions "));
  chart.listeners.pointermove({ target: bar.children[0], clientX: 300 });
  assert.equal(tip.hidden, false);
  assert.match(tip.children[0].textContent, /^Revisions \d+–\d+$/);
  assert.match(tip.children[1].textContent, /^\d{4}-\d{2}-\d{2} · the last of these \d+$/);
  const total = tip.children.at(-1);
  assert.equal(total.textContent, "Total estimated tokens");
  assert.equal(total.children.at(-1).textContent, new Intl.NumberFormat().format(revisions.at(-1).estimatedTokens));
  assert.ok(tip.children.slice(2, -1).every((row) => row.className === "history-tip-row"));
  assert.match(
    bar.getAttribute("aria-label"),
    /^Revisions \d+–\d+ · \d{4}-\d{2}-\d{2} · [\d,]+ estimated tokens at the last one$/,
  );
  assert.equal(bar.title, undefined);
  chart.listeners.pointerleave();
  assert.equal(tip.hidden, true);
  chart.listeners.focusin({ target: bar });
  assert.equal(tip.hidden, false);
  chart.listeners.focusout();
  assert.equal(tip.hidden, true);

  // A provider tab redraws the axis on that view's scale.
  const before = get("chart-ticks").children;
  get("provider-tabs")
    .children.find((tab) => tab.textContent === "Codex + shared")
    .listeners.click();
  assert.notEqual(get("chart-ticks").children, before);
  assert.notDeepEqual(
    get("chart-ticks").children.map((tick) => tick.children[0].textContent),
    before.map((tick) => tick.children[0].textContent),
  );
});

test("the comparison selects list changed revisions by month and default to the previous change", async () => {
  const report = await longHistory();
  const revisions = expandRevisions(report);
  const { get } = loadReportUi(renderHtml(report));
  // Three real revisions, the 79 padded ones that repeat a change, and the latest.
  const listed = revisions.flatMap((revision, index) =>
    !index || index === revisions.length - 1 || revision.changes.length ? [String(index)] : [],
  );
  assert.equal(listed.length, 83);
  for (const id of ["baseline", "target"]) {
    const groups = get(id).children.filter((child) => child.tag === "optgroup");
    assert.deepEqual(
      groups.map((group) => group.label),
      [...new Set(revisions.filter((_, index) => listed.includes(String(index))).map((r) => r.date.slice(0, 7)))],
    );
    assert.ok(
      groups.every((group) =>
        group.children.every((option) => revisions[Number(option.value)].date.startsWith(group.label)),
      ),
    );
  }
  assert.deepEqual(
    selectOptions(get("baseline")).map((option) => option.value),
    ["change", "previous", ...listed],
  );
  assert.deepEqual(
    get("baseline")
      .children.slice(0, 2)
      .map((option) => option.textContent),
    ["Previous change", "Previous revision"],
  );
  assert.deepEqual(
    selectOptions(get("target")).map((option) => option.value),
    listed,
  );

  // The latest revision changed nothing; the baseline is the revision before the latest change, marked on the chart.
  assert.equal(get("baseline").value, "change");
  const from = previousChange(revisions, 160);
  assert.equal(from, 158);
  assert.equal(
    get("compare-span").textContent,
    `Previous change: revision 160 · ${revisions[159].date.slice(0, 10)}, compared with revision 159 before it.`,
  );
  assert.equal(get("chart").children.filter((bar) => bar.classes.has("baseline")).length, 1);

  // At a revision that changed something, the previous change is the revision just before it.
  get("target").value = "2";
  get("target").listeners.change();
  assert.equal(
    get("compare-span").textContent,
    `Previous change: revision 3 · ${revisions[2].date.slice(0, 10)}, the target, compared with revision 2 before it.`,
  );
  assert.match(get("compare-tokens").textContent, /^\+/);
  // The first revision compares with the empty history.
  get("target").value = "0";
  get("target").listeners.change();
  assert.match(
    get("compare-span").textContent,
    /^Previous change: revision 1 · .*, compared with the empty history before it\.$/,
  );

  // "Previous revision" is the literal one before, which here changed nothing.
  get("target").value = "4";
  get("target").listeners.change();
  get("baseline").value = "previous";
  get("baseline").listeners.change();
  assert.equal(get("compare-span").hidden, true);
  assert.equal(
    get("compare-components").children[0].children[0].textContent,
    "No component changes between these revisions.",
  );
});

test("timeline scales and calendar labels stay round and apart", () => {
  assert.deepEqual(timelineScale(0), { top: 1, ticks: [0, 1] });
  assert.deepEqual(timelineScale(3), { top: 3, ticks: [0, 1, 2, 3] });
  assert.deepEqual(timelineScale(1000), { top: 1000, ticks: [0, 250, 500, 750, 1000] });
  assert.deepEqual(timelineScale(1100), { top: 1500, ticks: [0, 500, 1000, 1500] });
  assert.deepEqual(timelineScale(52_000), { top: 60_000, ticks: [0, 20_000, 40_000, 60_000] });
  for (const max of [7, 99, 101, 2_501, 13_362, 987_654]) {
    const { top, ticks } = timelineScale(max);
    assert.ok(top >= max && ticks.length >= 3 && ticks.length <= 5, `${max}: ${ticks}`);
    assert.equal(ticks.at(-1), top);
  }

  // A year of weekly bars is labeled by quarter, not month; years are labeled by year.
  const weekly = Array.from({ length: 52 }, (_, index) =>
    new Date(Date.UTC(2025, 0, 6) + index * 7 * day).toISOString(),
  );
  assert.deepEqual(
    timelineDateTicks(weekly).map((tick) => tick.label),
    ["2025-04", "2025-07", "2025-10"],
  );
  const yearly = Array.from({ length: 100 }, (_, index) =>
    new Date(Date.UTC(2018, 0, 1) + index * 22 * day).toISOString(),
  );
  const labels = timelineDateTicks(yearly);
  assert.ok(labels.length >= 2 && labels.length <= 4);
  assert.ok(labels.every((tick) => /^\d{4}(-\d{2})?$/.test(tick.label)));
  assert.ok(labels.filter((tick) => tick.primary).length <= 1);
  // Boundaries crowded into a few bars, or next to the end dates, are dropped.
  const crowded = [
    "2020-01-01",
    "2021-01-01",
    "2022-01-01",
    "2023-01-01",
    ...Array.from({ length: 20 }, () => "2023-06-01"),
  ];
  const kept = timelineDateTicks(crowded);
  assert.ok(kept.every((tick, index) => !index || (tick.at - kept[index - 1].at) / crowded.length >= 0.12));
  assert.ok(kept.every((tick) => tick.at / crowded.length >= 0.12));
  // Nothing to label inside one month.
  assert.deepEqual(timelineDateTicks(["2025-03-01", "2025-03-09", "2025-03-20"]), []);
});
