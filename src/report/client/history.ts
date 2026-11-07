/** The legend, the stacked history chart with its axes and hover card, and the slider. */
export const historyScript = `    function renderLegend() {
      const legend = $('legend');
      legend.replaceChildren();
      for (const category of categories) {
        if (!viewRevisions.some((revision) => revision.categoryTotals[category].count)) continue;
        const total = viewRevisions[selected].categoryTotals[category];
        const sourceOnly = total.count && total.count === total.sourceOnlyCount;
        const files = plural(total.count, 'file');
        // Source-only categories have no tokens and no area in the chart or treemap, so they give their
        // file count, draw a hollow swatch, and lead to their files instead.
        const label = text(sourceOnly ? 'button' : 'span', category, sourceOnly ? 'legend-link' : '');
        label.append(text('b', sourceOnly ? files : fmt(total.estimatedTokens)));
        const swatch = text('i', '', sourceOnly ? 'swatch hollow' : 'swatch');
        if (sourceOnly) {
          label.type = 'button';
          label.title = category + ': ' + files + ' measured in bytes, not tokens, so not drawn. Show in the file list.';
          label.setAttribute('aria-label', label.title);
          swatch.style.borderColor = colors[category];
          label.addEventListener('click', () => showCategoryFiles(category));
        } else {
          swatch.style.background = colors[category];
        }
        label.prepend(swatch);
        legend.append(label);
      }
    }

    function showCategoryFiles(category) {
      providerFilter = '';
      categoryFilter = category;
      pathSearch = '';
      $('provider-filter').value = '';
      $('category-filter').value = category;
      $('path-search').value = '';
      $('files-panel').open = true;
      renderInventory();
      $('files-panel').scrollIntoView({ block: 'start', behavior: 'smooth' });
    }

    // Axis labels in the SVG image's style: 20K, 1.5M.
    const compactFormat = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
    const bucketRange = (bucket) => bucket.start === bucket.end ? 'Revision ' + fmt(bucket.end + 1) : 'Revisions ' + fmt(bucket.start + 1) + '–' + fmt(bucket.end + 1);

    function renderChart() {
      const chart = $('chart');
      chart.replaceChildren();
      hideChartTip();
      fillRevisionSelects();
      chartBuckets = [];
      // Leading revisions with nothing tracked in this view would only flatten the chart.
      chartStart = Math.max(0, viewRevisions.findIndex((revision) => revision.components.length));
      // Zoomed in, the chart covers the revisions a drag picked; a view where they have nothing tracked shows all.
      if (chartZoom && Math.max(chartStart, chartZoom.start) >= Math.min(viewRevisions.length - 1, chartZoom.end)) chartZoom = null;
      const first = chartZoom ? Math.max(chartStart, chartZoom.start) : chartStart;
      const last = chartZoom ? Math.min(viewRevisions.length - 1, chartZoom.end) : viewRevisions.length - 1;
      chartRange = { start: first, end: last };
      const values = viewRevisions.map((revision) => categories.map((category) => revision.categoryTotals[category].estimatedTokens));
      renderChartSpacing();
      const { buckets, bars, byTime, t0, edges } = chartBars(values, first, last);
      const widths = bars?.widths;
      const span = widths ? widths.reduce((sum, width) => sum + width, 0) : 0;
      chart.classList.toggle('by-time', byTime);
      // Where each bar sits across the chart, so the slider can follow the bars in either spacing.
      chartEdges = edges;
      chart.style.gridTemplateColumns = byTime
        // No minimum width: a bar shorter than a pixel stays where its time puts it, so the bars, the slider, and the
        // date labels line up.
        ? widths.map((width) => 'minmax(0, ' + (width / span * 1000).toFixed(6) + 'fr)').join(' ')
        : 'repeat(' + buckets.length + ', minmax(0, 1fr))';
      const max = Math.max(1, ...viewRevisions.slice(first, last + 1).map((revision) => revision.estimatedTokens));
      // The scale covers every charted revision, not only the last of each step, and changes with the view, the measure,
      // and the zoom.
      const scale = timelineScale(max);
      $('chart-ticks').replaceChildren(...scale.ticks.map((value) => {
        const tick = text('span', '', 'history-tick');
        tick.style.bottom = (value / scale.top * 210).toFixed(1) + 'px';
        tick.append(text('span', compactFormat.format(value)));
        return tick;
      }));
      for (const bucket of buckets) {
        const revision = viewRevisions[bucket.end];
        const button = text('button', '', 'bar');
        button.type = 'button';
        // The hover card shows this at once, so a native title would only repeat it late.
        const higher = bucket.peak > revision.estimatedTokens;
        button.setAttribute('aria-label', bucketRange(bucket) + ' · ' + revision.date.slice(0, 10) + ' · ' + fmt(revision.estimatedTokens) + ' ' + inlineStat() + ' at ' + (bucket.start === bucket.end ? 'this revision' : 'the last one') + (higher ? ', up to ' + fmt(bucket.peak) + ' in these revisions' : ''));
        const stack = text('span', '', 'stack');
        stack.style.height = Math.max(2, revision.estimatedTokens / scale.top * 210) + 'px';
        for (const category of categories) {
          const amount = revision.categoryTotals[category].estimatedTokens;
          if (!amount) continue;
          const segment = text('span', '', 'segment');
          segment.style.height = amount / revision.estimatedTokens * 100 + '%';
          segment.style.background = colors[category];
          stack.append(segment);
        }
        button.append(stack);
        // A merged bar can hide a higher total; a dashed line marks it.
        if (higher) {
          const peak = text('span', '', 'peak');
          peak.style.bottom = (bucket.peak / scale.top * 210).toFixed(1) + 'px';
          button.append(peak);
        }
        // Safari does not focus a clicked button, and arrow keys need the focus on a bar.
        button.addEventListener('click', () => {
          if (chartDragged) return;
          render(bucket.end);
          button.focus();
        });
        chart.append(button);
        chartBuckets.push({ ...bucket, button });
      }
      // Calendar boundaries between the end dates; CSS keeps only the middle one on a narrow screen.
      // By time, the labels sit at their dates: one evenly spaced date per 0.5% of the width stands in for the bars.
      const tickDates = byTime
        ? Array.from({ length: 200 }, (_, index) => new Date(t0 + Math.min(bars.elapsed, (index / 200) * span)).toISOString())
        : buckets.map((bucket) => viewRevisions[bucket.end].date);
      $('timeline-dates').replaceChildren(...timelineDateTicks(tickDates).map((tick) => {
        const label = text('span', tick.label, tick.primary ? 'primary' : '');
        label.style.left = (tick.at / tickDates.length * 100).toFixed(2) + '%';
        return label;
      }));
      const charted = last - first + 1;
      const note = timelineStepsNote(charted, buckets, buckets.some((bucket) => bucket.peak > viewRevisions[bucket.end].estimatedTokens), fmt, byTime);
      $('chart-steps').hidden = !note;
      $('chart-steps').textContent = note;
      $('timeline-start').textContent = viewRevisions[first].date.slice(0, 10);
      $('timeline-end').textContent = viewRevisions[last].date.slice(0, 10);
      // The masthead keeps the whole history, on its own scale, and so does the overview under a zoomed chart.
      const wholeMax = Math.max(1, ...viewRevisions.map((revision) => revision.estimatedTokens));
      renderSilhouette(values, chartStart, wholeMax);
      renderOverview(values, wholeMax);
    }

    /**
     * The bars from one revision to another. A bar starts wherever the drawn layers change. Spaced by change, the most
     * alike neighbors merge when there are more than 100; spaced by time, each bar takes its own width, so every change
     * keeps its own bar.
     */
    function chartBars(values, first, last) {
      const t0 = Date.parse(viewRevisions[first].date);
      const t1 = Date.parse(viewRevisions[last].date);
      const byTime = chartSpacing === 'time' && t1 > t0;
      const charted = values.slice(0, last + 1);
      let buckets = timelineBuckets(charted, byTime ? charted.length : 100, first);
      const bars = byTime ? timelineTimeBars(buckets, buckets.map((bucket) => viewRevisions[bucket.start].date), t1) : undefined;
      if (bars) buckets = bars.buckets;
      return { buckets, bars, byTime, t0, edges: timelineEdges(buckets.length, bars?.widths) };
    }

    /**
     * Zoomed in, a strip under the chart shows the whole history as the unzoomed chart spaces it, with a window over
     * the zoomed range and the rest dimmed, so it is clear the chart shows only part of the history, and which part.
     */
    function renderOverview(values, max) {
      $('chart-overview').hidden = !chartZoom;
      overviewBars = null;
      if (!chartZoom) return;
      const whole = chartBars(values, chartStart, viewRevisions.length - 1);
      overviewBars = whole;
      const tops = whole.buckets.map(() => 0);
      const layers = [];
      categories.forEach((category, at) => {
        if (!whole.buckets.some((bucket) => values[bucket.end][at])) return;
        const points = ['0% 100%'];
        whole.buckets.forEach((bucket, index) => {
          tops[index] += values[bucket.end][at];
          const y = (100 - tops[index] / max * 100).toFixed(2) + '%';
          const [from, to] = whole.edges[index];
          points.push((from * 100).toFixed(3) + '% ' + y, (to * 100).toFixed(3) + '% ' + y);
        });
        points.push('100% 100%');
        const layer = text('i', '');
        layer.style.clipPath = 'polygon(' + points.join(',') + ')';
        layer.style.background = colors[category];
        // Upper layers come first so each lower one paints over them down to the baseline.
        layers.unshift(layer);
      });
      $('overview-plot').replaceChildren(...layers);
      overviewWindow = timelineSpan(whole.buckets, whole.edges, chartRange.start, chartRange.end);
      placeOverviewWindow(...overviewWindow);
      const changes = (buckets) => buckets.reduce((sum, bucket) => sum + bucket.changes, 0);
      const note = 'Zoomed in: ' + fmt(changes(chartBuckets)) + ' of ' + fmt(changes(whole.buckets)) + ' changes';
      $('overview-start').textContent = viewRevisions[chartStart].date.slice(0, 10);
      $('overview-note').textContent = note;
      $('overview-end').textContent = viewRevisions.at(-1).date.slice(0, 10);
      $('overview-window').setAttribute('aria-label', note + ', ' + viewRevisions[chartRange.start].date.slice(0, 10) + ' to ' + viewRevisions[chartRange.end].date.slice(0, 10) + '. Arrow keys move the range; Escape shows the whole history.');
    }

    /** Draws the overview's window from one position to another, 0 to 1; a very short range keeps a few pixels. */
    function placeOverviewWindow(from, to) {
      const win = $('overview-window');
      win.style.left = 'min(' + (from * 100).toFixed(3) + '%, calc(100% - 8px))';
      win.style.width = ((to - from) * 100).toFixed(3) + '%';
    }

    /** The switch between bars of equal width and bars as wide as the time they cover. */
    function renderChartSpacing() {
      const container = $('chart-spacing');
      container.replaceChildren(text('span', 'Space bars by'));
      for (const [key, label] of [['change', 'Change'], ['time', 'Time']]) {
        const button = text('button', label);
        button.type = 'button';
        button.setAttribute('aria-pressed', String(chartSpacing === key));
        button.addEventListener('click', () => {
          if (chartSpacing === key) return;
          chartSpacing = key;
          // The other spacing lays the bars out differently, so a zoomed range would no longer match what was dragged.
          chartZoom = null;
          renderChart();
          render(selected);
        });
        container.append(button);
      }
      if (chartZoom) {
        const all = text('button', 'Show all', 'chart-zoom');
        all.type = 'button';
        all.title = 'Show the whole history again (Escape)';
        all.addEventListener('click', showWholeChart);
        container.append(all);
      } else if (viewRevisions.length > 1) {
        container.append(text('span', 'Drag across the chart to zoom in', 'chart-zoom'));
      }
    }

    /** Zooms into the bars between two positions across the chart, 0 to 1; a drag over a single change does nothing. */
    function zoomChart(from, to) {
      const range = timelineZoom(chartBuckets, chartEdges, from, to);
      if (!range) return;
      zoomTo(range);
      chartBuckets.find((bucket) => bucket.selected)?.button.focus();
    }
    /** Shows a range of revisions; a selected revision outside it moves to the nearer end. */
    function zoomTo(range) {
      chartZoom = range;
      renderChart();
      render(Math.max(chartRange.start, Math.min(chartRange.end, selected)));
    }
    /** Moves the zoomed range to the revisions under a window across the overview, 0 to 1. */
    function panChart(from, to) {
      const { buckets, edges } = overviewBars;
      // The window's edges sit on revision edges, so a hair inside them finds the revisions it covers.
      const start = timelineRevision(buckets, edges, from + 1e-9);
      const end = timelineRevision(buckets, edges, Math.max(from, to - 1e-9));
      if (start === undefined || end <= start || (start === chartRange.start && end === chartRange.end)) {
        placeOverviewWindow(...overviewWindow);
        return;
      }
      zoomTo({ start, end });
    }
    function showWholeChart() {
      if (!chartZoom) return;
      chartZoom = null;
      renderChart();
      render(selected);
    }

    /**
     * Dragging the overview's window moves the zoomed range across the history; pressing outside the window moves it
     * there first. Its arrow keys move it by a quarter of its revisions, Home and End to either end.
     */
    function setupOverview() {
      const strip = $('overview-strip');
      const win = $('overview-window');
      let pan = null;
      const share = (clientX) => {
        const box = strip.getBoundingClientRect();
        return box.width ? (clientX - box.left) / box.width : 0;
      };
      const place = (from, width) => Math.max(0, Math.min(1 - width, from));
      strip.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || !overviewBars) return;
        const [from, to] = overviewWindow;
        const width = to - from;
        const at = share(event.clientX);
        pan = { id: event.pointerId, x: at, width, from: at >= from && at <= to ? from : place(at - width / 2, width) };
        placeOverviewWindow(pan.from, pan.from + width);
        try {
          strip.setPointerCapture?.(event.pointerId);
        } catch {}
      });
      const panned = (event) => place(pan.from + share(event.clientX) - pan.x, pan.width);
      strip.addEventListener('pointermove', (event) => {
        if (!pan || event.pointerId !== pan.id) return;
        const from = panned(event);
        placeOverviewWindow(from, from + pan.width);
      });
      strip.addEventListener('pointerup', (event) => {
        if (!pan || event.pointerId !== pan.id) return;
        const from = panned(event);
        const { width } = pan;
        pan = null;
        panChart(from, from + width);
      });
      strip.addEventListener('pointercancel', () => {
        pan = null;
        placeOverviewWindow(...overviewWindow);
      });
      win.addEventListener('keydown', (event) => {
        if (!chartZoom) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          showWholeChart();
          chartBuckets.find((bucket) => bucket.selected)?.button.focus();
          return;
        }
        const size = chartRange.end - chartRange.start;
        const step = Math.max(1, Math.round((size + 1) / 4));
        const last = viewRevisions.length - 1;
        const start = { ArrowLeft: chartRange.start - step, ArrowRight: chartRange.start + step, Home: chartStart, End: last - size }[event.key];
        if (start === undefined) return;
        event.preventDefault();
        const from = Math.max(chartStart, Math.min(last - size, start));
        if (from === chartRange.start) return;
        zoomTo({ start: from, end: from + size });
        win.focus();
      });
    }

    const slider = $('slider');
    // The slider runs along the chart's width rather than through the revisions, so its thumb stays over the bar it
    // selects whether the bars are spaced by change or by time. Within a bar, its revisions share the bar's width.
    const sliderSteps = 10000;
    /** The slider position of a revision, and the revision at a slider position, by the bars' edges. */
    const sliderPosition = (index) => Math.round(timelinePosition(chartBuckets, chartEdges, index) * sliderSteps);
    const sliderRevision = (position) => timelineRevision(chartBuckets, chartEdges, position / sliderSteps) ?? selected;

    /** Wires the slider, the chart's arrow keys and hover card, and the revision selects. */
    function setupHistory() {
      slider.min = 0;
      slider.max = sliderSteps;
      // While the slider is dragged, the file and comparison tables wait until it settles; the rest follows it live.
      slider.addEventListener('input', () => render(sliderRevision(Number(slider.value)), true));
      slider.addEventListener('change', () => render(sliderRevision(Number(slider.value))));
      // Its arrow keys still step one revision at a time; Page Up and Page Down move a bar.
      slider.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && chartZoom) {
          event.preventDefault();
          showWholeChart();
          return;
        }
        const at = chartBuckets.findIndex((bucket) => bucket.start <= selected && selected <= bucket.end);
        const first = chartBuckets[0]?.start ?? 0;
        const last = chartBuckets.at(-1)?.end ?? 0;
        const next = {
          ArrowLeft: selected - 1, ArrowDown: selected - 1, ArrowRight: selected + 1, ArrowUp: selected + 1,
          PageDown: chartBuckets[Math.max(0, at - 1)]?.end, PageUp: chartBuckets[Math.min(chartBuckets.length - 1, at + 1)]?.end,
          Home: first, End: last,
        }[event.key];
        if (next === undefined) return;
        event.preventDefault();
        render(Math.max(first, Math.min(last, next)));
      });
      // The bars are one tab stop; arrow keys, Home, and End move the selection between them.
      $('chart').addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && chartZoom) {
          event.preventDefault();
          showWholeChart();
          chartBuckets.find((bucket) => bucket.selected)?.button.focus();
          return;
        }
        const at = chartBuckets.findIndex((bucket) => bucket.button === event.target);
        const next = { ArrowLeft: at - 1, ArrowRight: at + 1, Home: 0, End: chartBuckets.length - 1 }[event.key];
        if (at < 0 || next === undefined) return;
        event.preventDefault();
        const bucket = chartBuckets[Math.max(0, Math.min(chartBuckets.length - 1, next))];
        render(bucket.end);
        bucket.button.focus();
      });
      // The hover card follows the pointer, and a focused bar shows it too, so the keyboard reads the same figures.
      const barAt = (target) => chartBuckets.find((bucket) => bucket.button === target?.closest?.('.bar'));
      // Dragging across the chart zooms into the bars under the drag; a click without a drag still selects a bar.
      let drag = null;
      const chartShare = (clientX) => {
        const box = $('chart').getBoundingClientRect();
        return box.width ? Math.max(0, Math.min(1, (clientX - box.left) / box.width)) : 0;
      };
      $('chart').addEventListener('pointerdown', (event) => {
        if (event.button === 0 && chartBuckets.length) drag = { x: event.clientX, id: event.pointerId, moved: false };
      });
      /** Draws the band under a drag across the chart; true while a drag is going on, so the hover card stays hidden. */
      function moveDrag(event) {
        if (!drag || event.pointerId !== drag.id) return false;
        if (!drag.moved && Math.abs(event.clientX - drag.x) < 5) return false;
        if (!drag.moved) {
          drag.moved = true;
          hideChartTip();
          // Capture keeps the drag going outside the chart; a pointer that has already gone up cannot be captured.
          try {
            $('chart').setPointerCapture?.(drag.id);
          } catch {}
        }
        // The band covers the drag, inside the chart.
        const box = $('chart').getBoundingClientRect();
        const left = Math.max(0, Math.min(drag.x, event.clientX) - box.left);
        const right = Math.min(box.width, Math.max(drag.x, event.clientX) - box.left);
        const brush = $('chart-brush');
        // The band sits in the chart's scroll box, which also holds the chart.
        const scroll = brush.parentElement?.getBoundingClientRect() ?? box;
        brush.style.left = (box.left - scroll.left + left).toFixed(1) + 'px';
        brush.style.width = Math.max(0, right - left).toFixed(1) + 'px';
        brush.hidden = false;
        return true;
      }
      const endDrag = (event, zoom) => {
        if (!drag || event.pointerId !== drag.id) return;
        const { x, moved } = drag;
        drag = null;
        $('chart-brush').hidden = true;
        if (!moved) return;
        // The click that ends a drag does not also select the bar under it.
        chartDragged = true;
        setTimeout(() => { chartDragged = false; }, 0);
        if (zoom) zoomChart(chartShare(x), chartShare(event.clientX));
      };
      $('chart').addEventListener('pointerup', (event) => endDrag(event, true));
      $('chart').addEventListener('pointercancel', (event) => endDrag(event, false));
      $('chart').addEventListener('pointermove', (event) => {
        if (moveDrag(event)) return;
        const bucket = barAt(event.target);
        if (bucket) showChartTip(bucket, event.clientX);
      });
      $('chart').addEventListener('pointerleave', hideChartTip);
      $('chart').addEventListener('focusin', (event) => {
        const bucket = barAt(event.target);
        if (!bucket) return;
        const bar = bucket.button.getBoundingClientRect();
        showChartTip(bucket, (bar.left || 0) + (bar.width || 0) / 2);
      });
      $('chart').addEventListener('focusout', hideChartTip);
      setupOverview();
      setupComparison();
    }

    // The bucket the hover card describes, and the layout read when it was filled, so moving the pointer within
    // one bar only moves the card.
    let tipBucket = null;
    let tipLayout = { left: 0, width: 0, tipWidth: 0 };
    function hideChartTip() {
      $('chart-tip').hidden = true;
      tipBucket = null;
    }
    /** The hover card: the revisions a bar covers, the date it shows, and its tokens by category, top layer first. */
    function showChartTip(bucket, clientX) {
      const tip = $('chart-tip');
      if (bucket !== tipBucket) fillChartTip(tip, bucket);
      // Beside the pointer, on the side with more room, and inside the plot.
      const { left: plotLeft, width, tipWidth } = tipLayout;
      const x = clientX - plotLeft;
      const left = x > width / 2 ? Math.max(0, x - 14 - tipWidth) : Math.min(Math.max(0, width - tipWidth), x + 14);
      tip.style.left = left.toFixed(0) + 'px';
    }
    function fillChartTip(tip, bucket) {
      tipBucket = bucket;
      const revision = viewRevisions[bucket.end];
      const steps = bucket.end - bucket.start + 1;
      const rows = [text('b', bucketRange(bucket)), text('span', revision.date.slice(0, 10) + (steps > 1 ? ' · the last of these ' + fmt(steps) : ''), 'history-tip-date')];
      if (bucket.changes > 1) rows.push(text('span', fmt(bucket.changes) + ' changes in these revisions', 'history-tip-date'));
      for (const category of [...categories].reverse()) {
        const amount = revision.categoryTotals[category].estimatedTokens;
        if (!amount) continue;
        const row = text('span', category, 'history-tip-row');
        const swatch = text('i', '', 'swatch');
        swatch.style.background = colors[category];
        row.prepend(swatch);
        row.append(text('b', fmt(amount)));
        rows.push(row);
      }
      const total = text('span', 'Total ' + inlineStat(), 'history-tip-row history-tip-total');
      total.append(text('b', fmt(revision.estimatedTokens)));
      rows.push(total);
      if (bucket.peak > revision.estimatedTokens) {
        const peak = text('span', 'Highest in these revisions', 'history-tip-row');
        peak.append(text('b', fmt(bucket.peak)));
        rows.push(peak);
      }
      tip.replaceChildren(...rows);
      tip.hidden = false;
      const plot = $('history-plot').getBoundingClientRect();
      tipLayout = { left: plot.left || 0, width: plot.width || 0, tipWidth: tip.offsetWidth || 0 };
    }`;
