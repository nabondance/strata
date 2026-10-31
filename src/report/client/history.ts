/** The legend, the stacked history chart and masthead silhouette, the slider, and the revision selects. */
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

    function renderChart() {
      const chart = $('chart');
      chart.replaceChildren();
      chartBuckets = [];
      // Leading revisions with nothing tracked in this view would only flatten the chart.
      chartStart = Math.max(0, viewRevisions.findIndex((revision) => revision.components.length));
      const buckets = timelineBuckets(viewRevisions.length, 100, chartStart);
      slider.min = chartStart;
      chart.style.gridTemplateColumns = 'repeat(' + buckets.length + ', minmax(0, 1fr))';
      const max = Math.max(1, ...viewRevisions.map((revision) => revision.estimatedTokens));
      for (const bucket of buckets) {
        const revision = viewRevisions[bucket.end];
        const button = text('button', '', 'bar');
        button.type = 'button';
        const range = bucket.start === bucket.end ? 'Revision ' + (bucket.end + 1) : 'Revisions ' + (bucket.start + 1) + '–' + (bucket.end + 1);
        button.title = range + ' · ' + revision.date.slice(0, 10) + ' · ' + fmt(revision.estimatedTokens) + ' ' + inlineStat() + ' at end';
        button.setAttribute('aria-label', 'Select ' + range + ', ending ' + revision.date.slice(0, 10));
        const stack = text('span', '', 'stack');
        stack.style.height = Math.max(2, revision.estimatedTokens / max * 210) + 'px';
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

    /** Wires the slider, the chart's arrow keys, and the revision selects. */
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
      $('baseline').append(text('option', 'Previous revision'));
      $('baseline').children[0].value = 'previous';
      for (const [index, revision] of revisions.entries()) {
        const label = (index + 1) + ' · ' + revision.date.slice(0, 10) + ' · ' + revision.id.slice(0, 8);
        for (const id of ['baseline', 'target']) {
          const option = text('option', label);
          option.value = String(index);
          $(id).append(option);
        }
      }
      $('baseline').addEventListener('change', () => { baseline = $('baseline').value === 'previous' ? 'previous' : Number($('baseline').value); renderComparison(); });
      $('target').addEventListener('change', () => render(Number($('target').value)));
    }`;
