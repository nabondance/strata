/** The masthead's lower edge: every charted revision of the current view as stepped layers, with a line at the selected revision. */
export const silhouetteScript = `    // The line at the selected revision, kept across redraws of the layers.
    const silhouetteMark = text('i', '', 'silhouette-mark');
    // The revisions the layers span, from the chart's first one, so the mark can find its place.
    let silhouetteSpan = { start: 0, count: 0 };

    /**
     * Draws the charted revisions as stepped layers on the chart's scale, ungrouped: each revision takes the same width,
     * and a step starts wherever the drawn values change. Past 2,000 changes the most alike neighbors merge, finer than
     * a screen can show.
     */
    function renderSilhouette(values, start, max) {
      const count = values.length - start;
      silhouetteSpan = { start, count };
      const steps = count > 0 ? timelineBuckets(values, 2000, start) : [];
      const x = (index) => ((index - start) / count * 100).toFixed(3) + '%';
      const tops = steps.map(() => 0);
      const layers = [];
      categories.forEach((category, at) => {
        if (!steps.some((step) => values[step.end][at])) return;
        const points = ['0% 100%'];
        steps.forEach((step, index) => {
          tops[index] += values[step.end][at];
          const y = (100 - tops[index] / max * 100).toFixed(2) + '%';
          points.push(x(step.start) + ' ' + y, x(step.end + 1) + ' ' + y);
        });
        points.push('100% 100%');
        const layer = text('i', '');
        layer.style.clipPath = 'polygon(' + points.join(',') + ')';
        layer.style.background = colors[category];
        // Upper layers come first so each lower one paints over them down to the baseline.
        layers.unshift(layer);
      });
      $('silhouette').replaceChildren(...layers, silhouetteMark);
    }

    /** Moves the line to the selected revision; a revision before the first charted one has none. */
    function markSilhouette() {
      const at = selected - silhouetteSpan.start;
      // With no layers there is nothing to mark.
      silhouetteMark.hidden = at < 0 || !silhouetteSpan.count || $('silhouette').children.length < 2;
      if (!silhouetteMark.hidden) silhouetteMark.style.left = ((at + 0.5) / silhouetteSpan.count * 100).toFixed(3) + '%';
    }`;
