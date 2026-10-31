/** The tracked components table, and locating one file in it. */
export const filesScript = `    function renderInventory() {
      const revision = viewRevisions[selected];
      drawn.inventory = revision.components;
      const matching = revision.components.filter((component) =>
        (!providerFilter || component.provider === providerFilter) &&
        (!categoryFilter || component.category === categoryFilter) &&
        (!pathSearch || component.path.toLocaleLowerCase().includes(pathSearch)));
      $('files-total').textContent = fmt(revision.components.length);
      $('inventory-count').hidden = matching.length === revision.components.length;
      $('inventory-count').textContent = 'Showing ' + fmt(matching.length) + ' of ' + fmt(revision.components.length) + ' files. Filters do not change the totals above.';
      const files = $('files');
      files.replaceChildren();
      inventoryRows = new Map();
      if (!matching.length) {
        const row = document.createElement('tr');
        const cell = text('td', 'No files match these filters.', 'empty');
        cell.colSpan = 5 + providerColumns.length;
        row.append(cell);
        files.append(row);
      }
      const sorted = [...matching].sort((a, b) => (b.estimatedTokens ?? -1) - (a.estimatedTokens ?? -1) || a.path.localeCompare(b.path));
      for (const component of capped('files', sorted, 25, renderInventory)) {
        const row = document.createElement('tr');
        row.tabIndex = -1;
        const tokensCell = text('td', component.estimatedTokens === null ? '—' : fmt(component.estimatedTokens), 'num');
        if (component.skill?.listing) tokensCell.title = listingLabel(component).slice(3);
        row.append(text('td', component.path, 'path'), text('td', component.provider, 'kind'), text('td', categoryLabel(component), 'kind'), tokensCell, text('td', fmt(component.bytes), 'num'));
        for (const provider of providerColumns) {
          // A Gemini context file has a Gemini count only for revisions whose settings make Gemini read it.
          const count = providerReads(component, provider, revision.geminiContextFiles) ? component.providerTokenCounts?.[provider] : undefined;
          const cell = text('td', count ? fmt(count.tokens) : '—', 'num');
          if (count) cell.title = [count.accuracy, count.model, count.method, count.version].filter(Boolean).join(' · ');
          row.append(cell);
        }
        files.append(row);
        inventoryRows.set(component.path, row);
      }
    }

    // Opens the file table filtered to one file and moves to its row.
    function locateComponent(component) {
      providerFilter = component.provider;
      categoryFilter = component.category;
      pathSearch = component.path.toLocaleLowerCase();
      $('provider-filter').value = providerFilter;
      $('category-filter').value = categoryFilter;
      $('path-search').value = component.path;
      $('files-panel').open = true;
      renderInventory();
      const row = inventoryRows.get(component.path);
      row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      row?.focus({ preventScroll: true });
    }`;
