/** Drawing a selected revision: the masthead, then each panel whose input changed. */
export const renderScript = `    function render(index, dragging) {
      selected = index;
      const revision = viewRevisions[index];
      const previous = viewRevisions[index - 1];
      const delta = revision.estimatedTokens - (previous?.estimatedTokens ?? 0);
      slider.value = index;
      renderLegend();
      selectTarget(index);
      for (const bucket of chartBuckets) {
        const isSelected = bucket.start <= index && index <= bucket.end;
        bucket.button.classList.toggle('selected', isSelected);
        bucket.button.tabIndex = isSelected ? 0 : -1;
        bucket.button.setAttribute('aria-current', String(isSelected));
      }
      // A revision before the chart's first bar still leaves the chart reachable by Tab.
      if (chartBuckets.length && !chartBuckets.some((bucket) => bucket.button.tabIndex === 0)) chartBuckets[0].button.tabIndex = 0;
      $('date').textContent = revision.date.slice(0, 10);
      $('tokens').textContent = fmt(revision.estimatedTokens);
      $('components').textContent = fmt(revision.components.length);
      $('delta').textContent = (delta > 0 ? '+' : '') + fmt(delta);
      $('delta').className = delta > 0 ? 'positive' : delta < 0 ? 'negative' : '';
      $('revision').textContent = (index + 1) + ' / ' + revisions.length + ' · ' + revision.id.slice(0, 10);

      renderAge();
      if (drawn.skills !== revision.skillGroups) renderSkills();
      if (drawn.upFront !== revisions[index].components) renderUpFront();

      if (drawn.treemap !== revision.components || drawn.outlined || revision.changes.length) renderTreemap();
      clearTimeout(settleTimer);
      if (dragging) settleTimer = setTimeout(renderTables, 120);
      else renderTables();
    }

    function renderTables() {
      const revision = viewRevisions[selected];
      if (drawn.inventory !== revision.components) renderInventory();
      if (drawn.imports !== revisions[selected].components) renderImports();
      // Changes only matter to the map when the drawn or the selected revision tags a file.
      const mapTags = drawn.mapChanges !== revision.changes && (drawn.mapTagged || revision.changes.some((change) => change.kind !== 'removed'));
      if (drawn.map !== revision.components || drawn.mapImports !== revisions[selected].components || mapTags) renderMap();
      if (drawn.mcp !== revision.components) renderMcp();
      if (drawn.target !== revision.components || drawn.baseline !== baselineRevision().components) renderComparison();
    }`;
