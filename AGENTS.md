# Working in Strata

Strata shows how Git-tracked AI-agent configuration changes through time. It analyzes a local repository and writes an offline report. Read [brief.md](brief.md) for product intent, [docs/analysis-scope.md](docs/analysis-scope.md) for recognized inputs, and [docs/decisions.md](docs/decisions.md) for measurement and report contracts when those topics matter to a change.

## Code map

- `src/adapters.ts` recognizes provider paths and assigns provider/category labels.
- `src/analyze.ts` reads first-parent Git history, measures blobs, and builds the report model.
- `src/report.ts` renders the self-contained HTML report; `src/cli.ts` handles command-line input and output.
- `test/analyze.test.mjs` builds a synthetic Git history to verify analysis and CLI behavior.

## Changes that affect analysis

- Keep the target repository read-only. Analyze tracked Git blobs, not the target working tree, and do not upload repository content.
- Distinguish stored instruction estimates from actual loaded context or billing tokens. Structured configuration and supporting resources remain source-only unless a change defines and documents a defensible text boundary.
- Keep conditional loading, renames, and inferred relationships labeled accurately. Do not infer active context or a refactor from path changes alone.
- Keep HTML usable offline and source text out of default HTML/JSON. Escape repository-derived strings before placing them in HTML.
- When changing provider recognition, report fields, or measurement, update the scope/decision docs and cover the behavior in the synthetic history fixture. Version report schema changes.

## Verification

Use Node.js 22.13+ and pnpm 10.29.3. For code changes, run `pnpm typecheck` and `pnpm test`. For packaging changes, inspect `pnpm pack` and try the installed tarball from a clean directory. A real-repository smoke check is useful for history or rendering changes, but never modify the repository being analyzed.

## External tools and services

- Prefer service APIs, MCP integrations, and command-line tools such as `gh` for reading or changing external project data. Check CLI authentication and use the supported API before considering browser automation.
- Use browser automation for visual/UI checks or as a last resort when no suitable API or CLI is available. Never use it as the default way to inspect or manage project boards, issues, pull requests, or repository settings.
