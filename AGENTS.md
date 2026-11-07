# Working in Strata

Strata shows how Git-tracked AI-agent configuration changes through time. It analyzes a local repository and writes an offline report. Read [README.md](README.md) for what it does for users, [docs/analysis-scope.md](docs/analysis-scope.md) for recognized inputs, and [docs/decisions.md](docs/decisions.md) for measurement and report contracts when those topics matter to a change.

## Where to work

Unless the user says otherwise, work in a new Git worktree on a new branch from an up-to-date `main`: `git fetch origin main`, then `git worktree add --no-track -b <type>/<name> .claude/worktrees/<name> origin/main`, then `pnpm install` inside it. Push with `git push -u origin HEAD`. Leave the main checkout on `main` and untouched. Remove the worktree once its branch is merged or abandoned.

## Code map

- **Analysis.** `src/analyze.ts` replays first-parent history into revisions, `src/inventory.ts` measures them, and `src/model.ts` holds the report types. `src/adapters.ts` recognizes provider paths. `src/git.ts` runs read-only Git commands. `src/content-pass.ts` reads each blob once and hands it to every step that needs it; each step is a `ContentUse`. `providerReads` in `src/provider-view.ts` is the single rule for whether a provider reads a component. The other measurement modules are named for what they measure (skill listings, rule loading, up-front context, MCP servers, Gemini settings, Claude imports, instruction age, submodules).
- **Token counts.** `src/precise.ts` chooses each provider's counting methods: Codex is counted locally on every run, Claude and Gemini only with `--precise`. `src/provider-counting.ts` runs them with fallback for both `analyze` and `diff`.
- **Reports store no per-revision file list.** `src/expand.ts` rebuilds each revision's inventory from the component table and per-revision changes.
- **`strata diff`** is `src/pr-delta.ts`, sharing the inventory code. `src/limits.ts` handles `--limit-*` and `src/ignore.ts` handles `--ignore`, for both commands.
- **Report.** `src/report.ts` assembles the HTML from `src/report`: styles, markup, and the client script cut by panel under `src/report/client`. The client parts share one scope; panel parts only declare state and functions, and `src/report/client/start.ts` runs the startup last. `src/svg.ts` renders the SVG image. Colors come from `src/palette.ts`, the logo from `src/brand.ts`.
- **Embedded as source text.** `src/expand.ts`, `src/compare.ts`, `src/provider-view.ts`, `src/import-links.ts`, `src/treemap.ts`, `src/config-map.ts`, `src/timeline.ts`, `instructionAges` in `src/instruction-age.ts`, and `upFrontContext` in `src/up-front.ts` are copied into the HTML report as text, so each must stay self-contained. The exceptions, embedded beside them: `viewRevision` may call `providerReads`, `upFrontContext` may call `providerReads` and `importLinks`, and `expandRevisions` may call `fillRevisions`.
- **GitHub Action.** `action.yml` installs the npm package when its `dist/source-digest.txt` matches the Action's source and its provenance checks out, and builds from source otherwise (`test/action-install.test.mjs`). Its compare step imports `limitResult` from the built `dist/limits.js`, so renaming or moving that export breaks the Action although the typecheck passes; `actionRunner` in `test/cli.test.mjs` runs the step. `action.yml`, every workflow that can write (a `write` permission, or no top-level `permissions`), and the local reusable workflows they call pin actions to a commit SHA; read-only workflows use release tags (`test/workflow-pins.test.mjs`).
- **Demo site.** `scripts/demo-site.mjs` builds the gallery that `.github/workflows/demo-site.yml` publishes, from the npm release named in `package.json`.
- **Tests.** Synthetic Git histories (`test/synthetic-repo.mjs`) verify analysis and CLI behavior: `test/analyze.test.mjs`, `test/cli.test.mjs`, one `test/<provider>-adapter.test.mjs` per Gemini, Cursor, and Copilot, and one file per feature. `test/report-ui.mjs` runs the report's script against a fake DOM.
- **Agent configuration.** `skills/strata-interpret` is the skill Strata ships to users. This repository's own agent files are plain copies, one per tool: `.claude/agents` and `.codex/agents`, `.claude/skills` and `.agents/skills`. Change both copies together (`test/agent-config.test.mjs` checks the skills). Do not use symlinks: Strata skips them, so its report on this repository would miss the file.

## Changes that affect analysis

- Keep the target repository read-only. Analyze tracked Git blobs, not the working tree, and upload no repository content. The one exception is the Action, which may fetch commits a CI checkout lacks into its `.git`; it changes no working-tree file, branch, or tag.
- Distinguish stored instruction estimates from loaded context or billing tokens. Structured configuration and supporting resources stay source-only unless a change defines and documents a defensible text boundary.
- Label conditional loading, renames, and inferred relationships accurately. Do not infer active context or a refactor from path changes alone.
- Keep HTML usable offline and source text out of default HTML/JSON. Escape repository-derived strings before placing them in HTML.
- When changing provider recognition, report fields, or measurement, update the scope/decision docs and cover the behavior in the matching synthetic history test. Version report schema changes.

## Verification

Use Node.js 22.13+ and pnpm 10.29.3. For code changes, run `pnpm lint`, `pnpm typecheck`, and `pnpm test`; `pnpm format` applies formatting. Use Conventional Commit subjects (`fix:`, `feat:`, `docs:`); the changelog and version come from them, so do not edit `CHANGELOG.md`. For packaging changes, run `node scripts/smoke-package.mjs`. Never modify a repository you analyze for a smoke check.

## External tools and services

- Use `gh`, service APIs, and MCP integrations for project data. Use browser automation only for visual checks or when no API or CLI can do the job, never by default for issues, pull requests, boards, or settings.
- When a pull request changes anything visible (the HTML report, the SVG image, README or brand images), add before and after screenshots, at the same size and state, each captioned with what changed and where to look. Upload them with `gh --attach`; do not commit images to display them. The `pr-screenshots` skill has the steps.
