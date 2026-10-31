/** The treemap of the selected revision, its move between revisions, fitting its labels, and redrawing it on resize. */
export const treemapScript = `    // Gaps and the category header are in pixels, so the layout is redone when the treemap is resized.
    const treemapFrame = { gap: 4, seam: 1, header: 22, wide: 2 };
    // What each rectangle was drawn for, so the next revision can move it rather than redraw it.
    let treemapDrawn = new Map();

    function renderTreemap(animate = true) {
      const root = $('treemap');
      const box = root.getBoundingClientRect();
      const frame = box.width > 0 && box.height > 0 ? { ...treemapFrame, width: box.width, height: box.height } : undefined;
      const layout = layoutTreemap(viewRevisions[selected].components, frame);
      const toPercent = (rect) => ({ x: rect.x / (frame?.width ?? 100) * 100, y: rect.y / (frame?.height ?? 100) * 100, width: rect.width / (frame?.width ?? 100) * 100, height: rect.height / (frame?.height ?? 100) * 100 });
      const place = (node, rect) => {
        node.style.left = rect.x + '%';
        node.style.top = rect.y + '%';
        node.style.width = rect.width + '%';
        node.style.height = rect.height + '%';
      };
      // Where each rectangle is on screen now, partway through a move included, to start the next move from.
      const motion = frame && animate && treemapDrawn.size && !(typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
      const before = new Map();
      if (motion) {
        for (const [key, node] of treemapDrawn) {
          const at = node.getBoundingClientRect();
          before.set(key, { x: (at.left - box.left) / box.width * 100, y: (at.top - box.top) / box.height * 100, width: at.width / box.width * 100, height: at.height / box.height * 100 });
        }
      }
      const drawnNow = new Map();
      const changedHere = new Map(viewRevisions[selected].changes.filter((change) => change.kind !== 'removed').map((change) => [change.path, change]));
      let outlined = 0;
      const treeLegend = $('treemap-legend');
      root.replaceChildren();
      treeLegend.replaceChildren();
      treemapLabels = [];
      if (!layout.totalTokens) root.append(text('p', 'No instructional token estimates at this revision.', 'empty'));
      // A name another rectangle shares takes the folders that tell the two apart; a skill is named by its directory.
      const labelled = layout.groups.flatMap((group) => group.leaves.map((leaf) => viewRevisions[selected].components[leaf.componentIndex]));
      const names = treemapNames(labelled.map((component) => component.skill?.role === 'manifest' ? component.skill.root : component.path));
      const leafNames = new Map(labelled.map((component, index) => [component, names[index]]));
      for (const group of layout.groups) {
        // The category's block shows through as the band holding its name and the seams between its files.
        const block = text('div', '', 'treemap-group');
        block.setAttribute('aria-hidden', 'true');
        place(block, toPercent(group));
        block.style.background = shades[group.category];
        block.style.color = shadeInks[group.category];
        if (group.headed) {
          const name = text('span', group.category, 'group-name');
          name.style.lineHeight = treemapFrame.header + 'px';
          name.append(text('b', fmt(group.estimatedTokens)));
          block.append(name);
        }
        root.append(block);
        drawnNow.set('category:' + group.category, block);
        for (const leaf of group.leaves) {
          const component = viewRevisions[selected].components[leaf.componentIndex];
          const share = toPercent(leaf);
          const button = text('button', '', 'treemap-leaf');
          button.type = 'button';
          place(button, share);
          button.style.background = colors[component.category];
          button.style.color = inks[component.category];
          const change = changedHere.get(component.path);
          const changeLabel = !change ? '' : change.kind === 'added' ? ' · added at this revision' : change.kind === 'renamed' ? ' · renamed at this revision from ' + change.previousPath : ' · edited at this revision';
          const detail = component.path + ' · ' + component.provider + ' / ' + categoryLabel(component) + ' · ' + fmt(leaf.estimatedTokens) + ' stored-text tokens' + listingLabel(component) + changeLabel;
          button.setAttribute('aria-label', detail);
          if (change) {
            button.classList.add('changed');
            if (change.kind !== 'added') button.classList.add('edited');
            outlined += 1;
          }
          // Rectangles too small for even one short line stay unlabeled; fitTreemapLabels decides the rest.
          if (share.width >= 3.5 && share.height >= 5.5) {
            const label = leafNames.get(component);
            const name = text('span', label, 'leaf-name');
            const size = text('span', fmt(leaf.estimatedTokens) + ' tokens', 'leaf-size');
            button.append(name, size);
            treemapLabels.push({ button, name, size, label });
            if (share.width >= 28 && share.height >= 22 && share.width * share.height >= 700) button.classList.add('large');
          }
          const showDetail = () => { $('treemap-hover').textContent = detail; $('treemap-hover').classList.add('detail'); };
          const clearDetail = () => { $('treemap-hover').textContent = treemapNote; $('treemap-hover').classList.remove('detail'); };
          button.addEventListener('mouseenter', showDetail);
          button.addEventListener('focus', showDetail);
          button.addEventListener('mouseleave', clearDetail);
          button.addEventListener('blur', clearDetail);
          button.addEventListener('click', () => locateComponent(component));
          root.append(button);
          drawnNow.set('file:' + component.path, button);
        }
      }
      treeLegend.hidden = !outlined;
      if (outlined) {
        for (const [label, className] of [['added at this revision', 'ring'], ['edited or renamed at this revision', 'ring dashed']]) {
          const entry = text('span', label);
          entry.prepend(text('i', '', className));
          treeLegend.append(entry);
        }
      }
      treemapNote = (outlined ? fmt(outlined) + ' outlined files changed at this revision · ' : '') + fmt(layout.groups.reduce((sum, group) => sum + group.leaves.length, 0)) + ' sized · ' + fmt(layout.sourceOnlyCount) + ' source-only' + sourceOnlyCategories() + ' · ' + fmt(layout.zeroTokenCount) + ' zero-token files';
      $('treemap-hover').textContent = treemapNote;
      $('treemap-hover').classList.remove('detail');
      drawn.treemap = viewRevisions[selected].components;
      drawn.outlined = outlined;
      fitTreemapLabels();
      treemapDrawn = drawnNow;
      if (!motion) return;
      // Labels were fitted to where each rectangle ends up; now start each one from where it was and let it move.
      const moving = [];
      for (const [key, node] of drawnNow) {
        const from = before.get(key);
        if (!from) {
          if (node.className === 'treemap-leaf') node.classList.add('entering');
          continue;
        }
        moving.push([node, { left: node.style.left, top: node.style.top, width: node.style.width, height: node.style.height }]);
        node.style.transition = 'none';
        place(node, from);
      }
      root.getBoundingClientRect();
      for (const [node, to] of moving) {
        node.style.transition = '';
        Object.assign(node.style, to);
      }
    }

    function fitTreemapLabels() {
      if (typeof getComputedStyle !== 'function') return;
      for (const { button, name, size, label } of treemapLabels) {
        button.classList.remove('compact');
        name.textContent = label;
        // A tall, narrow rectangle reads its name top to bottom instead of breaking it mid-word.
        const shape = button.getBoundingClientRect();
        if (shape.width < 90 && shape.height > shape.width * 1.8) button.classList.add('upright');
        else button.classList.remove('upright');
        name.hidden = false;
        name.style.fontSize = '';
        size.hidden = false;
        const inner = () => {
          const box = button.getBoundingClientRect();
          const style = getComputedStyle(button);
          return [box.bottom - parseFloat(style.paddingBottom) - parseFloat(style.borderBottomWidth), box.right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth)];
        };
        let [bottom, right] = inner();
        // A name breaks only where it has a hyphen, so a part wider than the rectangle does not fit either.
        const nameFits = () => name.getBoundingClientRect().bottom <= bottom + 1 && name.scrollHeight <= name.clientHeight + 1 && !(name.scrollWidth > name.clientWidth + 1);
        const nameBox = name.getBoundingClientRect();
        const sizeBox = size.getBoundingClientRect();
        if (!nameFits() || sizeBox.top < nameBox.bottom + 5 || sizeBox.bottom > bottom + 1 || sizeBox.right > right + 1) {
          size.hidden = true;
        }
        if (!nameFits()) {
          name.style.fontSize = '11px';
          // A name with folders gives up folder text from the left, keeping the file or skill name whole and the last
          // few letters of the folder that tells it apart from another rectangle of the same name.
          const most = label.indexOf('/') - Math.min(3, label.indexOf('/'));
          if (!nameFits() && most > 0) {
            const cut = (drop) => { name.textContent = '…' + label.slice(drop); return nameFits(); };
            if (cut(most)) {
              let fits = most;
              let short = 1;
              while (short < fits) {
                const middle = Math.floor((short + fits) / 2);
                if (cut(middle)) fits = middle;
                else short = middle + 1;
              }
              cut(fits);
            } else {
              name.textContent = label;
            }
          }
          if (!nameFits()) {
            // Last resort: one small line, cut short with an ellipsis. A name with folders keeps them at its start,
            // so two rectangles of the same name still read differently.
            name.style.fontSize = '';
            button.classList.add('compact');
            [bottom, right] = inner();
            const compactBox = name.getBoundingClientRect();
            if (right - compactBox.left < 28 || compactBox.bottom > bottom + 1) name.hidden = true;
          }
        }
      }
    }
    /** Lays the treemap out again when its width changes. */
    function observeTreemapWidth() {
      if (typeof ResizeObserver !== 'undefined') {
        let treemapWidth = 0;
        new ResizeObserver(([entry]) => {
          if (Math.abs(entry.contentRect.width - treemapWidth) < 1) return;
          treemapWidth = entry.contentRect.width;
          renderTreemap(false);
        }).observe($('treemap'));
      }
    }`;
