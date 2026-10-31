# Opt-in pull-request delta

Strata can show how a pull request changes your agent configuration. A "delta" here means the difference between two commits. There are two ways to get it:

- the GitHub Action [**Strata agent context check**](https://github.com/marketplace/actions/strata-agent-context-check), listed on the GitHub Marketplace. It is a composite action: a reusable set of workflow steps that runs inside your own job.
- the local `strata diff` command, described under [Local use](#local-use).

To upload the full history report from CI instead, see [Running Strata in CI](ci.md). Neither one runs in a repository until you add a workflow for it.

What the Action does:

- It reads the tracked files (Git blobs) of the checked-out repository at two commits: the base, which you compare from, and the head, which you compare to.
- It measures the instructional text at both commits with the measurement you choose.
- It appends a Markdown delta to the job summary, the page GitHub shows for each workflow run.

What it does not do:

- It changes no working-tree file, branch, or tag.
- It posts no comment on the pull request.
- Token growth never fails it unless you set a [limit](#limits).
- It sends no source text anywhere, unless you set `precise: 'true'` as described under [Measurement](#measurement).

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
      - uses: nabondance/strata@v0.6.0
```
<!-- x-release-please-end -->

The summary contains commit IDs, file paths, category deltas, and up to 25 changed components. It contains no source text. Anyone who can see the workflow run can read those names and paths, so check that this is acceptable before you enable it in a sensitive repository.

The Action needs only the `contents: read` permission. It does not need `pull-requests: write`, and Strata's process needs no token.

## Commits

When you leave the `base` and `head` inputs empty, the Action picks the commits from the event that started the workflow:

| Event                                | Base                       | Head                                        |
| ------------------------------------ | -------------------------- | ------------------------------------------- |
| `pull_request` and its review events | The base branch's tip      | GitHub's merge commit                       |
| `pull_request_target`                | The base branch's tip      | The merge commit named in the event payload |
| `merge_group`                        | The queue entry's base     | The queued commit                           |
| `push`                               | The commit before the push | The commit after the push                   |

### Why the merge commit

For a pull request, GitHub builds a temporary merge commit that merges the pull request into its base branch. On `pull_request`, this is the commit `actions/checkout` checks out. Its first parent is the base branch's tip. Comparing the two shows exactly what merging the pull request would change.

Comparing the base tip with the pull request's last commit would be wrong. If the base branch changed after the pull request branched from it, those changes would also be counted, reversed, as if the pull request had made them. This is why the summary's head is the merge commit, not the pull request's last commit.

### When there is no merge commit

On `pull_request_target`, the merge commit comes from the event payload, and it is not always usable:

- GitHub leaves it out while it is still computing whether the pull request can merge.
- It can still name the merge commit from before the latest push.
- On a `closed` event for a pull request that was squashed or rebased, the pull request's commit on the base branch has only one parent, so it is not a merge.

In these cases the Action compares the base tip with the pull request's head and says so in a warning.

### Pushes that create or delete a branch or tag

A push that creates or deletes a branch or tag has no commit on one side. The Action adds a notice and skips it.

### Other events

On any other event, such as `workflow_dispatch` or `schedule`, set both inputs to full commit IDs (40 hexadecimal characters, or 64 in a SHA-256 repository). Setting them on the events above also overrides the event's commits.

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

### Fetching missing commits

By default `actions/checkout` makes a shallow checkout: it downloads only the one commit it checks out, without the earlier history. The Action therefore fetches any commit it needs from `origin`. The fetch:

- adds Git objects to `.git`;
- in a shallow checkout, adds the fetched commits to the shallow list, so the checkout stays shallow;
- updates `FETCH_HEAD`.

It changes no working-tree file, branch, or tag, and Strata itself only reads.

If the fetch fails, the step says so. This can happen in a private repository checked out with `persist-credentials: false`. To fix it, check out with `fetch-depth: 0`, or keep the persisted credentials. On `pull_request_target`, a fork's commits are not on any branch that `fetch-depth: 0` downloads, so that event needs the credentials.

Strata's own [pull-request workflow](../.github/workflows/strata-pr-delta.yml) runs this way, from a default shallow checkout. It uses `uses: ./` so it tests the code under review.

## Versions

The examples pin the latest release; Release Please updates that version in these docs.

- `nabondance/strata@v0` follows every 0.x release. A minor 0.x release can change the summary or the inputs.
- To change versions only when you choose, pin a release or a commit SHA you have reviewed.

The Action builds Strata from its own source at that version, with the locked dependencies, so it does not depend on npm.

## Outputs

| Output         | Value                                                                                                                                                            |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tokens`       | Stored instructional text at the head, in estimated tokens                                                                                                       |
| `delta-tokens` | Its change from base to head, negative when it shrank                                                                                                            |
| `limit-result` | `over` when at least one limit is passed, `within` when every limit checked is met, `none` when no limit was checked: none was set, or none applied to any agent |
| `summary-file` | Path of the Markdown delta, the same text as the job summary                                                                                                     |
| `json-file`    | Path of the [JSON delta](#local-use), for anything the other outputs leave out                                                                                   |

The outputs are set whenever the summary is written. That includes runs where a limit fails the step, so a later step with `if: always()` can still read them. They are empty when the step skips a push that creates or deletes a branch or tag. If a job runs the Action more than once, each run writes its own files.

```yaml
      - uses: nabondance/strata@v0
        id: strata
      - run: jq '.upFront[] | {provider, tokens: .after.tokens}' "$DELTA"
        env:
          DELTA: ${{ steps.strata.outputs.json-file }}
```

## Measurement

Totals use the byte estimate. Codex files are also counted exactly, offline, with OpenAI's `o200k_base` encoding, and the delta shows them as Codex's own totals. One input adds Claude and Gemini counts:

| Input     | Default   | Effect                                                                              |
| --------- | --------- | ----------------------------------------------------------------------------------- |
| `precise` | `'false'` | `'true'` adds Claude and Gemini totals from their token-count APIs, described below |

### Precise counts

For precise totals per provider, set `precise: 'true'` and give the step the API keys it may use. This sends the recognized Claude and Gemini instruction text from both commits to those providers' token-count APIs:

- Claude is counted with `ANTHROPIC_API_KEY`.
- Gemini is counted with `GEMINI_API_KEY` or `GOOGLE_API_KEY`.
- Codex is counted locally, as without `precise`, so its text is not sent.
- A provider with neither a key nor a signed-in `gcloud` (see below) falls back to the estimate.

<!-- x-release-please-start-version -->
```yaml
      - uses: nabondance/strata@v0.6.0
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
        with:
          precise: 'true'
```
<!-- x-release-please-end -->

A job that signs in `gcloud` first, for example with `google-github-actions/auth`, can count through Vertex AI instead of a Gemini key. Claude also counts through Vertex AI when the step has no `ANTHROPIC_API_KEY`. Pull requests from forks do not receive secrets, so their counts fall back to the estimate.

When Codex reads a file at either commit, the summary gains a table of each provider's totals at both commits, counted on the runner. With `precise: 'true'`, Claude and Gemini join it, with the host that counted them.

## Limits

The Action can check token limits. No limit is set by default: each limit input is off when empty, and every limit is a whole number of tokens.

<!-- x-release-please-start-version -->
```yaml
      - uses: nabondance/strata@v0.6.0
        with:
          limit-increase: 500
          limit-up-front-tokens: claude=8000 codex=6000
          on-limit: warn
```
<!-- x-release-please-end -->

| Input                     | Checks                                                                                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `limit-tokens`            | Stored instructional text at the head                                                                                                   |
| `limit-increase`          | Its growth from base to head                                                                                                            |
| `limit-up-front-tokens`   | What each agent keeps at session start at the head: one number for every agent, or `agent=number` entries separated by spaces or commas |
| `limit-up-front-increase` | Its growth from base to head, in the same form                                                                                          |
| `on-limit`                | `fail` (default) fails the step after the summary is written; `warn` lets it pass. Used only when a limit is set                        |

How results are reported:

- The job summary starts with a table of every limit and its result.
- Each limit that is passed adds an error or warning annotation that names it.
- A session-start limit that applied to no agent adds a warning but never fails the step.

The limits work like `strata diff`'s [limit flags](usage.md#limits): they use the comparison's measurement, never the precise counts. Being over a limit means the configuration passed a number your workflow chose, not that it got worse.

## Local use

The Action runs `strata diff`. To run it yourself:

```sh
strata diff /path/to/repo --base <full-commit-id> --head <full-commit-id> --output delta.md
strata diff /path/to/repo --base <full-commit-id> --head <full-commit-id> --format json --output delta.json
strata diff /path/to/repo --base <full-commit-id> --head <full-commit-id> --output delta.md --json-output delta.json
```

The last form writes both files from one comparison, as the Action does.

The JSON delta has its own schema version, 13, and includes the report's measurement metadata. Both commits are measured the same way. The delta compares stored configuration in Git, not the context an agent loads in a session or the tokens you are billed for.

### What the delta contains

- **Listed skill tokens.** When either commit has a skill manifest, the summary gives the change in listed skill tokens: the names and descriptions an agent keeps in context before a skill is used. Changed manifests get a `Δ listed` column. These are measured separately from the stored-text change, so do not add the two. The summary also counts manifests whose frontmatter Strata could not read; the listing total leaves them out.
- **Up-front and on-demand text.** For each agent whose figures changed, a table gives the stored text it reads up front, at a session started at the repository root, and the rest it reads on demand.
- **MCP servers.** When either commit has a file that can define MCP servers, a line gives the servers the tracked files define at both commits and names those added or removed. A defined server is not necessarily a loaded one, and its tool definitions are not measured.
- **Renames.** Components are matched by provider, category, and path, so a renamed file can appear as one removal plus one addition.
- **Imported files.** Files reached through Claude `@path` imports are included. Adding or dropping an import can therefore list a file as added or removed even though the file did not change; the table marks such files "(imported)".

### How the Action is tested

Strata's [manual Action smoke workflow](https://github.com/nabondance/strata/actions/workflows/action-smoke.yml) runs the Action on GitHub's runner. It compares the last two commits in this repository, from a shallow checkout that lacks the earlier commit, and runs it:

- with a limit it stays within;
- with a limit passed under `warn`;
- with a limit passed under `fail`.

It also checks the outputs.

Its first [run](https://github.com/nabondance/strata/actions/runs/37747127783) succeeded on 2026-10-08, before the Action had outputs. A [run](https://github.com/nabondance/strata/actions/runs/40950923444) on 2026-10-29 covered the fetch, the limits, and the outputs. Together with Strata's own pull requests, this validates the Action on GitHub's runner. It does not test every downstream repository or fork layout.
