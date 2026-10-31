/** The Instruction age chart, legend, and note. */
export const ageScript = `    // Instruction age follows the whole inventory, like imports, whatever the view.
    const ages = instructionAges(data);
    const ageStart = ages.bytes.findIndex((bytes) => bytes > 0);
    const ageBuckets = [];
    // The finest period that keeps the layers few enough to tell apart.
    const agePeriods = instructionAgePeriods(data);
    const periodCount = agePeriods.periods.length;
    // In a shallow clone, the text at its first revision may be older than that revision.
    const shallowPeriod = data.shallow && agePeriods.periodOf.has(0) ? agePeriods.periodOf.get(0) : -1;
    const periodLabel = (period) => agePeriods.periods[period].label + (period === shallowPeriod ? ' or earlier' : '');
    const ageColor = (period) => periodCount === 1 ? 'var(--age-old)' : 'color-mix(in oklab, var(--age-new) ' + (period / (periodCount - 1) * 100).toFixed(1) + '%, var(--age-old))';
    /** Bytes at a revision by period, oldest first. */
    function agePeriodBytes(index) {
      const bytes = agePeriods.periods.map(() => 0);
      for (const cohort of ages.at(index)) bytes[agePeriods.periodOf.get(cohort.from)] += cohort.bytes;
      return bytes;
    }
    /** Of the instruction text at the baseline, the share still present at the target, or null without baseline text. */
    function keptShare(from, to) {
      const before = ages.bytes[from];
      if (!before || to < from) return null;
      return ages.at(to).reduce((sum, cohort) => sum + (cohort.from <= from ? cohort.bytes : 0), 0) / before;
    }
    function renderAgeChart() {
      $('age-panel').hidden = ageStart < 0;
      if (ageStart < 0) return;
      const chart = $('age-chart');
      const buckets = timelineBuckets(ages.bytes.length, 100, ageStart);
      $('age-start').textContent = revisions[ageStart].date.slice(0, 10);
      $('age-end').textContent = revisions.at(-1).date.slice(0, 10);
      chart.style.gridTemplateColumns = 'repeat(' + buckets.length + ', minmax(0, 1fr))';
      const max = Math.max(1, ...ages.bytes);
      // Buckets run forward, so the replay passes over the history once.
      for (const bucket of buckets) {
        const total = ages.bytes[bucket.end];
        const button = text('button', '', 'bar');
        button.type = 'button';
        const range = bucket.start === bucket.end ? 'Revision ' + (bucket.end + 1) : 'Revisions ' + (bucket.start + 1) + '–' + (bucket.end + 1);
        const bytes = agePeriodBytes(bucket.end);
        const oldest = bytes.findIndex((amount) => amount);
        button.title = range + ' · ' + revisions[bucket.end].date.slice(0, 10) + ' · ' + fmt(total) + ' bytes of instruction lines' + (oldest >= 0 ? ', ' + sharePercent(bytes[oldest] / total) + ' from ' + periodLabel(oldest) : '');
        button.setAttribute('aria-label', 'Select ' + range + ', ending ' + revisions[bucket.end].date.slice(0, 10));
        const stack = text('span', '', 'stack');
        stack.style.height = Math.max(2, total / max * 150) + 'px';
        bytes.forEach((amount, period) => {
          if (!amount) return;
          const segment = text('span', '', 'segment');
          segment.style.height = amount / total * 100 + '%';
          segment.style.background = ageColor(period);
          segment.title = range + ' · ' + sharePercent(amount / total) + ' from ' + periodLabel(period);
          stack.append(segment);
        });
        button.append(stack);
        button.addEventListener('click', () => { render(bucket.end); button.focus(); });
        chart.append(button);
        ageBuckets.push({ ...bucket, button });
      }
      chart.addEventListener('keydown', (event) => {
        const at = ageBuckets.findIndex((bucket) => bucket.button === event.target);
        const next = { ArrowLeft: at - 1, ArrowRight: at + 1, Home: 0, End: ageBuckets.length - 1 }[event.key];
        if (at < 0 || next === undefined) return;
        event.preventDefault();
        const bucket = ageBuckets[Math.max(0, Math.min(ageBuckets.length - 1, next))];
        render(bucket.end);
        bucket.button.focus();
      });
    }
    function renderAge() {
      if (ageStart < 0) return;
      for (const bucket of ageBuckets) {
        const isSelected = bucket.start <= selected && selected <= bucket.end;
        bucket.button.classList.toggle('selected', isSelected);
        bucket.button.tabIndex = isSelected ? 0 : -1;
        bucket.button.setAttribute('aria-current', String(isSelected));
      }
      if (ageBuckets.length && !ageBuckets.some((bucket) => bucket.button.tabIndex === 0)) ageBuckets[0].button.tabIndex = 0;
      const total = ages.bytes[selected];
      const bytes = agePeriodBytes(selected);
      // Newest first, as the layers read from the top of the chart; periods with no text here are left out.
      const legend = $('age-legend');
      legend.replaceChildren();
      for (let period = periodCount - 1; period >= 0; period -= 1) {
        if (!bytes[period]) continue;
        const entry = text('span', periodLabel(period));
        entry.append(text('b', sharePercent(bytes[period] / total)));
        const swatch = text('i', '', 'swatch');
        swatch.style.background = ageColor(period);
        entry.prepend(swatch);
        legend.append(entry);
      }
      if (!total) {
        $('age-count').textContent = 'no instruction text at this revision' + (activeView === 'all' ? '' : ' · all files');
        $('age-note').textContent = 'No instruction text at this revision.';
        return;
      }
      // The revision by which half of the text present had appeared, weighed by bytes.
      const cohorts = ages.at(selected);
      let median = cohorts[0].from;
      for (let seen = 0, index = 0; index < cohorts.length; index += 1) {
        seen += cohorts[index].bytes;
        if (seen * 2 >= total) { median = cohorts[index].from; break; }
      }
      const kept = sharePercent(keptShare(ageStart, selected) ?? 0);
      const medianDate = revisions[median].date.slice(0, 10) + (data.shallow && median === 0 ? ' or earlier' : '');
      const firstDate = revisions[ageStart].date.slice(0, 10);
      $('age-count').textContent = 'half added by ' + medianDate + ' · ' + kept + ' of the ' + firstDate + ' text still there' + (activeView === 'all' ? '' : ' · all files');
      $('age-note').textContent = fmt(total) + ' bytes of instruction lines at revision ' + (selected + 1) + '. Half of them were in place by revision ' + (median + 1) + ' (' + medianDate + '). Of the ' + fmt(ages.bytes[ageStart]) + ' bytes at the first revision with instructions (' + firstDate + '), ' + kept + ' are still present.' +
        (data.shallow && ageStart === 0 ? ' This shallow clone starts at revision 1, so text dated there may be older.' : '');
    }`;
