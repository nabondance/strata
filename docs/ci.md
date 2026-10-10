# Running Strata in CI

Strata needs only Node.js, Git, and a checkout with history. It reads tracked Git blobs, so it never depends on build output in the working tree and never writes to the repository. There are three ways to use it in CI:

- **Pull-request delta**: the composite Action runs `strata diff` on the PR's base and head commits and writes a Markdown summary of the change in stored configuration to the job summary. See [the PR delta guide](pr-action.md).
- **Full history report**: a workflow runs `strata analyze` and uploads the HTML or JSON report as a workflow artifact. See [below](#full-history-report-as-an-artifact).
- **README image**: a workflow renders the history as an SVG image and publishes it to a dedicated branch for a README to display. See [below](#readme-image).

None of them runs unless you add a workflow to the repository you want to analyze.

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

Strata analyzes the first-parent history of the checked-out commit, whether the checkout is on a branch or a detached HEAD; a detached checkout is labeled `detached HEAD` instead of a branch name. On a `pull_request` event the checked-out commit is GitHub's temporary merge commit, so run the full report and the image on pushes to the default branch and use the [PR delta](pr-action.md) for pull requests.

### Measurement

The default `--tokenizer estimate` needs no network access. `--tokenizer openai-o200k_base` or `--model gpt-4o` also count offline. `--provider-api` sends recognized instruction text to the Claude and Gemini token-count APIs and needs `ANTHROPIC_API_KEY` plus `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) as secrets. Leave it off unless that content transfer is acceptable.

### Who can see the report

HTML and JSON reports contain file paths, commit IDs, dates, and measurements, never file contents. Anyone with read access to the repository can download workflow artifacts; for a public repository, that includes any signed-in GitHub user. Add `--shareable` to the `analyze` commands to replace repository names, paths, commit IDs, and blob IDs with aliases, and set `retention-days` on `upload-artifact` if the default retention is too long.

## README image

`--format svg` writes a static image of the stored-instruction history: one colored layer per category, the latest totals, and the measurement label. It holds no paths, commit IDs, or file contents, only the repository and branch names, dates, category labels, and totals. It has no script or external resources, so GitHub displays it in a README.

The simplest option is to render it locally and commit it, for example to `docs/strata.svg`, and reference it with `![Agent context through time](docs/strata.svg)`. The image then changes only when you regenerate it.

To keep it current automatically, the workflow below renders the image on every push to `main` and force-pushes it as the single commit of a `strata-image` branch. This keeps the image out of `main`'s history and keeps `strata-image` at one commit. The push uses the job's `GITHUB_TOKEN`, which is why the workflow needs `contents: write`, and it does not trigger other workflows.

```yaml
name: Agent context image
on:
  push:
    branches: [main]
  workflow_dispatch:
permissions:
  contents: write
concurrency:
  group: strata-image
  cancel-in-progress: true
jobs:
  strata-image:
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
      - name: Render image
        run: node .strata-tool/dist/cli.js analyze "$GITHUB_WORKSPACE" --format svg --output "$RUNNER_TEMP/strata-image/strata.svg" --quiet
      - name: Publish to the strata-image branch
        working-directory: ${{ runner.temp }}/strata-image
        env:
          GITHUB_TOKEN: ${{ github.token }}
        run: |
          git init -q -b strata-image
          git add strata.svg
          git -c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" commit -q -m "Update Strata image for $GITHUB_SHA"
          git push --force "https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" HEAD:strata-image
```

In the README of a public repository, reference the published file:

```markdown
![Agent context through time](https://raw.githubusercontent.com/<owner>/<repository>/strata-image/strata.svg)
```

GitHub caches images, so a new version can take a few minutes to appear. Raw URLs of a private repository need authentication and do not display in its README; commit the image to the repository instead.

The image is public wherever the README is. Add `--shareable` to the render command to replace the repository and branch names; the dates and totals stay visible.

## Exit status

`strata analyze` and `strata diff` exit with 0 on success, 2 for an invalid command line, and 1 for any other failure, such as a missing commit or a path that is not a Git repository. Token growth is never a failure; Strata has no thresholds or gates yet.
