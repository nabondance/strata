/** The Claude imports and MCP servers tables. */
export const importsScript = `    // Imports are links between stored files, so they follow the whole inventory whatever the view.
    const importStatus = { resolved: 'resolved', missing: 'missing', external: 'outside the repository', 'depth-limit': 'too deep' };
    const unresolvedFirst = { missing: 0, external: 1, 'depth-limit': 2, resolved: 3 };
    function renderImports() {
      const components = revisions[selected].components;
      drawn.imports = components;
      const links = revisionLinks(components);
      $('imports-panel').hidden = !links.length;
      const unresolved = links.filter((link) => link.status !== 'resolved').length;
      $('imports-count').textContent = fmt(links.length) + (unresolved ? ' · ' + fmt(unresolved) + ' unresolved' : '');
      const body = $('imports');
      body.replaceChildren();
      const sorted = [...links].sort((a, b) => unresolvedFirst[a.status] - unresolvedFirst[b.status] || a.source.localeCompare(b.source) || a.line - b.line);
      for (const link of capped('imports', sorted, 25, renderImports)) {
        const row = document.createElement('tr');
        // An external import has no target, and within the limit its status already says so; a
        // missing one has none when it is a bare word the report does not keep.
        const target = link.target === null ? (link.status === 'external' ? '—' : link.external ? 'outside the repository' : 'not a tracked path') : link.symlink ? link.symlink + ' → ' + link.target : link.target;
        row.append(text('td', link.source, 'path'), text('td', fmt(link.line), 'num'), text('td', target, 'path'), text('td', fmt(link.hop), 'num'), text('td', importStatus[link.status], 'kind'));
        body.append(row);
      }
    }

    // MCP servers follow the provider view, like the files that define them.
    function renderMcp() {
      const components = viewRevisions[selected].components.filter((component) => component.mcp);
      drawn.mcp = viewRevisions[selected].components;
      $('mcp-panel').hidden = !components.length;
      const rows = components.flatMap((component) => component.mcp.status === 'listed'
        ? component.mcp.servers.map((server) => ({ component, server }))
        : [{ component, server: null }]);
      const servers = rows.filter((row) => row.server).length;
      const unresolved = rows.length - servers;
      $('mcp-count').textContent = plural(servers, 'server') + ' · ' + plural(components.length, 'file') + (unresolved ? ' · ' + fmt(unresolved) + ' unresolved' : '');
      const body = $('mcp-servers');
      body.replaceChildren();
      if (!rows.length) {
        const row = document.createElement('tr');
        const cell = text('td', 'The tracked MCP files define no servers at this revision.', 'empty');
        cell.colSpan = 4;
        row.append(cell);
        body.append(row);
      }
      // Unreadable files come first, so a parse failure is not mistaken for no servers.
      const sorted = [...rows].sort((a, b) => Number(Boolean(a.server)) - Number(Boolean(b.server)) || a.component.path.localeCompare(b.component.path));
      for (const { component, server } of capped('mcp-servers', sorted, 25, renderMcp)) {
        const row = document.createElement('tr');
        const runs = !server ? 'unresolved' : server.transport + (server.disabled ? ' (disabled)' : '');
        const name = text('td', server ? server.name : 'Could not read this file', server ? 'path' : 'kind');
        row.append(name, text('td', runs, 'kind'), text('td', component.path, 'path'), text('td', component.provider));
        body.append(row);
      }
    }

    const pluginStates = {
      enabled: 'enabled',
      disabled: 'turned off',
      configured: 'configured',
      defined: 'defined here',
      catalog: 'marketplace file',
      marketplace: 'registered marketplace',
      'skills-folder': 'in .claude/skills, loads unless turned off',
    };
    const pluginLabel = (state, listed) => pluginStates[state] + (listed ? ', ' + plural(listed.local + listed.external, 'plugin') + ' (' + fmt(listed.local) + ' by relative path)' : '');
    const pluginState = (plugin) => pluginLabel(plugin.state, plugin.listed);

    // Which tools a file is for: a package names them, and a setting follows the rule for who reads it at this revision.
    function pluginTools(component) {
      if (component.skill) return [component.provider];
      const tools = component.readers ?? [component.provider];
      if (component.pluginPackage) return tools;
      const { components, geminiContextFiles } = revisions[selected];
      return tools.filter((tool) => providerReads(component, tool, geminiContextFiles, components.some((other) =>
        other.provider === tool && !other.pluginPackage && !(other.category === 'other' && other.path.endsWith('/plugin.json')))));
    }

    // Plugins follow the provider view, like the files that name them.
    function renderPlugins() {
      // A Codex overlay beside a root manifest adds settings; that manifest is the plugin's identity.
      const manifests = new Set(revisions[selected].components.filter((component) => component.pluginPackage && component.plugins).map((component) => component.path));
      const overlay = '.codex-plugin/plugin.json';
      const components = viewRevisions[selected].components.filter((component) => component.plugins &&
        !(component.path.endsWith(overlay) && manifests.has(component.path.slice(0, -overlay.length) + 'plugin.json')));
      drawn.plugins = viewRevisions[selected].components;
      const rows = components.flatMap((component) => component.plugins.status === 'listed'
        ? component.plugins.plugins.map((plugin) => ({ component, plugin }))
        : [{ component, plugin: null }]);
      $('plugins-panel').hidden = !rows.length;
      const named = rows.filter((row) => row.plugin).length;
      const unresolved = rows.length - named;
      $('plugins-count').textContent = plural(named, 'reference') + ' · ' + plural(new Set(rows.map((row) => row.component.path)).size, 'file') + (unresolved ? ' · ' + fmt(unresolved) + ' unresolved' : '');
      const body = $('plugins');
      body.replaceChildren();
      // Unreadable files come first, so a parse failure is not mistaken for no plugins.
      const sorted = [...rows].sort((a, b) => Number(Boolean(a.plugin)) - Number(Boolean(b.plugin)) || a.component.path.localeCompare(b.component.path));
      for (const { component, plugin } of capped('plugins', sorted, 25, renderPlugins)) {
        const row = document.createElement('tr');
        const name = text('td', plugin ? plugin.name : 'Could not read this file', plugin ? 'path' : 'kind');
        row.append(name, text('td', plugin ? pluginState(plugin) : 'unresolved', 'kind'), text('td', component.path, 'path'), text('td', pluginTools(component).join(', ')));
        body.append(row);
      }
    }`;
