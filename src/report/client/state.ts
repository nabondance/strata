/** Shared helpers and state: measures, the counting notice, the submodule notice, and capped lists. */
export const stateScript = `    const $ = (id) => document.getElementById(id);
    const numberFormat = new Intl.NumberFormat();
    const fmt = (n) => numberFormat.format(n);
    const plural = (count, word) => fmt(count) + ' ' + word + (count === 1 ? '' : 's');
    const signed = (n) => (n > 0 ? '+' : '') + fmt(n);
    const tone = (n) => n > 0 ? 'positive' : n < 0 ? 'negative' : '';
    const text = (tag, value, className) => { const node = document.createElement(tag); node.textContent = value; if (className) node.className = className; return node; };
    const revisions = expandRevisions(data);
    let selected = revisions.length - 1;
    // The baseline follows the revision before the selected one until a specific revision is chosen.
    let baseline = 'previous';
    const beforeHistory = { components: [], estimatedTokens: 0 };
    const baselineRevision = () => baseline === 'previous' ? viewRevisions[selected - 1] ?? beforeHistory : viewRevisions[baseline];
    let activeView = 'all';
    // 'estimate', or a provider whose own counts the provider view is drawn with.
    let activeMeasure = 'estimate';
    let viewRevisions = revisions;
    const accuracyNames = { 'api-counted': 'API-counted', 'encoding-exact': 'exact (local encoding)', estimate: 'byte estimate' };
    // Providers counted with something better than the estimate can chart their own counts.
    const measures = new Map((data.providerMeasurements ?? []).filter((measured) => measured.accuracy !== 'estimate').map((measured) => [measured.provider, measured]));
    const measuredHistory = new Map();
    /** The history with each file's tokens taken from one provider's counts, rebuilt once per provider. */
    function measuredRevisions(provider) {
      if (!measuredHistory.has(provider)) {
        const components = data.components.map((component) => {
          const count = component.providerTokenCounts?.[provider];
          return count ? { ...component, estimatedTokens: count.tokens } : component;
        });
        measuredHistory.set(provider, { components, revisions: expandRevisions({ ...data, components }) });
      }
      return measuredHistory.get(provider);
    }
    function describeMeasurement(measured) {
      if (measured.accuracy === 'estimate') return providerNames[measured.provider] + ': byte estimate' + (measured.fallbacks?.length ? ' (more precise methods unavailable: ' + measured.fallbacks.join('; ') + ')' : '') + (measured.alsoSentTo?.length ? '; instruction text went to ' + measured.alsoSentTo.join(' and ') + ' through a method that then failed' : '') + '.';
      return providerNames[measured.provider] + ': ' + accuracyNames[measured.accuracy] + ' with ' + measured.model + ' — ' + measured.method + ' (' + measured.version + ')' +
        (measured.recipient ? ', counted by ' + measured.recipient : ', counted on this machine') +
        (measured.credential ? ' using ' + measured.credential : '') +
        (measured.alsoSentTo?.length ? '; instruction text also went to ' + measured.alsoSentTo.join(' and ') + ' through a method that then failed' : '') +
        (measured.fallbacks?.length ? '; more precise methods unavailable: ' + measured.fallbacks.join('; ') : '') + '.';
    }
    // The measure's name inside a sentence: provider names and acronyms keep their case.
    const inlineStat = () => activeMeasure === 'estimate' ? measureLabel().stat.toLowerCase() : measureLabel().stat;
    // What a map row's figure is, inside a sentence.
    const rowTokens = () => activeMeasure === 'estimate' ? 'stored-text tokens' : inlineStat();
    function measureLabel() {
      if (activeMeasure === 'estimate') return { stat: tokenAdjective + ' tokens', compare: tokenAdjective + ' stored-text tokens', meta: data.measurement.label };
      const measured = measures.get(activeMeasure);
      const kind = measured.accuracy === 'api-counted' ? 'API-counted' : 'exact';
      const name = providerNames[activeMeasure];
      return { stat: name + ' ' + kind + ' tokens', compare: name + ' ' + kind + ' tokens', meta: name + ' ' + kind + ' tokens under ' + measured.model };
    }
    // A count endpoint's result is the provider's own count, which it does not promise is exact; a local encoding is.
    const badgeNames = { 'api-counted': 'API count', 'encoding-exact': 'Exact · local', estimate: 'Estimate' };
    /** A few words per provider on how its files were counted; the full description is the row's tooltip. */
    function renderCounting() {
      const measurements = data.providerMeasurements ?? [];
      $('counting').hidden = $('counting-note').hidden = !measurements.length;
      $('counting-summary').textContent = measurements.map((measured) => ' · ' + providerNames[measured.provider] + ' ' + { 'api-counted': 'API count', 'encoding-exact': 'exact (local)', estimate: 'estimate' }[measured.accuracy]).join('');
      $('counting-rows').replaceChildren(...measurements.map((measured) => {
        const row = document.createElement('tr');
        if (measured.provider === activeMeasure) row.className = 'active';
        row.title = describeMeasurement(measured);
        const badge = text('span', badgeNames[measured.accuracy], 'badge ' + (measured.accuracy === 'estimate' ? 'estimate' : 'exact'));
        const failed = measured.fallbacks?.some((reason) => / failed: /.test(reason));
        // Missing credentials are the common case; anything else, such as a key a header cannot carry, is "unusable".
        const missing = measured.fallbacks?.every((reason) => /not installed|is not set|are not set|no signed-in|no local exact/.test(reason));
        const detail = measured.accuracy === 'estimate'
          ? (measured.alsoSentTo?.length ? 'count failed after text was sent to ' + measured.alsoSentTo.join(' and ') : failed ? 'counting failed' : missing ? 'no account or API key found' : 'no usable account or API key')
          : measured.recipient
            ? measured.model + ', counted by ' + measured.recipient + ' with ' + measured.credential
            : measured.model + ', on this machine';
        const cells = [text('td', providerNames[measured.provider]), document.createElement('td'), text('td', detail)];
        cells[1].append(badge);
        row.append(...cells);
        return row;
      }));
      $('counting-note').textContent = activeView === 'all'
        ? 'All files adds providers together, so it uses the estimate. Open a provider tab for its own count.'
        : activeMeasure === 'estimate' ? 'This view: the estimate.' : 'This view: ' + providerNames[activeMeasure] + "'s own count.";
    }
    function renderMethod() {
      renderCounting();
      // A provider view's own count is described by its row and the note below the table.
      $('method').hidden = activeMeasure !== 'estimate';
      $('method').textContent = data.measurement.accuracy === 'estimate' ? 'Estimate: UTF-8 bytes ÷ 4 per file.' : data.measurement.label + ', counted on this machine.';
      const label = measureLabel();
      $('tokens-label').textContent = label.stat;
      $('compare-tokens-label').textContent = label.compare;
      $('repo-meta').textContent = data.branch + ' · ' + fmt(revisions.length) + ' revisions · ' + revisions[0].date.slice(0, 10) + ' → ' + revisions.at(-1).date.slice(0, 10) + ' · ' + label.meta;
    }
    function renderMeasureSwitch() {
      const container = $('measure-switch');
      container.replaceChildren();
      const measured = measures.get(activeView);
      container.hidden = !measured;
      if (!measured) return;
      container.append(text('span', 'Count with'));
      for (const [key, label] of [[activeView, providerNames[activeView] + ' ' + (measured.accuracy === 'api-counted' ? 'API' : 'exact') + ' · ' + measured.model], ['estimate', 'Byte estimate']]) {
        const button = text('button', label);
        button.type = 'button';
        button.setAttribute('aria-pressed', String(activeMeasure === key));
        button.addEventListener('click', () => { if (activeMeasure !== key) setView(activeView, key); });
        container.append(button);
      }
    }
    let showAllSkills = false;
    let providerFilter = '';
    let categoryFilter = '';
    let pathSearch = '';
    let inventoryRows = new Map();
    let chartBuckets = [];
    let chartStart = 0;
    let treemapLabels = [];
    // What the line under the treemap says while no rectangle is hovered or focused.
    let treemapNote = '';
    // What each panel last drew, so moving between revisions that share an inventory redraws nothing.
    let drawn = {};
    // Long lists show their first rows until asked for the rest.
    const expanded = {};
    let settleTimer;

    function capped(id, items, limit, redraw) {
      const button = $(id + '-more');
      button.hidden = items.length <= limit;
      button.textContent = expanded[id] ? 'Show first ' + fmt(limit) : 'Show all ' + fmt(items.length);
      button.setAttribute('aria-expanded', String(Boolean(expanded[id])));
      button.onclick = () => { expanded[id] = !expanded[id]; redraw(); };
      return expanded[id] ? items : items.slice(0, limit);
    }
    /** The repository name, the counting notice, and the shallow-clone and submodule notices. */
    function setupNotices() {
      $('repo').textContent = data.repository;
      renderMethod();
      $('shallow').hidden = !data.shallow;
      // Name the submodules holding agent configuration that was not analyzed; count those that could not be checked.
      const configuredSubmodules = (data.submodules || []).filter((submodule) => submodule.configFiles);
      const uncheckedSubmodules = (data.submodules || []).filter((submodule) => submodule.configFiles === null).length;
      const configFileCount = (count) => fmt(count) + ' recognized agent configuration file' + (count === 1 ? '' : 's');
      const submoduleNotes = [];
      if (configuredSubmodules.length === 1) {
        submoduleNotes.push('Not analyzed: the Git submodule ' + configuredSubmodules[0].path + ' holds ' + configFileCount(configuredSubmodules[0].configFiles) + '. Run Strata on it to see its history.');
      } else if (configuredSubmodules.length) {
        const listed = configuredSubmodules.slice(0, 5).map((submodule) => submodule.path + ' (' + fmt(submodule.configFiles) + ')');
        if (configuredSubmodules.length > 5) listed.push('and ' + fmt(configuredSubmodules.length - 5) + ' more');
        submoduleNotes.push('Not analyzed: ' + fmt(configuredSubmodules.length) + ' Git submodules hold recognized agent configuration files: ' + listed.join(', ') + '. Run Strata on one to see its history.');
      }
      $('submodules').hidden = !submoduleNotes.length;
      $('submodules').textContent = submoduleNotes.join(' ');
      // A fresh clone leaves submodules uninitialized, so that alone is a quiet note beside the measurement disclosure.
      $('submodules-unchecked').hidden = !uncheckedSubmodules;
      $('submodules-unchecked').textContent = uncheckedSubmodules ? fmt(uncheckedSubmodules) + ' Git submodule' + (uncheckedSubmodules === 1 ? ' was' : 's were') + ' not checked for agent configuration because ' + (uncheckedSubmodules === 1 ? 'it is' : 'they are') + ' not checked out at the recorded commit.' : '';
    }`;
