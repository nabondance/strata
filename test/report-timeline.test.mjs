import assert from "node:assert/strict";
import test from "node:test";
import { analyzeRepository } from "../dist/analyze.js";
import { expandRevisions } from "../dist/expand.js";
import { renderHtml } from "../dist/report.js";
import {
  timelineBuckets,
  timelineDateTicks,
  timelineEdges,
  timelineRevision,
  timelineScale,
  timelineSpan,
  timelineStepsNote,
  timelineTimeBars,
  timelineZoom,
} from "../dist/timeline.js";
import { loadReportUi, previousChange, selectOptions } from "./report-ui.mjs";
import { syntheticRepo } from "./synthetic-repo.mjs";

const day = 24 * 60 * 60 * 1000;

/**
 * A short real history padded to 161 revisions every four days; every other padded revision repeats the last change.
 * The padded totals grow by 3 tokens a revision from the last real one, and every other one rises 200 more and falls
 * back, so there are more changes than bars and some merged bars hide a higher total.
 */
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
    const padded = Array.from({ length: 158 }, (_, index) => {
      const extra = index * 3 + (index % 2 ? 200 : 0);
      const instructions = last.categoryTotals.instructions;
      return {
        ...last,
        id: index.toString(16).padStart(40, "0"),
        date: new Date(Date.parse("2024-03-01T12:00:00Z") + index * 4 * day).toISOString(),
        changes: index % 2 ? [] : last.changes,
        categoryTotals: {
          ...last.categoryTotals,
          instructions: { ...instructions, estimatedTokens: instructions.estimatedTokens + extra },
        },
        estimatedTokens: last.estimatedTokens + extra,
      };
    });
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
  const buckets = timelineBuckets(
    revisions.map((revision) => Object.values(revision.categoryTotals).map((total) => total.estimatedTokens)),
  );
  assert.equal(buckets.length, 100);
  assert.equal(get("chart-steps").hidden, false);
  assert.equal(
    get("chart-steps").textContent,
    "161 revisions and 160 changes shown as 100 steps, merging the most alike neighbors; each step shows the last revision in its group. A dashed line marks a higher total inside a step.",
  );
  assert.equal(get("chart-steps").textContent, timelineStepsNote(161, buckets, true));
  // The masthead does not group: it draws a step for each of the 160 changes, two points each between the corners.
  const silhouetteLayer = get("silhouette").children[0];
  assert.equal(silhouetteLayer.style.clipPath.split(",").length, 2 * 160 + 2);
  // A merged bar that hides a higher total draws a dashed line at it, on the bars' scale.
  const peaked = buckets.findIndex((bucket) => bucket.peak > revisions[bucket.end].estimatedTokens);
  assert.ok(peaked >= 0);
  const peakLine = chart.children[peaked].children.find((child) => child.className === "peak");
  const scaleTop = timelineScale(Math.max(...revisions.map((revision) => revision.estimatedTokens))).top;
  assert.equal(peakLine.style.bottom, `${((buckets[peaked].peak / scaleTop) * 210).toFixed(1)}px`);
  assert.equal(
    chart.children.filter((bar) => bar.children.some((child) => child.className === "peak")).length,
    buckets.filter((bucket) => bucket.peak > revisions[bucket.end].estimatedTokens).length,
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
  const barIndex = buckets.findIndex(
    (bucket) => bucket.changes > 1 && bucket.peak > revisions[bucket.end].estimatedTokens,
  );
  const bar = chart.children[barIndex];
  const shown = revisions[buckets[barIndex].end];
  chart.listeners.pointermove({ target: bar.children[0], clientX: 300 });
  assert.equal(tip.hidden, false);
  // Moving within the same bar only moves the card; another bar refills it.
  const rows = tip.children;
  chart.listeners.pointermove({ target: bar, clientX: 310 });
  assert.equal(tip.children, rows);
  const next = chart.children[chart.children.indexOf(bar) + 1];
  chart.listeners.pointermove({ target: next, clientX: 320 });
  assert.notEqual(tip.children, rows);
  chart.listeners.pointermove({ target: bar, clientX: 300 });
  assert.match(tip.children[0].textContent, /^Revisions \d+–\d+$/);
  assert.match(tip.children[1].textContent, /^\d{4}-\d{2}-\d{2} · the last of these \d+$/);
  // A merged bar counts its changes and gives the highest total it hides, after the total it shows.
  assert.equal(tip.children[2].textContent, `${buckets[barIndex].changes} changes in these revisions`);
  const total = tip.children.at(-2);
  assert.equal(total.textContent, "Total estimated tokens");
  assert.equal(total.children.at(-1).textContent, new Intl.NumberFormat().format(shown.estimatedTokens));
  const highest = tip.children.at(-1);
  assert.equal(highest.textContent, "Highest in these revisions");
  assert.equal(highest.children.at(-1).textContent, new Intl.NumberFormat().format(buckets[barIndex].peak));
  assert.ok(tip.children.slice(3, -2).every((row) => row.className === "history-tip-row"));
  assert.match(
    bar.getAttribute("aria-label"),
    /^Revisions \d+–\d+ · \d{4}-\d{2}-\d{2} · [\d,]+ estimated tokens at the last one, up to [\d,]+ in these revisions$/,
  );
  assert.equal(bar.title, undefined);
  chart.listeners.pointerleave();
  assert.equal(tip.hidden, true);
  chart.listeners.focusin({ target: bar });
  assert.equal(tip.hidden, false);
  chart.listeners.focusout();
  assert.equal(tip.hidden, true);

  // By time, each bar is as wide as the time until the next one, with no gap; Change goes back to equal widths.
  const spacing = get("chart-spacing").children.filter(
    (child) => child.tagName === "BUTTON" || child.type === "button",
  );
  assert.deepEqual(
    spacing.map((button) => [button.textContent, button.getAttribute("aria-pressed")]),
    [
      ["Change", "true"],
      ["Time", "false"],
    ],
  );
  spacing[1].listeners.click();
  assert.equal(chart.classes.has("by-time"), true);
  // By time there is no cap: the 160 changes fall on different days, so each keeps its own bar.
  const time = (index) => Date.parse(revisions[index].date);
  const changes = timelineBuckets(
    revisions.map((revision) => Object.values(revision.categoryTotals).map((total) => total.estimatedTokens)),
    revisions.length,
  );
  const { buckets: timeBuckets, widths: timeWidths } = timelineTimeBars(
    changes,
    changes.map((bucket) => revisions[bucket.start].date),
    time(revisions.length - 1),
  );
  assert.equal(timeBuckets.length, 160);
  assert.equal(chart.children.length, 160);
  const columns = chart.style.gridTemplateColumns.split(") ").map((column) => Number.parseFloat(column.split(", ")[1]));
  assert.equal(columns.length, 160);
  // Each bar is as wide as the time until the next one; the last is at least as wide as an average bar.
  const elapsed = time(revisions.length - 1) - time(timeBuckets[0].start);
  assert.equal(
    timeWidths.at(-1),
    Math.max(time(revisions.length - 1) - time(timeBuckets.at(-1).start), elapsed / timeWidths.length),
  );
  const span = timeWidths.reduce((sum, width) => sum + width, 0);
  const expectedWidth = (timeWidths[0] / span) * 1000;
  assert.ok(Math.abs(columns[0] - expectedWidth) < 0.01, `${columns[0]} vs ${expectedWidth}`);
  assert.ok(Math.abs(columns.at(-1) - (timeWidths.at(-1) / span) * 1000) < 0.01);
  assert.ok(columns.at(-1) >= (elapsed / columns.length / span) * 1000 - 0.01);
  assert.equal(get("chart-steps").textContent, "One bar per change, as wide as the time until the next one.");
  // The widened last bar adds width, not time: no calendar label falls after the latest revision.
  const latestMonth = revisions.at(-1).date.slice(0, 7);
  for (const label of get("timeline-dates").children) assert.ok(label.textContent <= latestMonth, label.textContent);
  // The slider follows the bars by time: its position for a bar's last revision lies inside that bar's time span.
  const timeEdges = timelineEdges(timeBuckets.length, timeWidths);
  const probe = timeBuckets[50];
  get("target").value = String(probe.end);
  get("target").listeners.change();
  const position = Number(get("slider").value) / 10000;
  assert.ok(position >= timeEdges[50][0] && position <= timeEdges[50][1], `${position} vs ${timeEdges[50]}`);
  // Its arrow keys step one revision at a time; Page Up moves a bar.
  get("slider").listeners.keydown({ key: "ArrowLeft", preventDefault() {} });
  assert.equal(get("target").value, String(probe.end - 1));
  get("slider").listeners.keydown({ key: "PageUp", preventDefault() {} });
  assert.equal(get("target").value, String(probe.end));
  const bySpacing = get("chart-spacing").children.filter((child) => child.type === "button");
  assert.equal(bySpacing[1].getAttribute("aria-pressed"), "true");
  bySpacing[0].listeners.click();
  assert.equal(chart.classes.has("by-time"), false);
  assert.equal(chart.style.gridTemplateColumns, "repeat(100, minmax(0, 1fr))");

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

test("spaced by time, every change keeps its own bar, and only a rebased one joins the bar before it", async () => {
  const report = await longHistory();
  // Pairs of padded revisions share a day, the higher one first, and one is dated a day before the revision it follows (a rebase).
  const hour = 60 * 60 * 1000;
  report.revisions = report.revisions.map((revision, index) => {
    if (index < 3) return revision;
    const padded = index - 3;
    const shift = padded === 41 ? -5 * day : Math.floor((padded + 1) / 2) * 4 * day + ((padded + 1) % 2) * hour;
    return { ...revision, date: new Date(Date.parse("2024-03-01T12:00:00Z") + shift).toISOString() };
  });
  const revisions = expandRevisions(report);
  const { get } = loadReportUi(renderHtml(report));
  const chart = get("chart");
  get("chart-spacing")
    .children.find((child) => child.textContent === "Time")
    .listeners.click();
  const changes = timelineBuckets(
    revisions.map((revision) => Object.values(revision.categoryTotals).map((total) => total.estimatedTokens)),
    revisions.length,
  );
  const bars = timelineTimeBars(
    changes,
    changes.map((bucket) => revisions[bucket.start].date),
    Date.parse(revisions.at(-1).date),
  );
  // Changes an hour apart keep their own bars; only the rebased one joins the bar before it.
  assert.equal(bars.buckets.length, changes.length - 1);
  assert.equal(chart.children.length, bars.buckets.length);
  // Bars have no minimum width, so their columns match the edges the slider uses; the rebased revision joins the bar
  // before it rather than leaving that bar with no width.
  const columns = chart.style.gridTemplateColumns.split(") ");
  assert.ok(columns.every((column) => column.startsWith("minmax(0, ") && Number.parseFloat(column.slice(10)) > 0));
  assert.match(get("chart-steps").textContent, /; 1 change dated out of order shares the bar before it\./);
  // The merged bar shows its last revision, counts its changes, and marks a higher total inside it when it hides one.
  assert.equal(bars.buckets.filter((bucket) => bucket.changes > 1).length, 1);
  const merged = bars.buckets.findIndex((bucket) => bucket.changes > 1);
  const bar = chart.children[merged];
  assert.equal(
    bar.children.some((child) => child.className === "peak"),
    bars.buckets[merged].peak > revisions[bars.buckets[merged].end].estimatedTokens,
  );
  chart.listeners.pointermove({ target: bar, clientX: 300 });
  assert.equal(get("chart-tip").children[2].textContent, `${bars.buckets[merged].changes} changes in these revisions`);
  // Page Up and Page Down move a bar at a time; only the selected bar is a tab stop.
  get("target").value = String(bars.buckets[merged].end);
  get("target").listeners.change();
  get("slider").listeners.keydown({ key: "PageUp", preventDefault() {} });
  assert.equal(get("target").value, String(bars.buckets[merged + 1].end));
  get("slider").listeners.keydown({ key: "PageDown", preventDefault() {} });
  get("slider").listeners.keydown({ key: "PageDown", preventDefault() {} });
  assert.equal(get("target").value, String(bars.buckets[merged - 1].end));
  const stops = chart.children.filter((child) => child.tabIndex === 0);
  assert.deepEqual(stops, [chart.children[merged - 1]]);
  assert.equal(chart.children[merged - 1].classes.has("selected"), true);
  assert.equal(chart.children.filter((child) => child.classes.has("selected")).length, 1);
});

test("dragging across the history chart zooms into the bars under it, and Show all or Escape goes back", async () => {
  const report = await longHistory();
  const revisions = expandRevisions(report);
  const { get, timers } = loadReportUi(renderHtml(report));
  const chart = get("chart");
  const zoomControl = () => get("chart-spacing").children.find((child) => child.className === "chart-zoom");
  const drag = (from, to, pointerId = 1) => {
    chart.listeners.pointerdown({ button: 0, clientX: from, pointerId });
    chart.listeners.pointermove({ clientX: to, pointerId, target: chart });
    const band = !get("chart-brush").hidden;
    chart.listeners.pointerup({ clientX: to, pointerId });
    return band;
  };
  const runTimers = () => {
    for (const [id, run] of [...timers]) {
      timers.delete(id);
      run();
    }
  };
  get("chart-spacing")
    .children.find((child) => child.textContent === "Time")
    .listeners.click();
  assert.equal(zoomControl().textContent, "Drag across the chart to zoom in");
  const whole = chart.children.length;
  const values = revisions.map((revision) =>
    Object.values(revision.categoryTotals).map((total) => total.estimatedTokens),
  );
  const changes = timelineBuckets(values, revisions.length);
  const bars = timelineTimeBars(
    changes,
    changes.map((bucket) => revisions[bucket.start].date),
    Date.parse(revisions.at(-1).date),
  );
  assert.equal(whole, bars.buckets.length);
  const range = timelineZoom(bars.buckets, timelineEdges(bars.buckets.length, bars.widths), 0.5, 0.75);

  // A band follows the drag; on release the chart shows whole bars under it, and the axis dates are theirs.
  assert.equal(drag(500, 750), true);
  assert.equal(get("chart-brush").hidden, true);
  const shown = bars.buckets.filter((bucket) => bucket.start >= range.start && bucket.end <= range.end).length;
  assert.equal(chart.children.length, shown);
  assert.ok(shown < whole / 2, `${shown}`);
  assert.equal(get("timeline-start").textContent, revisions[range.start].date.slice(0, 10));
  assert.equal(get("timeline-end").textContent, revisions[range.end].date.slice(0, 10));
  // Each revision in the range is its own bar here, and none is dated out of order.
  assert.equal(shown, range.end - range.start + 1);
  assert.equal(get("chart-steps").textContent, "One bar per change, as wide as the time until the next one.");
  // The latest revision is outside the range, so the range's last one is selected, and its bar takes the focus.
  assert.equal(get("target").value, String(range.end));
  assert.equal(chart.children.at(-1).classes.has("selected"), true);
  assert.equal(chart.children.at(-1).focused, true);
  // The click that ends a drag does not select a bar; a later click does.
  chart.children[0].listeners.click();
  assert.equal(get("target").value, String(range.end));
  runTimers();
  chart.children[0].listeners.click();
  assert.equal(get("target").value, String(bars.buckets.find((bucket) => bucket.start === range.start).end));

  // Escape, or the Show all button, shows the whole history again and keeps the selection.
  assert.equal(zoomControl().textContent, "Show all");
  const picked = get("target").value;
  chart.listeners.keydown({ key: "Escape", target: chart.children[0], preventDefault() {} });
  assert.equal(chart.children.length, whole);
  assert.equal(get("target").value, picked);
  assert.equal(zoomControl().textContent, "Drag across the chart to zoom in");
  runTimers();
  drag(500, 750);
  runTimers();
  zoomControl().listeners.click();
  assert.equal(chart.children.length, whole);

  // A short move is a click, not a drag; a drag over one change has nothing to zoom into.
  assert.equal(drag(500, 503), false);
  assert.equal(chart.children.length, whole);
  drag(999, 994);
  runTimers();
  assert.equal(chart.children.length, whole);

  // Zoomed in, picking a revision outside the range from the selects shows the whole history again.
  drag(500, 750);
  runTimers();
  get("target").value = "3";
  get("target").listeners.change();
  assert.equal(chart.children.length, whole);
  assert.equal(get("target").value, "3");

  // Spaced by change, the zoomed range gets its own 100 bars, so merged changes come apart.
  get("chart-spacing")
    .children.find((child) => child.textContent === "Change")
    .listeners.click();
  assert.equal(chart.children.length, 100);
  drag(0, 395);
  runTimers();
  // The drag covered 40 bars; their changes now each have one.
  assert.ok(chart.children.length > 40, `${chart.children.length}`);
  assert.match(get("chart-steps").textContent, /one per change/);
  // The other spacing lays the bars out differently, so switching it shows the whole history again.
  get("chart-spacing")
    .children.find((child) => child.textContent === "Time")
    .listeners.click();
  assert.equal(zoomControl().textContent, "Drag across the chart to zoom in");
  assert.equal(chart.children.length, whole);
  assert.equal(get("chart-overview").hidden, true);
});

test("zoomed in, an overview of the whole history shows the zoomed range, and moving its window pans the chart", async () => {
  const report = await longHistory();
  const revisions = expandRevisions(report);
  const { get, timers } = loadReportUi(renderHtml(report));
  const chart = get("chart");
  const strip = get("overview-strip");
  const win = get("overview-window");
  get("chart-spacing")
    .children.find((child) => child.textContent === "Time")
    .listeners.click();
  // The whole history needs no overview.
  assert.equal(get("chart-overview").hidden, true);
  const values = revisions.map((revision) =>
    Object.values(revision.categoryTotals).map((total) => total.estimatedTokens),
  );
  const changes = timelineBuckets(values, revisions.length);
  const bars = timelineTimeBars(
    changes,
    changes.map((bucket) => revisions[bucket.start].date),
    Date.parse(revisions.at(-1).date),
  );
  const edges = timelineEdges(bars.buckets.length, bars.widths);
  const total = bars.buckets.reduce((sum, bucket) => sum + bucket.changes, 0);
  const range = timelineZoom(bars.buckets, edges, 0.5, 0.75);
  chart.listeners.pointerdown({ button: 0, clientX: 500, pointerId: 1 });
  chart.listeners.pointermove({ clientX: 750, pointerId: 1, target: chart });
  chart.listeners.pointerup({ clientX: 750, pointerId: 1 });
  for (const [id, run] of [...timers]) {
    timers.delete(id);
    run();
  }

  // Zoomed in, the overview shows where the range sits in the whole history, and how much of it the chart shows.
  assert.equal(get("chart-overview").hidden, false);
  assert.ok(get("overview-plot").children.length > 0);
  const [from, to] = timelineSpan(bars.buckets, edges, range.start, range.end);
  assert.equal(win.style.left, `min(${(from * 100).toFixed(3)}%, calc(100% - 8px))`);
  assert.equal(win.style.width, `${((to - from) * 100).toFixed(3)}%`);
  assert.equal(get("overview-start").textContent, revisions[0].date.slice(0, 10));
  assert.equal(get("overview-end").textContent, revisions.at(-1).date.slice(0, 10));
  assert.equal(get("overview-note").textContent, `Zoomed in: ${chart.children.length} of ${total} changes`);
  assert.match(win.getAttribute("aria-label"), /Arrow keys move the range/);

  // Dragging the window to the left pans the chart to earlier revisions over the same share of the history.
  const pan = (down, up) => {
    strip.listeners.pointerdown({ button: 0, clientX: down, pointerId: 2 });
    strip.listeners.pointermove({ clientX: up, pointerId: 2 });
    strip.listeners.pointerup({ clientX: up, pointerId: 2 });
  };
  const middle = ((from + to) / 2) * 1000;
  pan(middle, middle - 200);
  const moved = [
    timelineRevision(bars.buckets, edges, from - 0.2 + 1e-9),
    timelineRevision(bars.buckets, edges, to - 0.2 - 1e-9),
  ];
  assert.equal(get("timeline-start").textContent, revisions[moved[0]].date.slice(0, 10));
  assert.equal(get("timeline-end").textContent, revisions[moved[1]].date.slice(0, 10));
  assert.equal(get("chart-overview").hidden, false);
  // The selection was after the range, so it moved to the range's last revision.
  assert.equal(get("target").value, String(moved[1]));

  // Pressing outside the window moves it there; a window past the left end stops at it.
  pan(0, 0);
  assert.equal(get("timeline-start").textContent, revisions[0].date.slice(0, 10));
  assert.ok(win.style.left.startsWith("min(0.000%"), win.style.left);

  // From the keyboard, End and Home move the range to either end, and Escape shows the whole history.
  const key = (name) => win.listeners.keydown({ key: name, preventDefault() {} });
  key("End");
  assert.equal(get("timeline-end").textContent, revisions.at(-1).date.slice(0, 10));
  assert.equal(win.focused, true);
  const start = get("timeline-start").textContent;
  key("ArrowLeft");
  assert.ok(get("timeline-start").textContent < start);
  key("Home");
  assert.equal(get("timeline-start").textContent, revisions[0].date.slice(0, 10));
  key("Escape");
  assert.equal(get("chart-overview").hidden, true);
  assert.equal(chart.children.length, bars.buckets.length);
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

  // A provider tab lists the revisions that changed its view and keeps the selected target. Codex reads only
  // AGENTS.md, which the second revision added, so the Claude edits and the padded repeats are not listed.
  get("target").value = "2";
  get("target").listeners.change();
  get("provider-tabs")
    .children.find((tab) => tab.textContent === "Codex + shared")
    .listeners.click();
  assert.deepEqual(
    selectOptions(get("baseline")).map((option) => option.value),
    ["change", "previous", "0", "1", "160"],
  );
  assert.deepEqual(
    selectOptions(get("target")).map((option) => option.value),
    ["2", "0", "1", "160"],
  );
  assert.equal(get("target").value, "2");
  assert.match(get("target").children[0].textContent, /^3 · .* · no change$/);
  assert.equal(
    get("compare-span").textContent,
    `Previous change: revision 2 · ${revisions[1].date.slice(0, 10)}, compared with revision 1 before it.`,
  );
  // A fixed baseline the view did not change stays listed, and the All files tab lists every change again.
  get("baseline").value = "3";
  get("baseline").listeners.change();
  get("provider-tabs")
    .children.find((tab) => tab.textContent === "Codex + shared")
    .listeners.click();
  assert.deepEqual(
    selectOptions(get("baseline")).map((option) => option.value),
    ["change", "previous", "0", "1", "3", "160"],
  );
  assert.match(selectOptions(get("baseline"))[4].textContent, / · no change$/);
  assert.equal(get("baseline").value, "3");
  get("provider-tabs")
    .children.find((tab) => tab.textContent === "All files")
    .listeners.click();
  assert.equal(selectOptions(get("target")).length, listed.length);
  get("baseline").value = "change";
  get("baseline").listeners.change();

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
  // One early bar with a late date, from clock skew or a rebase, does not hide the boundaries after it.
  const skewed = [
    "2024-06-05",
    ...Array.from({ length: 9 }, (_, index) => `2024-${String(index + 1).padStart(2, "0")}-01`),
  ];
  assert.deepEqual(
    timelineDateTicks(skewed).map((tick) => tick.label),
    ["2024-02", "2024-04", "2024-06", "2024-08"],
  );
  // Nothing to label inside one month.
  assert.deepEqual(timelineDateTicks(["2025-03-01", "2025-03-09", "2025-03-20"]), []);
});
