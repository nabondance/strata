# Running Strata in CI

Strata needs only Node.js, Git, and a checkout with history. (The pull-request Action fetches the two commits it needs by itself.) Strata reads the files as Git stores them, not the working tree, so it never depends on build output and never writes to the repository.

There are three ways to use it in CI:

| Use                        | What it does                                                                                                                                                                                                                                                                                                             | Guide                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| **Pull-request delta**     | The Action runs `strata diff` and writes a Markdown summary of how the pull request changes stored configuration to the job summary. It compares GitHub's merge commit for the pull request with the base it merges into, and fetches those commits if the checkout lacks them. It is one step after `actions/checkout`. | [The PR delta guide](pr-action.md)           |
| **Full history report**    | A workflow runs `strata analyze` and uploads the HTML or JSON report as a workflow artifact (a file kept with the workflow run).                                                                                                                                                                                         | [Below](#full-history-report-as-an-artifact) |
| **README image and badge** | A workflow renders the history as an SVG image, plus a badge with the token total, and publishes them to a dedicated branch for a README to display.                                                                                                                                                                     | [Below](#readme-image)                       |

None of them runs unless you add a workflow to the repository you want to analyze.

Strata's own repository runs the [pull-request delta](../.github/workflows/strata-pr-delta.yml) and the [README image](../.github/workflows/strata-image.yml) workflows on itself. The only difference from the examples below is that they build Strata from the checkout instead of running the published package.

## Full history report as an artifact

The workflow runs the published npm package `context-strata` at the version in `STRATA_VERSION`; set it to the version you have reviewed.

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
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7
        with:
          node-version: '22'
      - name: Analyze history
        env:
          STRATA_VERSION: 0.6.0 # x-release-please-version
        run: |
          npx --yes "context-strata@$STRATA_VERSION" analyze "$GITHUB_WORKSPACE" --output "$RUNNER_TEMP/strata/report.html"
          npx --yes "context-strata@$STRATA_VERSION" analyze "$GITHUB_WORKSPACE" --format json --output "$RUNNER_TEMP/strata/report.json" --quiet
      - uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
        with:
          name: strata-report
          path: ${{ runner.temp }}/strata/
```

Download `strata-report` from the workflow run and open `report.html` in a browser; it works offline. The JSON report suits scripts, and `strata skill` prints guidance for agents that interpret it.

Notes on the example:

- Strata creates the output directory itself.
- Each action is pinned to a commit SHA, as this repository's own workflows do. Review and update those pins like any other dependency.
- `persist-credentials: false` keeps the job token out of the checkout's Git configuration, since nothing in the job pushes.

### Checkout depth

Use `fetch-depth: 0`, which downloads the full history. The default checkout is shallow: it contains only one commit. On a shallow clone, Strata still writes a report, but it warns on stderr and the report states that earlier history is missing.

Strata follows the first-parent history of the checked-out commit. It walks back from that commit through each commit's first parent. For a merge commit, the first parent is the tip of the branch that received the merge, so the commits of a merged side branch are not visited one by one.

This works whether the checkout is on a branch or on a detached HEAD (a commit checked out without a branch). A detached checkout is labeled `detached HEAD` instead of a branch name.

On a `pull_request` event, the checked-out commit is GitHub's temporary merge commit. So run the full report and the image on pushes to the default branch, and use the [PR delta](pr-action.md) for pull requests.

### Measurement

Totals use the byte estimate, and Codex files are also counted exactly with OpenAI's `o200k_base` encoding, all offline. The one measurement flag sends content:

| Flag        | Network                                                                     | Notes                                                         |
| ----------- | --------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `--precise` | Sends recognized instruction text to the Claude and Gemini token-count APIs | Add `--no-cache` on runners that are discarded after each job |

`--precise` uses a provider's API when it finds `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` (or `GOOGLE_API_KEY`), or a signed-in `gcloud` account in the job. It falls back to the estimate for a provider without one. Leave it off unless sending that content is acceptable.

### Who can see the report

HTML and JSON reports contain file paths, commit IDs, dates, measurements, and the names of the MCP servers that tracked files define. They never contain other file contents.

Anyone with read access to the repository can download workflow artifacts. For a public repository, that includes any signed-in GitHub user. To limit what they see:

- Add `--shareable` to the `analyze` commands. It replaces repository names, paths, commit IDs, blob IDs, and MCP server names with aliases.
- Set `retention-days` on `upload-artifact` if the default retention is too long.

## README image

`--format svg` writes a static image of the stored-instruction history: one colored layer per category, the latest totals, and the measurement label.

- It holds no paths, commit IDs, or file contents. It shows only the repository and branch names, dates, category labels, and totals.
- It has no script or external resources, so GitHub displays it in a README.
- Add `--minimal` for the layers alone, without text, axes, or legend.

### Commit the image

The simplest option is to render the image locally and commit it, for example to `docs/strata.svg`, and reference it with `![Agent context through time](docs/strata.svg)`. The image then changes only when you regenerate it.

### Publish it from a workflow

To keep the image current automatically, the workflow below runs on every push to `main`. It:

1. renders the image, together with a `strata-badge.json` file for a [shields.io endpoint badge](https://shields.io/badges/endpoint-badge) that shows the latest total;
2. force-pushes both files as the single commit of a `strata-image` branch.

This keeps the image out of `main`'s history, and keeps `strata-image` at one commit.

Permissions are split between two jobs:

- The `render` job runs with read-only permissions.
- The `publish` job runs no project or dependency code. It alone gets `contents: write`, to push the image with the job's `GITHUB_TOKEN`. A push made with that token does not trigger other workflows.

```yaml
name: Agent context image
on:
  push:
    branches: [main]
  workflow_dispatch:
permissions:
  contents: read
concurrency:
  group: strata-image
  cancel-in-progress: true
jobs:
  render:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7
        with:
          node-version: '22'
      - name: Render image and badge
        env:
          STRATA_VERSION: 0.6.0 # x-release-please-version
        run: |
          npx --yes "context-strata@$STRATA_VERSION" analyze "$GITHUB_WORKSPACE" --format svg --output "$RUNNER_TEMP/strata-image/strata.svg" --quiet
          npx --yes "context-strata@$STRATA_VERSION" analyze "$GITHUB_WORKSPACE" --format badge --output "$RUNNER_TEMP/strata-image/strata-badge.json" --quiet
      - uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
        with:
          name: strata-image
          path: ${{ runner.temp }}/strata-image/
  publish:
    needs: render
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.1
        with:
          name: strata-image
          path: strata-image
      - name: Publish to the strata-image branch
        working-directory: strata-image
        env:
          GITHUB_TOKEN: ${{ github.token }}
        run: |
          git init -q -b strata-image
          git add strata.svg strata-badge.json
          git -c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" commit -q -m "Update Strata image for $GITHUB_SHA"
          git push --force "https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" HEAD:strata-image
```

In the README of a public repository, reference the published files:

```markdown
![Agent context through time](https://raw.githubusercontent.com/<owner>/<repository>/strata-image/strata.svg)
![Agent context](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/<owner>/<repository>/strata-image/strata-badge.json)
```

The badge reads `agent context | ≈1,151 tokens`. The `≈` marks the estimate. The JSON holds that number only, with no repository name, path, or commit ID. Shields caches it for a few minutes.

GitHub also caches images, so a new version can take a few minutes to appear.

In a private repository, raw URLs need authentication and do not display in the README. Commit the image to the repository instead.

The image is public wherever the README is. Add `--shareable` to the render command to replace the repository and branch names; the dates and totals stay visible.

## Exit status

`strata analyze` and `strata diff` exit with these statuses:

| Status | Meaning                                                                                                                                       |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 0      | Success                                                                                                                                       |
| 1      | Any other failure, such as a missing commit or a path that is not a Git repository                                                            |
| 2      | Invalid command line                                                                                                                          |
| 3      | A [limit](usage.md#limits) set with `--limit-tokens`, `--limit-increase`, `--limit-up-front-tokens`, or `--limit-up-front-increase` is passed |
- Token growth alone is never a failure: without a limit, a run that measures growth exits with 0.
- With `--on-limit warn`, a passed limit is reported and the run exits with 0.
- If something fails after a passed limit was reported, such as `--open` failing, the status stays 3, and the error is still printed.
