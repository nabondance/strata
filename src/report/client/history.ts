/** The legend, the stacked history chart with its axes and hover card, the masthead silhouette, and the slider. */
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
      $('chart-tip').hidden = true;
      chartBuckets = [];
      // Leading revisions with nothing tracked in this view would only flatten the chart.
      chartStart = Math.max(0, viewRevisions.findIndex((revision) => revision.components.length));
      const buckets = timelineBuckets(viewRevisions.length, 100, chartStart);
      slider.min = chartStart;
      chart.style.gridTemplateColumns = 'repeat(' + buckets.length + ', minmax(0, 1fr))';
      const max = Math.max(1, ...viewRevisions.map((revision) => revision.estimatedTokens));
      // The scale covers every charted revision, not only the last of each step, and changes with the view and measure.
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
        button.setAttribute('aria-label', bucketRange(bucket) + ' · ' + revision.date.slice(0, 10) + ' · ' + fmt(revision.estimatedTokens) + ' ' + inlineStat() + ' at ' + (bucket.start === bucket.end ? 'this revision' : 'the last one'));
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
        // Safari does not focus a clicked button, and arrow keys need the focus on a bar.
        button.addEventListener('click', () => {
          render(bucket.end);
          button.focus();
        });
        chart.append(button);
        chartBuckets.push({ ...bucket, button });
      }
      // Calendar boundaries between the end dates; CSS keeps only the middle one on a narrow screen.
      $('timeline-dates').replaceChildren(...timelineDateTicks(buckets.map((bucket) => viewRevisions[bucket.end].date)).map((tick) => {
        const label = text('span', tick.label, tick.primary ? 'primary' : '');
        label.style.left = (tick.at / buckets.length * 100).toFixed(2) + '%';
        return label;
      }));
      const charted = viewRevisions.length - chartStart;
      $('chart-steps').hidden = buckets.length >= charted;
      $('chart-steps').textContent = fmt(charted) + ' revisions shown as ' + fmt(buckets.length) + ' steps; each step shows the last revision in its group.';
      $('timeline-start').textContent = viewRevisions[chartStart].date.slice(0, 10);
      $('timeline-end').textContent = viewRevisions.at(-1).date.slice(0, 10);
      // The masthead's lower edge repeats the chart as stepped layers.
      const tops = buckets.map(() => 0);
      const layers = [];
      for (const category of categories) {
        if (!buckets.some((bucket) => viewRevisions[bucket.end].categoryTotals[category].estimatedTokens)) continue;
        const points = ['0% 100%'];
        buckets.forEach((bucket, index) => {
          tops[index] += viewRevisions[bucket.end].categoryTotals[category].estimatedTokens;
          const y = (100 - tops[index] / max * 100).toFixed(2) + '%';
          points.push((index / buckets.length * 100).toFixed(2) + '% ' + y, ((index + 1) / buckets.length * 100).toFixed(2) + '% ' + y);
        });
        points.push('100% 100%');
        const layer = text('i', '');
        layer.style.clipPath = 'polygon(' + points.join(',') + ')';
        layer.style.background = colors[category];
        // Upper layers come first so each lower one paints over them down to the baseline.
        layers.unshift(layer);
      }
      $('silhouette').replaceChildren(...layers);
    }

    const slider = $('slider');

    /** Wires the slider, the chart's arrow keys and hover card, and the revision selects. */
    function setupHistory() {
      slider.max = revisions.length - 1;
      // While the slider is dragged, the file and comparison tables wait until it settles; the rest follows it live.
      slider.addEventListener('input', () => render(Number(slider.value), true));
      slider.addEventListener('change', () => render(Number(slider.value)));
      // The bars are one tab stop; arrow keys, Home, and End move the selection between them.
      $('chart').addEventListener('keydown', (event) => {
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
      $('chart').addEventListener('pointermove', (event) => {
        const bucket = barAt(event.target);
        if (bucket) showChartTip(bucket, event.clientX);
      });
      $('chart').addEventListener('pointerleave', () => { $('chart-tip').hidden = true; });
      $('chart').addEventListener('focusin', (event) => {
        const bucket = barAt(event.target);
        if (!bucket) return;
        const bar = bucket.button.getBoundingClientRect();
        showChartTip(bucket, (bar.left || 0) + (bar.width || 0) / 2);
      });
      $('chart').addEventListener('focusout', () => { $('chart-tip').hidden = true; });
      setupComparison();
    }

    /** The hover card: the revisions a bar covers, the date it shows, and its tokens by category, top layer first. */
    function showChartTip(bucket, clientX) {
      const tip = $('chart-tip');
      const revision = viewRevisions[bucket.end];
      const steps = bucket.end - bucket.start + 1;
      const rows = [text('b', bucketRange(bucket)), text('span', revision.date.slice(0, 10) + (steps > 1 ? ' · the last of these ' + fmt(steps) : ''), 'history-tip-date')];
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
      tip.replaceChildren(...rows);
      tip.hidden = false;
      // Beside the pointer, on the side with more room, and inside the plot.
      const plot = $('history-plot').getBoundingClientRect();
      const width = plot.width || 0;
      const x = clientX - (plot.left || 0);
      const tipWidth = tip.offsetWidth || 0;
      const left = x > width / 2 ? Math.max(0, x - 14 - tipWidth) : Math.min(Math.max(0, width - tipWidth), x + 14);
      tip.style.left = left.toFixed(0) + 'px';
    }`;
