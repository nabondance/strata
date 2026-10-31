/** The masthead's lower edge: the history chart of the current view as stepped layers, with a line at the selected revision. */
export const silhouetteScript = `    // The line at the selected revision, kept across redraws of the layers.
    const silhouetteMark = text('i', '', 'silhouette-mark');

    /** Draws the chart's buckets as stepped layers, scaled like the chart, for whichever view the chart shows. */
    function renderSilhouette(buckets, max) {
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
      $('silhouette').replaceChildren(...layers, silhouetteMark);
    }

    /** Moves the line to the middle of the step holding the selected revision; a revision before the first step has none. */
    function markSilhouette() {
      const at = chartBuckets.findIndex((bucket) => bucket.start <= selected && selected <= bucket.end);
      // With no layers there is nothing to mark.
      silhouetteMark.hidden = at < 0 || $('silhouette').children.length < 2;
      if (at >= 0) silhouetteMark.style.left = ((at + 0.5) / chartBuckets.length * 100).toFixed(2) + '%';
    }`;
