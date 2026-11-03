/** Drawing a selected revision: the masthead, then each panel whose input changed. */
export const renderScript = `    function render(index, dragging) {
      selected = index;
      const revision = viewRevisions[index];
      // Most commits of a long history touch no tracked file, so the masthead shows the latest change at or before
      // this revision, the one Compare's "Previous change" uses, rather than a literal previous revision's zero.
      const changed = latestChange(index);
      const delta = changed < 0 ? 0 : viewRevisions[changed].estimatedTokens - (viewRevisions[changed - 1]?.estimatedTokens ?? 0);
      slider.value = sliderPosition(index);
      slider.setAttribute('aria-valuetext', 'Revision ' + fmt(index + 1) + ' of ' + fmt(viewRevisions.length) + ', ' + revision.date.slice(0, 10));
      renderLegend();
      selectTarget(index);
      // Spaced by time there can be hundreds of bars, so only those whose selection changes are touched.
      for (const bucket of chartBuckets) {
        const isSelected = bucket.start <= index && index <= bucket.end;
        if (bucket.selected === isSelected) continue;
        bucket.selected = isSelected;
        bucket.button.classList.toggle('selected', isSelected);
        bucket.button.tabIndex = isSelected ? 0 : -1;
        bucket.button.setAttribute('aria-current', String(isSelected));
      }
      // A revision before the chart's first bar still leaves the chart reachable by Tab.
      if (chartBuckets.length) chartBuckets[0].button.tabIndex = chartBuckets[0].selected || !chartBuckets.some((bucket) => bucket.selected) ? 0 : -1;
      markSilhouette();
      $('date').textContent = revision.date.slice(0, 10);
      $('tokens').textContent = fmt(revision.estimatedTokens);
      $('components').textContent = fmt(revision.components.length);
      $('delta').textContent = (delta > 0 ? '+' : '') + fmt(delta);
      $('delta').className = delta > 0 ? 'positive' : delta < 0 ? 'negative' : '';
      $('delta-when').textContent = changed < 0 ? 'none yet' : changed === index ? 'at this revision' : 'on ' + viewRevisions[changed].date.slice(0, 10);
      $('delta-when').title = changed < 0 ? '' : 'Revision ' + fmt(changed + 1) + ' compared with ' + (changed ? 'revision ' + fmt(changed) : 'the empty history before it');
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
