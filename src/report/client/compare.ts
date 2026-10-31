/** The Compare revisions panel: its revision selects and the comparison. */
export const compareScript = `    // The selects list the first revision, the latest, and each revision that changed a tracked file in the current
    // view, the same changes "Previous change" follows: listing every revision would give a long history thousands of
    // options that each read "no change". They are refilled with the view.
    let listedSet = new Set();
    const revisionLabel = (index) => fmt(index + 1) + ' · ' + revisions[index].date.slice(0, 10) + ' · ' + revisions[index].id.slice(0, 8);
    // A target picked on the chart or the slider that changed nothing is listed first while it is selected.
    const unlistedTarget = text('option', '');

    /** The latest revision at or before index whose view changed something, or -1. */
    function latestChange(index) {
      let at = index;
      while (at >= 0 && !viewRevisions[at].changes.length) at -= 1;
      return at;
    }
    /** The baseline's revision index; -1 is the empty history before the first revision. */
    function baselineIndex() {
      if (baseline === 'previous') return selected - 1;
      if (baseline === 'change') return Math.max(-1, latestChange(selected) - 1);
      return baseline;
    }
    /** Lists the view's changed revisions in both selects; a fixed baseline the view did not change stays listed. */
    function fillRevisionSelects() {
      const listed = viewRevisions.flatMap((revision, index) => index === 0 || index === viewRevisions.length - 1 || revision.changes.length ? [index] : []);
      listedSet = new Set(listed);
      const pinned = typeof baseline === 'number' && !listedSet.has(baseline) ? [baseline] : [];
      const baselines = [...listed, ...pinned].sort((a, b) => a - b);
      const modes = [['change', 'Previous change'], ['previous', 'Previous revision']].map(([value, label]) => {
        const option = text('option', label);
        option.value = value;
        return option;
      });
      $('baseline').replaceChildren(...modes);
      fillRevisionSelect($('baseline'), baselines);
      $('target').replaceChildren();
      unlistedShown = false;
      fillRevisionSelect($('target'), listed);
      $('baseline').value = String(baseline);
      $('target').value = String(selected);
    }
    function fillRevisionSelect(select, indexes) {
      // Past about fifty options, months group them so the list can be scanned.
      const grouped = indexes.length > 50;
      let group = select;
      let month = '';
      for (const index of indexes) {
        if (grouped && revisions[index].date.slice(0, 7) !== month) {
          month = revisions[index].date.slice(0, 7);
          group = document.createElement('optgroup');
          group.label = month;
          select.append(group);
        }
        const option = text('option', revisionLabel(index) + (listedSet.has(index) ? '' : ' · no change'));
        option.value = String(index);
        group.append(option);
      }
    }
    /** Wires the selects; the history chart fills them, since it is redrawn with each view. */
    function setupComparison() {
      $('baseline').addEventListener('change', () => {
        const value = $('baseline').value;
        baseline = value === 'previous' || value === 'change' ? value : Number(value);
        renderComparison();
      });
      $('target').addEventListener('change', () => render(Number($('target').value)));
    }
    let unlistedShown = false;
    function selectTarget(index) {
      const target = $('target');
      if (listedSet.has(index)) {
        if (unlistedShown) unlistedTarget.remove();
        unlistedShown = false;
      } else {
        unlistedTarget.textContent = revisionLabel(index) + ' · no change';
        unlistedTarget.value = String(index);
        if (!unlistedShown) target.prepend(unlistedTarget);
        unlistedShown = true;
      }
      target.value = String(index);
    }

    function renderComparison() {
      const comparison = compareRevisions(baselineRevision(), viewRevisions[selected]);
      drawn.baseline = baselineRevision().components;
      drawn.target = viewRevisions[selected].components;
      $('baseline').value = String(baseline);
      const from = baselineIndex();
      for (const bucket of [...chartBuckets, ...ageBuckets]) bucket.button.classList.toggle('baseline', baseline !== 'previous' && bucket.start <= from && from <= bucket.end);
      // Name the revision "Previous change" stands for, which can be far back on a long history.
      const changed = latestChange(selected);
      $('compare-span').hidden = baseline !== 'change';
      $('compare-span').textContent = changed < 0
        ? 'No tracked file changed up to this revision.'
        : 'Previous change: revision ' + fmt(changed + 1) + ' · ' + viewRevisions[changed].date.slice(0, 10) + (changed === selected ? ', the target' : '') + ', compared with ' + (changed ? 'revision ' + fmt(changed) + ' before it.' : 'the empty history before it.');
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
      const kept = from >= 0 && from < selected ? keptShare(from, selected) : null;
      $('compare-kept-wrap').hidden = kept === null;
      $('compare-kept-label').textContent = 'Instruction text kept' + (activeView === 'all' ? '' : ' (all files)');
      // Kept text is measured in bytes, so the bytes stay, under the share.
      if (kept !== null) {
        $('compare-kept').textContent = sharePercent(kept);
        $('compare-kept-bytes').textContent = 'of ' + fmt(ages.bytes[from]) + ' bytes of instruction text';
      }
      const mcp = comparison.mcp;
      $('compare-mcp-wrap').hidden = !mcp;
      if (mcp) {
        $('compare-mcp').textContent = signed(mcp.deltaServers) + ' (' + fmt(mcp.beforeServers) + ' → ' + fmt(mcp.afterServers) + ')' +
          (mcp.beforeUnresolved || mcp.afterUnresolved ? ' · unresolved ' + fmt(mcp.beforeUnresolved) + ' → ' + fmt(mcp.afterUnresolved) : '');
        $('compare-mcp').className = tone(mcp.deltaServers);
      }
      renderMcpNames(mcp);
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
    }

    /** Added and removed servers, one line per name; a name defined in several files lists them in a disclosure. */
    function renderMcpNames(mcp) {
      const list = $('compare-mcp-names');
      list.replaceChildren();
      list.hidden = !mcp || (!mcp.added.length && !mcp.removed.length);
      if (list.hidden) return;
      for (const [heading, refs] of [['MCP servers added', mcp.added], ['MCP servers removed', mcp.removed]]) {
        if (!refs.length) continue;
        const files = new Map();
        for (const ref of refs) files.set(ref.name, [...(files.get(ref.name) ?? []), ref.path]);
        const names = document.createElement('ul');
        for (const [name, paths] of [...files].slice(0, 10)) {
          const item = document.createElement('li');
          if (paths.length === 1) item.append(text('b', name), text('span', ' ' + paths[0], 'path'));
          else {
            const details = document.createElement('details');
            const summary = text('summary', '');
            summary.append(text('b', name), text('span', ' × ' + fmt(paths.length) + ' files'));
            const where = document.createElement('ul');
            for (const path of paths) where.append(text('li', path, 'path'));
            details.append(summary, where);
            item.append(details);
          }
          names.append(item);
        }
        if (files.size > 10) names.append(text('li', 'and ' + plural(files.size - 10, 'more server')));
        const group = text('div', '', 'compare-mcp-group');
        group.append(text('span', heading + ' (' + fmt(refs.length) + ')', 'compare-mcp-heading'), names);
        list.append(group);
      }
    }`;
