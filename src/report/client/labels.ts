/** Labels and cells several panels share: categories, skill summaries, and their changes. */
export const labelsScript = `    // Listings always use the report's own measurement, never a provider's counts, so measured views say which.
    function listingKind() {
      if (activeMeasure === 'estimate') return '';
      return ' (' + (data.measurement.accuracy === 'estimate' ? 'byte estimate' : data.measurement.encoding + ' encoding') + ')';
    }
    // A superseded format, such as .cursorrules, keeps its category but says it is legacy.
    // The categories of the selected revision's source-only files, as a clause after their count.
    function sourceOnlyCategories() {
      const found = [...new Set(viewRevisions[selected].components.filter((component) => component.estimatedTokens === null).map((component) => component.category))];
      return found.length ? ' (' + found.join(', ') + ')' : '';
    }
    function categoryLabel(component) {
      return component.category + (component.legacy ? ' (legacy)' : '') + (component.imported ? ' (imported)' : '');
    }
    // How a skill manifest is listed before use, as a clause after its stored-text tokens.
    function listingLabel(component) {
      const listing = component.skill?.listing;
      if (!listing) return '';
      if (listing.status === 'listed') return ' · ' + fmt(listing.tokens) + ' in its summary' + listingKind();
      return listing.status === 'hidden' ? ' · no summary (hidden)' : ' · summary unresolved';
    }
    function listingCell(listing) {
      if (!listing) return text('td', '—', 'num');
      if (listing.status === 'listed') return text('td', fmt(listing.tokens), 'num');
      const cell = text('td', listing.status, 'num kind');
      cell.title = listing.status === 'hidden' ? 'Hidden until invoked (disable-model-invocation)' : 'Strata could not read the name and description';
      return cell;
    }

    // Both sides listed: the token change; otherwise each side's state, such as a manifest added or hidden.
    function listingDeltaCell(listing) {
      if (!listing) return text('td', '—', 'num');
      const side = (entry) => !entry ? 'none' : entry.status === 'listed' ? fmt(entry.tokens) : entry.status;
      if (listing.before?.status === 'listed' && listing.after?.status === 'listed') return text('td', signed(listing.deltaTokens), 'num ' + tone(listing.deltaTokens));
      return text('td', side(listing.before) + ' → ' + side(listing.after), 'num');
    }`;
