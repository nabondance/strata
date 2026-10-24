# Contributing to Strata

Thanks for helping make agent context history easier to understand. Before a substantial change, open an issue to discuss the intended behavior and measurement boundary. Everyone taking part is expected to follow the [code of conduct](CODE_OF_CONDUCT.md).

Use Node.js 22.13 or newer, Git 2.31 or newer, and pnpm 10.29.3. Run `pnpm install`, `pnpm lint`, `pnpm typecheck`, and `pnpm test` before proposing a change; `pnpm format` applies the formatter and safe lint fixes. For packaging changes, also run `node scripts/smoke-package.mjs`, which packs Strata, installs the tarball in a clean directory, and runs it on this repository's history.

Include a short explanation of what changed and how it was tested. Add a synthetic Git-history case when changing extraction, classification, or measurement. Update `docs/analysis-scope.md` or `docs/decisions.md` when the recognized inputs or report contract changes.

Keep analyzed repositories read-only. Reports must work offline, keep source text out of default outputs, and describe stored token estimates without implying actual session or billing tokens. Do not include private repository paths, prompt content, or credentials in issues or test fixtures.

Run `pnpm build && pnpm benchmark` for a disposable large-history analysis fixture; [the benchmark notes](docs/benchmark.md) describe the baseline and a read-only real-repository mode. From a checkout, `node dist/cli.js` or `pnpm dev` runs the CLI in place of `strata`.

## Agent-assisted development

[AGENTS.md](AGENTS.md) gives coding agents the repository's purpose, code map, and checks. [CLAUDE.md](CLAUDE.md) imports that same guidance for Claude Code. Optional `strata_reviewer` for Codex and `strata-reviewer` for Claude Code focus on the correctness and privacy of analysis changes; their definitions live in [.codex/agents](.codex/agents/strata_reviewer.toml) and [.claude/agents](.claude/agents/strata-reviewer.md). Invoke a reviewer when that focused check is useful.

## Commit messages and releases

Write commit subjects as [Conventional Commits](https://www.conventionalcommits.org/): `fix: handle empty repositories`, `feat: add a --since option`, `docs: ...`, `chore: ...`. Mark a breaking change with `!` (`feat!: ...`) or a `BREAKING CHANGE:` footer. Pull requests are always squash-merged: the pull request title becomes the commit subject and its description the commit body, so the title needs the same form (a workflow checks it) and the description should not contain `feat:` or `fix:` lines of its own, which release-please would count as extra changes.

Do not edit `CHANGELOG.md` or the version in `package.json` by hand. CI runs again on every push to `main`, because two pull requests that pass alone can still break it together. Once CI passes on a `main` commit, [release-please](https://github.com/googleapis/release-please) opens or updates a release pull request that bumps the version and writes the changelog from `feat` and `fix` commits since the last release. Merging that pull request creates the `vX.Y.Z` tag and GitHub release, and starts the publish workflow on that tag. It runs the checks, smoke-tests the packed tarball, and publishes it to npm with trusted publishing, so no npm token is stored. The release pull request's updates come from `GITHUB_TOKEN`, so its checks wait for approval; the release workflow approves them. If it cannot, it says so in a warning, and the waiting runs need approving by hand (`gh api -X POST repos/nabondance/strata/actions/runs/<id>/approve`) before the pull request can merge. A release is tagged only once CI passes on the release commit itself; if it failed, re-run it on that commit and the release is tagged when it passes. To retry a failed publish, run `gh workflow run publish.yml --ref vX.Y.Z`.

After CI passes on a `main` commit, the canary workflow also replaces the rolling [`canary` prerelease](https://github.com/nabondance/strata/releases/tag/canary) with a tarball of that commit, versioned `X.Y.(Z+1)-canary.<commit time>.g<short commit>` and smoke-tested like a release. It is kept on GitHub, not npm, so npm's version list holds only releases. Install it with `npm install --global https://github.com/nabondance/strata/releases/download/canary/context-strata.tgz` to try `main` before it is released, and run `gh workflow run canary.yml` to rebuild it.

For a security concern, follow [SECURITY.md](SECURITY.md) instead of posting exploit details in a public issue.
