/** The Compare revisions panel. */
export const compareScript = `    function renderComparison() {
      const comparison = compareRevisions(baselineRevision(), viewRevisions[selected]);
      drawn.baseline = baselineRevision().components;
      drawn.target = viewRevisions[selected].components;
      $('baseline').value = String(baseline);
      for (const bucket of [...chartBuckets, ...ageBuckets]) bucket.button.classList.toggle('baseline', baseline !== 'previous' && bucket.start <= baseline && baseline <= bucket.end);
      $('compare-tokens').textContent = signed(comparison.deltaTokens) + ' (' + fmt(comparison.beforeTokens) + ' → ' + fmt(comparison.afterTokens) + ')';
      $('compare-tokens').className = tone(comparison.deltaTokens);
      $('compare-files').textContent = signed(comparison.deltaFiles) + ' (' + fmt(comparison.beforeFiles) + ' → ' + fmt(comparison.afterFiles) + ')';
      $('compare-files').className = tone(comparison.deltaFiles);
      const skills = comparison.skillListing;
      $('compare-listing-wrap').hidden = !skills.beforeManifests && !skills.afterManifests;
      $('compare-listing-label').textContent = 'Skill summary tokens' + listingKind();
      $('compare-listing').textContent = signed(skills.deltaTokens) + ' (' + fmt(skills.beforeTokens) + ' → ' + fmt(skills.afterTokens) + ')' +
        (skills.beforeUnresolved || skills.afterUnresolved ? ' · unresolved ' + fmt(skills.beforeUnresolved) + ' → ' + fmt(skills.afterUnresolved) : '');
      $('compare-listing').className = tone(skills.deltaTokens);
      // Kept text is measured on the whole inventory, so it does not change with the view.
      const keptFrom = baseline === 'previous' ? selected - 1 : baseline;
      const kept = keptFrom >= 0 && keptFrom < selected ? keptShare(keptFrom, selected) : null;
      $('compare-kept-wrap').hidden = kept === null;
      $('compare-kept-label').textContent = 'Instruction text kept' + (activeView === 'all' ? '' : ' (all files)');
      if (kept !== null) $('compare-kept').textContent = sharePercent(kept) + ' of ' + fmt(ages.bytes[keptFrom]) + ' bytes';
      const mcp = comparison.mcp;
      $('compare-mcp-wrap').hidden = !mcp;
      if (mcp) {
        $('compare-mcp').textContent = signed(mcp.deltaServers) + ' (' + fmt(mcp.beforeServers) + ' → ' + fmt(mcp.afterServers) + ')' +
          (mcp.beforeUnresolved || mcp.afterUnresolved ? ' · unresolved ' + fmt(mcp.beforeUnresolved) + ' → ' + fmt(mcp.afterUnresolved) : '');
        $('compare-mcp').className = tone(mcp.deltaServers);
        const names = (refs) => refs.slice(0, 10).map((ref) => ref.name + ' (' + ref.path + ')').join(', ') + (refs.length > 10 ? ', and ' + fmt(refs.length - 10) + ' more' : '');
        $('compare-mcp-names').textContent = [mcp.added.length ? 'MCP servers added: ' + names(mcp.added) + '.' : '', mcp.removed.length ? 'MCP servers removed: ' + names(mcp.removed) + '.' : ''].filter(Boolean).join(' ');
      }
      $('compare-mcp-names').hidden = !mcp || (!mcp.added.length && !mcp.removed.length);
      for (const [id, groups] of [['compare-providers', comparison.byProvider], ['compare-categories', comparison.byCategory]]) {
        const body = $(id);
        body.replaceChildren();
        const moved = groups.filter((group) => group.deltaFiles || group.deltaTokens);
        if (!moved.length) {
          const row = document.createElement('tr');
          const cell = text('td', 'No change.', 'empty');
          cell.colSpan = 3;
          row.append(cell);
          body.append(row);
        }
        for (const group of moved) {
          const row = document.createElement('tr');
          row.append(text('td', group.key), text('td', signed(group.deltaFiles), 'num ' + tone(group.deltaFiles)), text('td', signed(group.deltaTokens), 'num ' + tone(group.deltaTokens)));
          body.append(row);
        }
      }
      const body = $('compare-components');
      body.replaceChildren();
      if (!comparison.components.length) {
        const row = document.createElement('tr');
        const cell = text('td', 'No component changes between these revisions.', 'empty');
        cell.colSpan = 6;
        row.append(cell);
        body.append(row);
      }
      for (const component of capped('compare-components', comparison.components, 25, renderComparison)) {
        const row = document.createElement('tr');
        row.append(text('td', component.path, 'path'), text('td', component.provider), text('td', categoryLabel(component)), text('td', component.kind), text('td', component.beforeTokens === null && component.afterTokens === null ? 'source only' : signed(component.deltaTokens), 'num ' + tone(component.deltaTokens)), listingDeltaCell(component.listing));
        body.append(row);
      }
    }`;
