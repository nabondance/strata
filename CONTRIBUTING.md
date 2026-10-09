# Contributing to Strata

Thanks for helping make agent context history easier to understand. Before a substantial change, open an issue to discuss the intended behavior and measurement boundary. Everyone taking part is expected to follow the [code of conduct](CODE_OF_CONDUCT.md).

Use Node.js 22.13 or newer, Git 2.31 or newer, and pnpm 10.29.3. Run `pnpm install`, `pnpm lint`, `pnpm typecheck`, and `pnpm test` before proposing a change; `pnpm format` applies the formatter and safe lint fixes. For packaging changes, also inspect `pnpm pack` and install the tarball in a clean directory.

Include a short explanation of what changed and how it was tested. Add a synthetic Git-history case when changing extraction, classification, or measurement. Update `docs/analysis-scope.md` or `docs/decisions.md` when the recognized inputs or report contract changes.

Keep analyzed repositories read-only. Reports must work offline, keep source text out of default outputs, and describe stored token estimates without implying actual session or billing tokens. Do not include private repository paths, prompt content, or credentials in issues or test fixtures.

## Commit messages and releases

Write commit subjects as [Conventional Commits](https://www.conventionalcommits.org/): `fix: handle empty repositories`, `feat: add a --since option`, `docs: ...`, `chore: ...`. Mark a breaking change with `!` (`feat!: ...`) or a `BREAKING CHANGE:` footer. When a pull request is squash-merged, its title becomes the commit subject, so the title needs the same form.

Do not edit `CHANGELOG.md` or the version in `package.json` by hand. On every push to `main`, [release-please](https://github.com/googleapis/release-please) opens or updates a release pull request that bumps the version and writes the changelog from `feat` and `fix` commits since the last release. Merging that pull request creates the `vX.Y.Z` tag and GitHub release. Publishing to npm is then one deliberate step: `gh workflow run publish.yml --ref vX.Y.Z`.

For a security concern, follow [SECURITY.md](SECURITY.md) instead of posting exploit details in a public issue.
