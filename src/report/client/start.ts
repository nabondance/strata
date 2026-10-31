/** Startup, run after every other part, so no part reads a const or let another part has not yet declared. */
export const startScript = `    setupNotices();
    setupHistory();
    setupViews();
    renderProviderOptions();
    renderViewNote();
    renderMeasureSwitch();
    renderChart();
    setupMap();
    renderAgeChart();
    observeTreemapWidth();
    render(selected);
    renderEmptyState();`;
