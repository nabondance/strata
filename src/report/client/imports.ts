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
        // Only an external import has no target; within the limit its status already says so.
        const target = link.target === null ? (link.status === 'external' ? '—' : 'outside the repository') : link.symlink ? link.symlink + ' → ' + link.target : link.target;
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
    }`;
