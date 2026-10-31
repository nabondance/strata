# Contributing to Strata

Thanks for helping make agent context history easier to understand. Before a substantial change, open an issue to discuss the intended behavior and what it should measure. Everyone taking part is expected to follow the [code of conduct](CODE_OF_CONDUCT.md).

## Setup and checks

Use Node.js 22.13 or newer, Git 2.31 or newer, and pnpm 10.29.3.

| Command                          | When to run it                                                                                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install`                   | Once, to install dependencies                                                                                                                            |
| `pnpm lint`                      | Before proposing a change                                                                                                                                |
| `pnpm typecheck`                 | Before proposing a change                                                                                                                                |
| `pnpm test`                      | Before proposing a change                                                                                                                                |
| `pnpm format`                    | To apply the formatter and safe lint fixes                                                                                                               |
| `node scripts/smoke-package.mjs` | For packaging changes. It packs Strata, installs the tarball in a clean directory, and runs it on this repository's history                              |
| `pnpm build && pnpm benchmark`   | To analyze a disposable large-history fixture. [The benchmark notes](docs/benchmark.md) describe the baseline and a read-only mode for a real repository |

From a checkout, `node dist/cli.js` or `pnpm dev` runs the CLI in place of `strata`.

## What a change needs

- A short explanation of what changed and how it was tested.
- A synthetic Git-history test case when the change affects extraction, classification, or measurement.
- An update to `docs/analysis-scope.md` or `docs/decisions.md` when the recognized inputs or the report contract change.

Every change must respect these rules:

- Keep analyzed repositories read-only.
- Reports must work offline and keep source text out of default outputs.
- Describe token counts as counts of stored text, without implying they are the tokens of an actual session or a bill.
- Do not include private repository paths, prompt content, or credentials in issues or test fixtures.

## Agent-assisted development

[AGENTS.md](AGENTS.md) gives coding agents the repository's purpose, code map, and checks. [CLAUDE.md](CLAUDE.md) imports that same guidance for Claude Code.

Two optional reviewer agents focus on the correctness and privacy of analysis changes. Invoke one when that focused check is useful:

| Tool        | Reviewer          | Definition                                          |
| ----------- | ----------------- | --------------------------------------------------- |
| Codex       | `strata_reviewer` | [.codex/agents](.codex/agents/strata_reviewer.toml) |
| Claude Code | `strata-reviewer` | [.claude/agents](.claude/agents/strata-reviewer.md) |

## Commit messages and releases

### Commit messages

Write commit subjects as [Conventional Commits](https://www.conventionalcommits.org/): `fix: handle empty repositories`, `feat: add a --since option`, `docs: ...`, `chore: ...`. Mark a breaking change with `!` (`feat!: ...`) or a `BREAKING CHANGE:` footer.

Pull requests are always squash-merged into one commit. The pull request title becomes the commit subject and its description the commit body. So:

- The title needs the same Conventional Commit form; a workflow checks it.
- The description should not contain `feat:` or `fix:` lines of its own. Release Please would count them as extra changes.

Do not edit `CHANGELOG.md` or the version in `package.json` by hand.

### How a release happens

CI runs again on every push to `main`, because two pull requests that pass alone can still break it together. Then:

1. Once CI passes on a `main` commit, [release-please](https://github.com/googleapis/release-please) opens or updates a release pull request. It bumps the version and writes the changelog from the `feat` and `fix` commits since the last release. The release workflow approves its checks; see [below](#approving-the-release-pull-requests-checks).
2. Merging that pull request creates the `vX.Y.Z` tag and the GitHub release. A release is tagged only once CI passes on the release commit itself. If CI failed there, re-run it on that commit; the release is tagged when it passes.
3. The release workflow then starts the publish workflow on that tag. It runs the checks, smoke-tests the packed tarball, and publishes it to npm with trusted publishing, so no npm token is stored. To retry a failed publish, run `gh workflow run publish.yml --ref vX.Y.Z`.
4. The release workflow also moves the major tag (`v0`) to the new release, since workflows can use the Action as `nabondance/strata@v0`. If GitHub refuses, the run warns with the command to move it by hand. `publish.yml` runs only for `vX.Y.Z` tags, so the `v0` tag never publishes.

### Approving the release pull request's checks

The release pull request is updated with `GITHUB_TOKEN`, so its checks wait for approval, and the release workflow approves them. If it cannot, its run fails with a warning. The waiting runs then need approving by hand before the pull request can merge:

```sh
gh api -X POST repos/nabondance/strata/actions/runs/<id>/approve
```

### The Marketplace listing

GitHub has no API for listing a release on the Marketplace. To update the [Marketplace listing](https://github.com/marketplace/actions/strata-agent-context-check) (first listed with 0.6.0):

1. Edit the release on GitHub.
2. Tick **Publish this Action to the GitHub Marketplace**.
3. Save. This needs the owner's two-factor authentication.

The listing shows the README. The Action works from any tag, whether or not its release is listed.

### Canary builds

After CI passes on a `main` commit, the canary workflow replaces the rolling [`canary` prerelease](https://github.com/nabondance/strata/releases/tag/canary) with a tarball of that commit. The tarball is versioned `X.Y.(Z+1)-canary.<commit time>.g<short commit>` and smoke-tested like a release. It is kept on GitHub, not npm, so npm's version list holds only releases.

- To try `main` before it is released: `npm install --global https://github.com/nabondance/strata/releases/download/canary/context-strata.tgz`
- To rebuild it: `gh workflow run canary.yml`

For a security concern, follow [SECURITY.md](SECURITY.md) instead of posting exploit details in a public issue.
