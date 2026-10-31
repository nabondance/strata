/** The configuration map: its folder tree, import lines, and keyboard and pointer handling. */
export const mapScript = `    // The map draws the view's files; its import lines come from the whole inventory, like the imports table.
    const mapRowHeight = 30;
    // Folders the reader opened or closed, by path; they stay that way across revisions and views.
    const mapToggled = new Map();
    let mapFallback = 'auto';
    // The row that takes the Tab stop, by path, so it survives redrawing.
    let mapCurrent = '';
    let mapDrawn = { map: { rows: [] }, components: [], nodes: [], details: [], lines: [] };
    let mapNote = '';
    // What the last hover or focus lit, so the next one clears only that.
    let mapLit = [];
    // The row under the pointer, so losing focus goes back to it.
    let mapHovered = -1;
    let mapTabStop = null;
    // The imports table and the map both need a revision's links; they are found once per inventory.
    let linksCache = { components: null, links: [] };
    function revisionLinks(components) {
      if (linksCache.components !== components) linksCache = { components, links: importLinks(components) };
      return linksCache.links;
    }
    $('map-expand').addEventListener('click', () => { mapToggled.clear(); mapFallback = 'expanded'; renderMap(); });
    $('map-collapse').addEventListener('click', () => { mapToggled.clear(); mapFallback = 'collapsed'; renderMap(); });

    function renderMap(focus) {
      const revision = viewRevisions[selected];
      const links = revisionLinks(revisions[selected].components);
      drawn.map = revision.components;
      drawn.mapImports = revisions[selected].components;
      drawn.mapChanges = revision.changes;
      const map = configMap(revision.components, links, { toggled: mapToggled, fallback: mapFallback });
      const changedHere = new Map(revision.changes.filter((change) => change.kind !== 'removed').map((change) => [change.path, change]));
      drawn.mapTagged = changedHere.size > 0;
      // A closed folder counts the changed files it hides.
      const changedUnder = map.rows.map(() => 0);
      revision.components.forEach((component, index) => {
        if (changedHere.has(component.path) && map.rows[map.rowOf[index]].kind === 'folder') changedUnder[map.rowOf[index]] += 1;
      });
      const root = $('config-map');
      root.replaceChildren();
      root.classList.remove('tracing');
      mapLit = [];
      mapHovered = -1;
      mapTabStop = null;
      if (!map.rows.some((row) => row.path === mapCurrent)) mapCurrent = map.rows[0]?.path ?? '';
      // Imports are read from the whole inventory, so a file can import, or be imported by, one this view leaves out.
      const inView = new Set(revision.components.map((component) => component.path));
      const names = (paths) => {
        const named = paths.map((path) => inView.has(path) ? path : path + ' (outside this view)');
        return named.length > 3 ? named.slice(0, 3).join(', ') + ' and ' + fmt(named.length - 3) + ' more' : named.join(', ');
      };
      const nodes = [];
      const details = [];
      const rowIndex = new Map();
      for (const [index, row] of map.rows.entries()) {
        const folder = row.kind === 'folder';
        const component = folder ? null : revision.components[row.component];
        const change = folder ? null : changedHere.get(row.path);
        const parts = [folder ? row.path + '/' : row.path];
        if (folder) {
          // A folder of source-only files has no stored text, so it gives no token figure.
          const unmeasured = row.sourceOnly === row.files;
          parts.push(plural(row.files, 'file') + (unmeasured ? ', all source-only' : row.sourceOnly ? ' (' + fmt(row.sourceOnly) + ' source-only)' : ''));
          if (!unmeasured) parts.push(fmt(row.tokens) + ' ' + rowTokens());
          parts.push(row.collapsed ? 'closed' : 'open');
          if (changedUnder[index]) parts.push(fmt(changedUnder[index]) + ' changed at this revision');
        } else {
          parts.push(component.provider + ' / ' + categoryLabel(component), (component.estimatedTokens === null ? 'source-only, ' + fmt(component.bytes) + ' bytes' : fmt(component.estimatedTokens) + ' ' + rowTokens()) + listingLabel(component));
          if (map.targets.has(row.path)) parts.push('imports ' + names(map.targets.get(row.path)));
          if (map.sources.has(row.path)) parts.push('imported by ' + names(map.sources.get(row.path)));
          if (change) parts.push(change.kind === 'added' ? 'added at this revision' : change.kind === 'renamed' ? 'renamed at this revision from ' + change.previousPath : 'edited at this revision');
        }
        if (row.unresolved) parts.push(plural(row.unresolved, 'unresolved import'));
        const detail = parts.join(' · ');
        const node = text('div', '', 'map-row ' + row.kind);
        node.setAttribute('role', 'treeitem');
        node.setAttribute('aria-level', String(row.depth + 1));
        node.setAttribute('aria-setsize', String(row.siblings));
        node.setAttribute('aria-posinset', String(row.position));
        node.setAttribute('aria-label', detail);
        if (folder) node.setAttribute('aria-expanded', String(!row.collapsed));
        node.tabIndex = row.path === mapCurrent ? 0 : -1;
        if (node.tabIndex === 0) mapTabStop = node;
        const name = text('span', '', 'map-name');
        // Indenting the name, not the row, keeps every bar on the same scale and starting point.
        name.style.paddingLeft = 8 + row.depth * 18 + 'px';
        name.append(text('span', folder ? (row.collapsed ? '▸' : '▾') : '', 'map-caret'), text('span', row.label + (folder ? '/' : ''), 'map-label'));
        if (folder && row.collapsed) name.append(text('span', plural(row.files, 'file'), 'map-tag'));
        const changed = change ? (change.kind === 'added' ? 'new' : change.kind === 'renamed' ? 'renamed' : 'edited') : changedUnder[index] ? fmt(changedUnder[index]) + ' changed' : '';
        if (changed) name.append(text('span', changed, 'map-tag'));
        if (row.unresolved) name.append(text('span', fmt(row.unresolved) + ' unresolved', 'map-tag warn'));
        const bar = text('span', '', 'map-bar');
        // A source-only file, or a folder of nothing else, has no stored text to draw.
        if (row.sourceOnly === row.files) {
          bar.classList.add('source-only');
          const mark = text('i', '');
          mark.style.borderColor = colors[row.categories[0].category];
          bar.append(mark);
        } else {
          for (const part of row.categories) {
            if (!part.tokens || !map.totalTokens) continue;
            const segment = text('i', '');
            segment.style.width = part.tokens / map.totalTokens * 100 + '%';
            segment.style.background = colors[part.category];
            bar.append(segment);
          }
        }
        node.append(name, bar, text('span', row.sourceOnly < row.files ? fmt(row.tokens) : '—', 'map-size'));
        rowIndex.set(node, index);
        nodes.push(node);
        details.push(detail);
        root.append(node);
      }
      // Each import is a half ellipse in the gutter, from the importing row down or up to the imported one.
      const gutter = text('div', '', 'map-gutter');
      gutter.setAttribute('aria-hidden', 'true');
      gutter.style.height = map.rows.length * mapRowHeight + 'px';
      const lines = map.rows.map(() => []);
      const drawnEdges = new Set(map.edges.map((edge) => edge.from + '>' + edge.to));
      for (const edge of map.edges) {
        const span = Math.abs(edge.to - edge.from);
        const arc = text('i', '', 'map-arc');
        if (map.rows[edge.from].kind === 'folder' || map.rows[edge.to].kind === 'folder') arc.classList.add('dashed');
        arc.style.top = (Math.min(edge.from, edge.to) + 0.5) * mapRowHeight + 'px';
        arc.style.height = span * mapRowHeight + 'px';
        // Width grows with the span, scaled to the map's height so long lines never share one width.
        // Two files importing each other get two arcs; the upward one is drawn wider so both show.
        const apart = edge.from > edge.to && drawnEdges.has(edge.to + '>' + edge.from) ? ' + 6px' : '';
        arc.style.width = 'calc(max(10px, calc((var(--gutter) - 12px) * ' + (span / Math.max(16, map.rows.length - 1)).toFixed(4) + '))' + apart + ')';
        const arrow = text('i', '', 'map-arrow');
        arrow.style.top = (edge.to + 0.5) * mapRowHeight - 4 + 'px';
        gutter.append(arc, arrow);
        for (const end of [edge.from, edge.to]) lines[end].push({ arc, arrow, other: end === edge.from ? edge.to : edge.from });
      }
      if (map.edges.length) root.append(gutter);
      mapDrawn = { map, components: revision.components, nodes, details, lines, rowIndex };
      const counts = [plural(map.folders, 'folder'), plural(revision.components.length, 'file')];
      if (map.edges.length || links.length) counts.push(plural(map.edges.length, 'import line'));
      if (map.folded) counts.push(plural(map.folded, 'import') + ' between files of the same closed folder');
      if (map.unresolved) counts.push(fmt(map.unresolved) + ' unresolved, listed under Claude imports');
      if (map.offMap) counts.push(fmt(map.offMap) + ' with a file outside this view');
      // Imports are Claude's; another agent's tab can still show one between two files it reads.
      const borrowed = map.edges.length && activeView !== 'all' && activeView !== 'claude' ? ' Lines are Claude imports; they do not show that ' + (agentNames[activeView] ?? 'another agent') + ' follows them.' : '';
      // An empty tree holds nothing, so the note under it says why.
      // A provider tab can be empty at a revision that tracks other agents' files.
      const empty = activeView === 'all' || !revisions[selected].components.length ? 'No tracked files at this revision.' : 'No files in this view at this revision.';
      mapNote = !map.rows.length ? empty : (data.privacy.mode === 'shareable' ? 'Paths are aliases in this export, so files are not grouped into folders. ' : '') + counts.join(' · ') + '. Bars share ' + fmt(map.totalTokens) + ' ' + inlineStat() + '.' + borrowed;
      $('map-hover').textContent = mapNote;
      $('map-hover').classList.remove('detail');
      if (focus) nodes[map.rows.findIndex((row) => row.path === mapCurrent)]?.focus();
    }

    // Hovering or focusing a row lights its import lines and the rows at their other ends; -1 clears it.
    function traceMap(index) {
      const { nodes, details, lines } = mapDrawn;
      const root = $('config-map');
      for (const [node, name] of mapLit) node.classList.remove(name);
      mapLit = [];
      if (index < 0) {
        root.classList.remove('tracing');
        $('map-hover').textContent = mapNote;
        $('map-hover').classList.remove('detail');
        return;
      }
      if (lines[index].length) root.classList.add('tracing');
      else root.classList.remove('tracing');
      for (const { arc, arrow, other } of lines[index]) {
        arc.classList.add('lit');
        arrow.classList.add('lit');
        nodes[other].classList.add('linked');
        mapLit.push([arc, 'lit'], [arrow, 'lit'], [nodes[other], 'linked']);
      }
      $('map-hover').textContent = details[index];
      $('map-hover').classList.add('detail');
    }

    // A folder opens or closes; a file is located in the file table, as from the treemap.
    function activateMapRow(index) {
      const row = mapDrawn.map.rows[index];
      if (row.kind === 'folder') {
        mapCurrent = row.path;
        // Opening opens every folder the row stands for; closing closes only the deepest, which holds what the
        // row shows, so an outer folder stays open at revisions where it holds more.
        if (row.collapsed) for (const path of row.chain) mapToggled.set(path, false);
        else mapToggled.set(row.path, true);
        renderMap(true);
      } else {
        // While the slider is dragged the map can show an earlier revision; it catches up first, and the file is
        // located only if the selected revision has it.
        clearTimeout(settleTimer);
        renderTables();
        const component = viewRevisions[selected].components.find((candidate) => candidate.path === row.path);
        if (component) locateComponent(component);
        else mapDrawn.nodes[mapDrawn.map.rows.findIndex((shown) => shown.path === mapCurrent)]?.focus();
      }
    }

    // The map is one Tab stop; arrow keys move between rows and open or close folders, as in a file tree.
    // Rows share one set of listeners on the map, so a large map costs no more than its rows.
    const mapRowAt = (target) => {
      const node = target?.closest?.('.map-row');
      return node ? mapDrawn.rowIndex.get(node) ?? -1 : -1;
    };
    const mapRoot = $('config-map');
    mapRoot.addEventListener('mouseover', (event) => {
      const index = mapRowAt(event.target);
      if (index === mapHovered) return;
      mapHovered = index;
      // Between rows, the focused row keeps its lines.
      traceMap(index >= 0 ? index : mapRowAt(document.activeElement));
    });
    mapRoot.addEventListener('mouseleave', () => {
      mapHovered = -1;
      traceMap(mapRowAt(document.activeElement));
    });
    mapRoot.addEventListener('focusin', (event) => {
      const index = mapRowAt(event.target);
      if (index < 0) return;
      const node = mapDrawn.nodes[index];
      mapCurrent = mapDrawn.map.rows[index].path;
      if (mapTabStop && mapTabStop !== node) mapTabStop.tabIndex = -1;
      node.tabIndex = 0;
      mapTabStop = node;
      traceMap(index);
    });
    // Losing focus goes back to the row under the pointer.
    mapRoot.addEventListener('focusout', () => traceMap(mapHovered));
    mapRoot.addEventListener('click', (event) => {
      const index = mapRowAt(event.target);
      if (index >= 0) activateMapRow(index);
    });
    mapRoot.addEventListener('keydown', (event) => {
      const { map, nodes } = mapDrawn;
      const at = mapRowAt(event.target);
      // Modified keys stay the browser's, such as Alt+Left for Back.
      if (at < 0 || event.altKey || event.ctrlKey || event.metaKey) return;
      const row = map.rows[at];
      const folder = row.kind === 'folder';
      let next;
      if (event.key === 'ArrowDown') next = at + 1;
      else if (event.key === 'ArrowUp') next = at - 1;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = nodes.length - 1;
      else if (event.key === 'ArrowRight') {
        if (folder && row.collapsed) { event.preventDefault(); activateMapRow(at); return; }
        next = folder ? at + 1 : undefined;
      } else if (event.key === 'ArrowLeft') {
        if (folder && !row.collapsed) { event.preventDefault(); activateMapRow(at); return; }
        next = row.parent >= 0 ? row.parent : undefined;
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activateMapRow(at);
        return;
      }
      if (next === undefined) return;
      event.preventDefault();
      nodes[Math.max(0, Math.min(nodes.length - 1, next))].focus();
    });`;
