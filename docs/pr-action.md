# Opt-in pull-request delta

The repository provides a composite GitHub Action, **Strata agent context check**, and a local `strata diff` command. To upload the full history report from CI instead, see [Running Strata in CI](ci.md). Neither runs automatically in a repository that has not added a workflow. The Action reads the checked-out repository's tracked blobs at a base and a head commit, applies the selected measurement to instructional text, and appends a Markdown delta to the job summary. It changes no working-tree file, branch, or tag and posts no PR comment, and token growth never fails it unless you set a [limit](#limits). It sends no source text anywhere unless `precise: 'true'` is set, as described below.

Example workflow in the **repository you want to analyze**:

<!-- x-release-please-start-version -->
```yaml
name: Agent context delta
on: pull_request
permissions:
  contents: read
jobs:
  strata:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: nabondance/strata@v0.5.0
```
<!-- x-release-please-end -->

The summary contains commit IDs, file paths, category deltas, and up to 25 changed components, but no source text. Review the summary's metadata visibility before enabling it for sensitive repositories. The Action needs `contents: read`; it does not need `pull-requests: write` or a token in Strata's process.

## Commits

With `base` and `head` left empty, the Action compares the event's own commits:

- On `pull_request` and its review events, GitHub's merge commit (the commit `actions/checkout` checks out) with its first parent, the base branch's tip. That is what merging the pull request would change. Comparing the base tip with the pull request's head instead would also count, reversed, anything the base branch changed after the pull request branched from it. The summary's head is therefore the merge commit, not the pull request's last commit.
- On `pull_request_target`, the same, with the merge commit from the event payload. GitHub leaves it out while it is still computing whether the pull request can merge, and can still name the one from before the latest push. Without a commit that merges the pull request's head into its base, the Action compares the base tip with the head and says so in a warning. That also happens on a `closed` event for a pull request that was squashed or rebased, since its commit on the base branch has one parent.
- On `merge_group`, the queued commit with its base.
- On `push`, the commits before and after the push. A push that creates or deletes a branch or tag has no two commits, so the Action notes that and skips it.

On any other event, such as `workflow_dispatch` or `schedule`, set both inputs to full commit IDs; they also override an event's commits:

```yaml
on:
  workflow_dispatch:
    inputs:
      base:
        description: Full commit ID to compare from
        required: true
# ...
      - uses: nabondance/strata@v0
        with:
          base: ${{ inputs.base }}
          head: ${{ github.sha }}
```

The default `actions/checkout` is shallow and holds only the commit it checks out, so the Action fetches whichever commit it needs from `origin`. That adds Git objects to `.git`, adds the fetched commits to a shallow checkout's shallow list so it stays shallow, and updates `FETCH_HEAD`; it changes no working-tree file, branch, or tag, and Strata itself only reads. If the fetch fails, for example in a private repository checked out with `persist-credentials: false`, the step says so: check out with `fetch-depth: 0`, or keep the persisted credentials. A fork's commits on `pull_request_target` are not among the branches `fetch-depth: 0` fetches, so that event needs the credentials. Strata's own [pull-request workflow](../.github/workflows/strata-pr-delta.yml) runs this way, with `uses: ./` so it tests the code under review.

## Versions

The examples pin the latest release, which Release Please updates in these docs. `nabondance/strata@v0` follows every 0.x release, and a minor 0.x release can change the summary or the inputs; pin a release, or a reviewed commit SHA, to change versions only when you choose. The Action builds Strata from its own source at that version, with the locked dependencies, so it does not depend on npm.

## Outputs

