# Running Strata in CI

Strata needs only Node.js, Git, and a checkout with history. It reads tracked Git blobs, so it never depends on build output in the working tree and never writes to the repository. There are two ways to use it in CI:

- **Pull-request delta**: the composite Action runs `strata diff` on the PR's base and head commits and writes a Markdown summary of the change in stored configuration to the job summary. See [the PR delta guide](pr-action.md).
- **Full history report**: a workflow runs `strata analyze` and uploads the HTML or JSON report as a workflow artifact. This page describes that setup.

Neither runs unless you add a workflow to the repository you want to analyze.

## Full history report as an artifact

The npm package `context-strata` has not been published yet, so the workflow checks out Strata at a pinned release tag or commit and builds it. Replace `<release-tag-or-commit>` with a reviewed ref.

```yaml
name: Agent context report
on:
  push:
    branches: [main]
  workflow_dispatch:
permissions:
  contents: read
jobs:
  strata:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: actions/checkout@v7
        with:
          repository: nabondance/strata
          ref: <release-tag-or-commit>
          path: .strata-tool
      - uses: pnpm/action-setup@v6
        with:
          package_json_file: .strata-tool/package.json
      - uses: actions/setup-node@v7
        with:
          node-version: '22'
      - name: Build Strata
        working-directory: .strata-tool
        run: |
          pnpm install --frozen-lockfile
          pnpm build
      - name: Analyze history
        run: |
          mkdir -p "$RUNNER_TEMP/strata"
          node .strata-tool/dist/cli.js analyze "$GITHUB_WORKSPACE" --output "$RUNNER_TEMP/strata/report.html"
          node .strata-tool/dist/cli.js analyze "$GITHUB_WORKSPACE" --format json --output "$RUNNER_TEMP/strata/report.json" --quiet
      - uses: actions/upload-artifact@v4
        with:
          name: strata-report
          path: ${{ runner.temp }}/strata/
```

Download `strata-report` from the workflow run and open `report.html` in a browser; it works offline. The JSON report suits scripts, and `strata skill` prints guidance for agents that interpret it.

The Strata checkout in `.strata-tool` is an untracked directory, so it is not part of the analysis. Once the package is published, the checkout and build steps can be replaced with `npx context-strata@<version> analyze …`.

### Checkout depth

Use `fetch-depth: 0`. Strata replays first-parent history, and the default shallow checkout contains only one commit. On a shallow clone, Strata still writes a report but warns on stderr, and the report states that earlier history is missing.

A detached HEAD, which is what `actions/checkout` produces, is fine: Strata analyzes the first-parent history of the checked-out commit. On a `pull_request` event that commit is GitHub's temporary merge commit, so run the full report on pushes to the default branch and use the [PR delta](pr-action.md) for pull requests.

### Measurement

The default `--tokenizer estimate` needs no network access. `--tokenizer openai-o200k_base` or `--model gpt-4o` also count offline. `--provider-api` sends recognized instruction text to the Claude and Gemini token-count APIs and needs `ANTHROPIC_API_KEY` plus `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) as secrets. Leave it off unless that content transfer is acceptable.

### Who can see the report

Reports contain file paths, commit IDs, dates, and measurements, never file contents. Anyone with read access to the repository can download workflow artifacts; for a public repository, that includes any signed-in GitHub user. Add `--shareable` to the `analyze` commands to replace repository names, paths, commit IDs, and blob IDs with aliases, and set `retention-days` on `upload-artifact` if the default retention is too long.

## Exit status

`strata analyze` and `strata diff` exit with 0 on success, 2 for an invalid command line, and 1 for any other failure, such as a missing commit or a path that is not a Git repository. Token growth is never a failure; Strata has no thresholds or gates yet.
