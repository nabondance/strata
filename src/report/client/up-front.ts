/** The At session start panel. */
export const upFrontScript = `    // Up-front text follows the whole inventory under the report's own measurement, whatever the view counts with.
    function renderUpFront() {
      const revision = revisions[selected];
      drawn.upFront = revision.components;
      const single = Object.hasOwn(agentNames, activeView);
      const entries = (single ? [activeView] : Object.keys(agentNames))
        .map((provider) => upFrontContext(revision.components, provider, revision.geminiContextFiles))
        .filter((entry) => entry.tokens || entry.onDemandTokens || entry.files.length || entry.skipped || entry.listingUnresolved || entry.unresolved);
      $('upfront-panel').hidden = !entries.length;
      $('upfront-count').textContent = entries.map((entry) => agentNames[entry.provider] + ' ' + fmt(entry.tokens)).join(' · ');
      const body = $('upfront-rows');
      body.replaceChildren();
      for (const entry of entries) {
        const row = document.createElement('tr');
        row.append(text('td', agentNames[entry.provider]), text('td', fmt(entry.files.length), 'num'), text('td', fmt(entry.fileTokens), 'num'), text('td', fmt(entry.listingTokens), 'num'), text('td', fmt(entry.tokens), 'num'), text('td', fmt(entry.onDemandTokens), 'num'));
        body.append(row);
      }
      const notes = [];
      const unsure = entries.filter((entry) => entry.unresolved);
      if (unsure.length) notes.push('Maybe read at start, counted as when needed: ' + unsure.map((entry) => agentNames[entry.provider] + ' ' + plural(entry.unresolved, 'file')).join(', ') + '.');
      for (const entry of entries.filter((item) => item.skipped)) notes.push(agentNames[entry.provider] + ' skips AGENTS.md because ' + (entry.provider === 'claude' ? 'CLAUDE.md' : 'AGENTS.override.md') + ' exists (' + fmt(entry.skippedTokens) + ' tokens, left out).');
      const unreadable = entries.filter((entry) => entry.listingUnresolved);
      if (unreadable.length) notes.push('Skills with unreadable descriptions, not counted: ' + unreadable.map((entry) => agentNames[entry.provider] + ' ' + fmt(entry.listingUnresolved)).join(', ') + '.');
      if (activeMeasure !== 'estimate') notes.push('Uses the report\u2019s ' + listingKind().slice(2, -1) + ', not ' + providerNames[activeMeasure] + ' counts.');
      notes.push('Personal and global settings outside the repository are not included.');
      $('upfront-note').textContent = notes.join('\\n');
      const files = single && entries.length ? entries[0].files : [];
      $('upfront-files-wrap').hidden = !files.length;
      const fileBody = $('upfront-files');
      fileBody.replaceChildren();
      for (const component of files) {
        const row = document.createElement('tr');
        row.append(text('td', component.path, 'path'), text('td', categoryLabel(component)), text('td', component.estimatedTokens === null ? 'source only' : fmt(component.estimatedTokens), 'num'));
        fileBody.append(row);
      }
    }`;
