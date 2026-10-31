/** The provider tabs, switching views and measures, and the file filters. */
export const viewsScript = `    const allComponents = data.components;
    // A provider that only reads shared files, such as Codex with only .agents/skills, still gets a view.
    const providers = [...new Set(allComponents.flatMap((component) => [component.provider, ...(component.readers ?? [])]))].sort();
    const viewTabs = [{ key: 'all', label: 'All files' },
      ...providers.filter((provider) => provider !== 'shared').map((provider) => ({
        key: provider, label: provider === 'unknown' ? 'Unknown' : provider[0].toUpperCase() + provider.slice(1) + ' + shared',
      })),
      ...(providers.includes('shared') ? [{ key: 'shared', label: 'Shared only' }] : [])];
    function setView(view, measure) {
      activeView = view;
      activeMeasure = measure;
      const base = measure === 'estimate' ? { components: data.components, revisions } : measuredRevisions(measure);
      viewRevisions = [];
      for (const [index, revision] of base.revisions.entries()) {
        const projected = viewRevision(revision, activeView, base.revisions[index - 1], base.components);
        // Revisions that changed nothing keep sharing arrays in a provider view too.
        if (projected !== revision && index && revision.components === base.revisions[index - 1].components) {
          projected.components = viewRevisions[index - 1].components;
          projected.skillGroups = viewRevisions[index - 1].skillGroups;
        }
        viewRevisions.push(projected);
      }
      drawn = {};
      showAllSkills = false;
      providerFilter = '';
      categoryFilter = '';
      pathSearch = '';
      $('category-filter').value = '';
      $('path-search').value = '';
      Array.from($('provider-tabs').children).forEach((tab, index) => tab.setAttribute('aria-pressed', String(viewTabs[index].key === activeView)));
      renderProviderOptions();
      renderViewNote();
      renderMeasureSwitch();
      renderMethod();
      renderChart();
      render(selected);
    }
    function renderProviderOptions() {
      const select = $('provider-filter');
      const all = text('option', 'All providers in this view');
      all.value = '';
      select.replaceChildren(all);
      for (const provider of [...new Set(viewRevisions.flatMap((revision) => revision.components.map((component) => component.provider)))].sort()) {
        const option = text('option', provider);
        option.value = provider;
        select.append(option);
      }
      select.value = '';
    }
    function renderViewNote() {
      $('view-note').textContent = activeView === 'all'
        ? ''
        : activeView === 'shared'
          ? 'Files labeled shared because more than one tool reads them by convention, such as AGENTS.md. Each also appears in the view of every provider that reads it. Files Cursor or Copilot reads from another tool, such as .claude/skills or CLAUDE.md, keep the label of the tool that owns them.'
          : activeView === 'unknown'
            ? 'Files not assigned to a supported provider; source-only unless recognized.'
            : activeView[0].toUpperCase() + activeView.slice(1) + ' files plus the shared files it reads' + (activeView === 'gemini' ? '; .gemini/settings.json context.fileName decides whether AGENTS.md and GEMINI.md are included, GEMINI.md alone by default' : activeView === 'cursor' ? '. Cursor also reads AGENTS.md, .agents/skills, and .claude/skills, which it includes only at revisions that track Cursor configuration' : activeView === 'copilot' ? '. Copilot also reads AGENTS.md, CLAUDE.md, REVIEW.md, GEMINI.md, .claude/agents, .claude/rules, .claude/skills, .agents/skills, and .mcp.json, which it includes only at revisions that track Copilot configuration. Which Copilot client (chat, cloud agent, code review, CLI, or an IDE) reads a file is not resolved' : '') + '. Shared files can appear in more than one provider view, so view totals do not add up.';
      $('view-note').hidden = activeView === 'all';
    }
    /** Adds the view tabs and category options, and wires the file filters. */
    function setupViews() {
      for (const view of viewTabs) {
        const button = text('button', view.label, 'provider-tab');
        button.type = 'button';
        button.setAttribute('aria-pressed', String(view.key === activeView));
        // A provider view opens on that provider's own counts when the report has them.
        button.addEventListener('click', () => setView(view.key, measures.has(view.key) ? view.key : 'estimate'));
        $('provider-tabs').append(button);
      }
      for (const category of categories) {
        if (!allComponents.some((component) => component.category === category)) continue;
        const option = text('option', category);
        option.value = category;
        $('category-filter').append(option);
      }
      $('provider-filter').addEventListener('change', () => { providerFilter = $('provider-filter').value; renderInventory(); });
      $('category-filter').addEventListener('change', () => { categoryFilter = $('category-filter').value; renderInventory(); });
      $('path-search').addEventListener('input', () => { pathSearch = $('path-search').value.trim().toLocaleLowerCase(); renderInventory(); });
      $('clear-filters').addEventListener('click', () => {
        providerFilter = '';
        categoryFilter = '';
        pathSearch = '';
        $('provider-filter').value = '';
        $('category-filter').value = '';
        $('path-search').value = '';
        renderInventory();
        $('path-search').focus();
      });
      $('skill-toggle').addEventListener('click', () => { showAllSkills = !showAllSkills; renderSkills(); });
    }`;