| Output | Value |
| --- | --- |
| `tokens` | Stored instructional text at the head, in tokens, in the run's measurement |
| `delta-tokens` | Its change from base to head, negative when it shrank |
| `limit-result` | `over` when at least one limit is passed, `within` when every limit checked is met, `none` when no limit was checked: none was set, or none applied to any agent |
| `summary-file` | Path of the Markdown delta, the same text as the job summary |
| `json-file` | Path of the [JSON delta](#local-use), for anything the other outputs leave out |

Outputs are set whenever the summary is written, including when a limit fails the step, so a later step that runs `if: always()` can read them. They are empty when the step skips a push that creates or deletes a branch or tag. Each run of the Action in a job writes its own files.

```yaml
      - uses: nabondance/strata@v0
        id: strata
      - run: jq '.upFront[] | {provider, tokens: .after.tokens}' "$DELTA"
        env:
          DELTA: ${{ steps.strata.outputs.json-file }}
```

## Measurement

Set `model: gpt-4o` instead of `tokenizer: estimate` to use a documented local OpenAI model-to-encoding mapping. The Action uses `model` when provided; the default tokenizer is used otherwise.

For precise per-provider totals, set `precise: 'true'` and give the step the keys it may use. This sends recognized Claude and Gemini instruction text from both commits to those providers' token-count APIs; a provider without a key falls back to the estimate, and Codex is counted locally:

<!-- x-release-please-start-version -->
```yaml
      - uses: nabondance/strata@v0.5.0
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
        with:
          precise: 'true'
```
<!-- x-release-please-end -->

A job that authenticates `gcloud` first, for example with `google-github-actions/auth`, can count through Vertex AI instead of a Gemini key. Pull requests from forks do not receive secrets, so their counts fall back to the estimate. The summary then gains a table of each provider's totals at both commits and the host that counted them.

## Limits

The Action can check token limits. None is set by default; each input is off when empty, and every limit is a whole number of tokens.

<!-- x-release-please-start-version -->
```yaml
      - uses: nabondance/strata@v0.5.0
        with:
          limit-increase: 500
          limit-up-front-tokens: claude=8000 codex=6000
          on-limit: warn
```
<!-- x-release-please-end -->

| Input | Checks |
| --- | --- |
| `limit-tokens` | Stored instructional text at the head |
| `limit-increase` | Its growth from base to head |
| `limit-up-front-tokens` | What each agent keeps at session start at the head: one number for every agent, or `agent=number` entries separated by spaces or commas |
| `limit-up-front-increase` | Its growth from base to head, in the same form |
| `on-limit` | `fail` (default) fails the step after the summary is written; `warn` lets it pass. Used only when a limit is set |

The job summary starts with a table of every limit and its result, and each limit passed adds an error or warning annotation that names it. A session-start limit that applied to no agent adds a warning but never fails the step. The limits follow `strata diff`'s [limit flags](usage.md#limits): they use the comparison's measurement, never the precise counts. Being over a limit means the configuration passed a number your workflow chose, not that it got worse.

## Local use

The Action runs `strata diff`. To run it yourself:

```sh
strata diff /path/to/repo --base <full-commit-id> --head <full-commit-id> --output delta.md
strata diff /path/to/repo --base <full-commit-id> --head <full-commit-id> --format json --output delta.json
strata diff /path/to/repo --base <full-commit-id> --head <full-commit-id> --output delta.md --json-output delta.json
```

The last form writes both from one comparison, as the Action does.

The JSON delta has its own schema version 12 and the report's measurement metadata. When either commit has a skill manifest, the summary also gives the change in listed skill tokens, the names and descriptions an agent keeps in context before a skill is used, and a `Δ listed` column for changed manifests; they are measured separately from the stored-text change and must not be added to it, and the summary counts manifests whose frontmatter Strata could not read, which the listing total leaves out. A table gives, for each agent whose figures changed, the stored text listed up front at a session started at the repository root and the rest it reads on demand. When either commit has a file that can define MCP servers, a line gives the servers the tracked files define at both commits and names those added or removed; a defined server is not a loaded one, and its tool definitions are not measured. Component matching uses provider, category, and path, so a rename can appear as removal plus addition. Files that Claude `@path` imports reach are included, so adding or dropping an import can list a file as added or removed although it did not change; the table marks such files "(imported)". The same measurement mode is applied to both endpoints. This compares stored configuration in Git, not loaded session context or billing tokens.

Strata's [manual Action smoke workflow](https://github.com/nabondance/strata/actions/workflows/action-smoke.yml) runs the composite Action on GitHub's runner against the last two commits in this repository, from a shallow checkout that lacks the earlier commit: with a model and a limit it stays within, with a limit passed under `warn` and under `fail`, and it checks the outputs. Its first [run](https://github.com/nabondance/strata/actions/runs/37747127783) succeeded on 2026-10-08, before the Action had outputs; a [run](https://github.com/nabondance/strata/actions/runs/40950923444) on 2026-10-29 covered the fetch, the limits, and the outputs. Together with Strata's own pull requests, this validates the Action on GitHub's runner; it does not test every downstream repository or fork layout.
