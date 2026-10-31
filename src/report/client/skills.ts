/** The skill bundles table. */
export const skillsScript = `    function renderSkills() {
      const groups = viewRevisions[selected].skillGroups;
      drawn.skills = groups;
      const visible = showAllSkills ? groups : groups.slice(0, 8);
      const skillBody = $('skill-groups');
      skillBody.replaceChildren();
      $('skills-panel').hidden = !groups.length;
      const manifestTokens = groups.reduce((sum, group) => sum + (group.manifestPath ? group.manifestEstimatedTokens : 0), 0);
      const listedTokens = groups.reduce((sum, group) => sum + (group.listing?.tokens ?? 0), 0);
      const unresolved = groups.filter((group) => group.listing?.status === 'unresolved').length;
      $('skill-count').textContent = plural(groups.length, 'skill') + ' · summaries ' + fmt(listedTokens) + listingKind() + ' · full text ' + fmt(manifestTokens) + ' tokens' + (unresolved ? ' · ' + fmt(unresolved) + ' unresolved' : '');
      const borrowed = (activeView === 'cursor' || activeView === 'copilot') && groups.some((group) => group.provider !== activeView);
      $('listing-note').textContent = (activeMeasure === 'estimate' ? '' : 'Full text uses ' + providerNames[activeMeasure] + ' counts and summaries the ' + listingKind().slice(2, -1) + ', so do not compare them. ') +
        'Summary: the name and description an agent sees before using a skill. It is part of the full text, so do not add the two. Hidden skills have no summary; unresolved ones could not be read and are not counted.' +
        (borrowed ? ' ' + activeView[0].toUpperCase() + activeView.slice(1) + ' may summarize skills from .claude/skills or .agents/skills differently.' : '');
      const toggle = $('skill-toggle');
      toggle.hidden = groups.length <= 8;
      toggle.textContent = showAllSkills ? 'Show first 8 skill bundles' : 'Show all ' + fmt(groups.length) + ' skill bundles';
      toggle.setAttribute('aria-expanded', String(showAllSkills));
      if (!groups.length) {
        const row = document.createElement('tr');
        const cell = text('td', 'No tracked skill bundles at this revision.', 'empty');
        cell.colSpan = 7;
        row.append(cell);
        skillBody.append(row);
      }
      for (const group of visible) {
        const row = document.createElement('tr');
        row.append(text('td', group.root, 'path'), text('td', group.provider), text('td', group.manifestPath ? 'SKILL.md' : 'Missing', 'kind'), text('td', group.manifestPath ? fmt(group.manifestEstimatedTokens) : '—', 'num'), listingCell(group.listing), text('td', fmt(group.resourceCount), 'num'), text('td', fmt(group.resourceBytes), 'num'));
        skillBody.append(row);
      }
    }`;
