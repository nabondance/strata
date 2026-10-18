# Working in Strata

Strata shows how Git-tracked AI-agent configuration changes through time. It analyzes a local repository and writes an offline report. Read [brief.md](brief.md) for product intent, [docs/analysis-scope.md](docs/analysis-scope.md) for recognized inputs, and [docs/decisions.md](docs/decisions.md) for measurement and report contracts when those topics matter to a change.

## Where to work

Unless the user says otherwise, work in a new Git worktree on a new branch created from an up-to-date `main`, not in the main checkout: `git fetch origin`, then `git worktree add .claude/worktrees/<name> -b <type>/<name> origin/main`, then `pnpm install` inside it. Leave the main checkout on `main` and untouched. Remove the worktree once its branch is merged or abandoned.

## Code map

- `src/adapters.ts` recognizes provider paths and assigns provider/category labels.
- `src/git.ts` runs read-only Git commands: the streamed history log, tree listings, and batched blob reads.
- `src/analyze.ts` replays first-parent history into revisions; `src/inventory.ts` measures blobs and derives totals; `src/model.ts` holds the report types. `src/skill-listing.ts` reads skill frontmatter to measure the name and description an agent lists before a skill is used; `src/rule-loading.ts` reads root rule frontmatter to decide whether a rule loads at launch, and `upFrontContext` in `src/up-front.ts` splits what each provider reads into what it keeps from the start of a session and what it reads on demand. `src/gemini-settings.ts` reads the tracked `.gemini/settings.json` to decide, per revision, which context files Gemini CLI reads; `providerReads` in `src/provider-view.ts` is the single rule for whether a provider reads a component. `src/precise.ts` chooses each provider's counting methods for `--precise`; `src/provider-counting.ts` runs them with fallback, shared by `analyze` and `diff`; `src/provider-count.ts` calls the provider count endpoints with retries; `src/count-cache.ts` keeps remote counts between runs. `src/submodules.ts` counts recognized files in checked-out submodules, so a report can name configuration it did not analyze. `src/claude-imports.ts` parses Claude `@path` imports and adds the files they reach to each revision; `importLinks` in `src/import-links.ts` derives a revision's import edges and unresolved imports from its inventory.
- `src/expand.ts` rebuilds each revision's inventory from the report's component table and per-revision changes; reports never store a per-revision file list.
- `src/pr-delta.ts` compares two commits for `strata diff`, sharing the same inventory code.
- `src/report.ts` renders the self-contained HTML report and `src/svg.ts` the static SVG image; both take category colors from `src/palette.ts` and the logo mark from `src/brand.ts`. `src/brand-font.ts` is the embedded display font; [docs/brand](docs/brand/README.md) explains how it is built. `src/cli.ts` handles command-line input and output.
- `src/expand.ts`, `src/compare.ts`, `src/provider-view.ts`, `src/import-links.ts`, `src/treemap.ts`, `src/timeline.ts`, and `upFrontContext` in `src/up-front.ts` are embedded into the HTML report as source text, so each must stay self-contained; the exceptions are `viewRevision`, which may call `providerReads`, and `upFrontContext`, which may call `providerReads` and `importLinks`, all embedded beside them.
- `test/analyze.test.mjs` and `test/cli.test.mjs` build synthetic Git histories to verify analysis and CLI behavior.
- `skills/strata-interpret` is the skill Strata ships to its users. The agent configuration for working on this repository is kept as plain copies, one per tool: `.claude/agents` and `.codex/agents` for the reviewer, `.claude/skills` and `.agents/skills` for skills. Change both copies together. Do not use symlinks: Strata skips them, so its report on this repository would miss the file.

## Changes that affect analysis

- Keep the target repository read-only. Analyze tracked Git blobs, not the target working tree, and do not upload repository content.
- Distinguish stored instruction estimates from actual loaded context or billing tokens. Structured configuration and supporting resources remain source-only unless a change defines and documents a defensible text boundary.
- Keep conditional loading, renames, and inferred relationships labeled accurately. Do not infer active context or a refactor from path changes alone.
- Keep HTML usable offline and source text out of default HTML/JSON. Escape repository-derived strings before placing them in HTML.
- When changing provider recognition, report fields, or measurement, update the scope/decision docs and cover the behavior in the synthetic history fixture. Version report schema changes.

## Verification

Use Node.js 22.13+ and pnpm 10.29.3. For code changes, run `pnpm lint`, `pnpm typecheck`, and `pnpm test`; `pnpm format` applies formatting. Use Conventional Commit subjects (`fix:`, `feat:`, `docs:`); the changelog and version are generated from them, so do not edit `CHANGELOG.md` by hand. For packaging changes, inspect `pnpm pack` and try the installed tarball from a clean directory. A real-repository smoke check is useful for history or rendering changes, but never modify the repository being analyzed.

## External tools and services

- Prefer service APIs, MCP integrations, and command-line tools such as `gh` for reading or changing external project data. Check CLI authentication and use the supported API before considering browser automation.
- When a pull request changes anything visible (the HTML report, the SVG image, README or brand images), put before and after screenshots in its description, captured at the same size and state, each with a caption that says what changed and where to look. Upload them with `gh`'s `--attach` flag (`gh pr create`, `gh pr edit`, `gh pr comment`), for example `gh pr comment 16 --attach './after.png#After: the legend groups files by category'`. Do not commit an image or link to a branch file only to display it in a pull request. The `pr-screenshots` skill has the full steps.
- Use browser automation for visual/UI checks or as a last resort when no suitable API or CLI is available. Never use it as the default way to inspect or manage project boards, issues, pull requests, or repository settings.
