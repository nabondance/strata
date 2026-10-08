# Contributing to Strata

Thanks for helping make agent context history easier to understand. Before a substantial change, open an issue to discuss the intended behavior and measurement boundary.

Use Node.js 22.13 or newer and pnpm 10.29.3. Run `pnpm install`, `pnpm typecheck`, and `pnpm test` before proposing a change. For packaging changes, also inspect `pnpm pack` and install the tarball in a clean directory.

Include a short explanation of what changed and how it was tested. Add a synthetic Git-history case when changing extraction, classification, or measurement. Update `docs/analysis-scope.md` or `docs/decisions.md` when the recognized inputs or report contract changes.

Keep analyzed repositories read-only. Reports must work offline, keep source text out of default outputs, and describe stored token estimates without implying actual session or billing tokens. Do not include private repository paths, prompt content, or credentials in issues or test fixtures.

For a security concern, follow [SECURITY.md](SECURITY.md) instead of posting exploit details in a public issue.
