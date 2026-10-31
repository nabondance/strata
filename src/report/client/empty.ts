/** The card that takes the panels' place when no revision tracks any recognized configuration. */
export const emptyScript = `    // The main places the supported tools read; docs/analysis-scope.md lists every pattern.
    const recognizedPaths = ['CLAUDE.md', 'AGENTS.md', '.claude/', '.agents/skills/', '.cursor/rules/', '.github/copilot-instructions.md', 'GEMINI.md', '.codex/'];

    /** Shows the card and hides the panels when the report has no component at any revision; otherwise does nothing. */
    function renderEmptyState() {
      if (data.components.length) return;
      $('report-panels').hidden = true;
      $('counting-notice').hidden = true;
      const card = $('empty-state');
      const heading = text('h2', 'Strata found no agent configuration in ' + plural(revisions.length, 'revision') + ' of ' + data.repository);
      heading.id = 'empty-heading';
      const paths = document.createElement('ul');
      for (const path of recognizedPaths) {
        const item = document.createElement('li');
        item.append(text('code', path));
        paths.append(item);
      }
      card.replaceChildren(
        heading,
        text('p', 'None of its commits on this branch track a file where a supported agent reads configuration. Strata looks for paths like these, at the root or in a subfolder:'),
        paths,
        text('p', 'Files elsewhere, such as a top-level skills/ folder, are not read by the supported tools, so Strata does not list them. The analysis scope in the Strata documentation lists every recognized path.'),
      );
      card.hidden = false;
    }`;
