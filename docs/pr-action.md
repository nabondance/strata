# Opt-in pull-request delta

The repository provides a composite GitHub Action and a local `strata diff` command. To upload the full history report from CI instead, see [Running Strata in CI](ci.md). Neither runs automatically in a repository that has not added a workflow. The Action reads the checked-out repository's tracked blobs at the supplied base and head commit IDs, applies the selected offline measurement to instructional text, and appends a Markdown delta to the job summary. It does not modify the target repository, post a PR comment, upload source text, or treat token growth as a failure.

Example workflow in the **repository you want to analyze**:

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
        with:
          fetch-depth: 0
      - uses: nabondance/strata@<release-tag-or-commit>
        with:
          base: ${{ github.event.pull_request.base.sha }}
          head: ${{ github.event.pull_request.head.sha }}
          tokenizer: estimate
```

Pin the Action to a reviewed commit or published release tag when one exists. Strata's own [pull-request workflow](../.github/workflows/strata-pr-delta.yml) uses `uses: ./` so it runs the code under review. Both commits must be present locally; a shallow checkout may omit the base. The summary contains commit IDs, file paths, category deltas, and up to 25 changed components, but no source text. Review the summary's metadata visibility before enabling it for sensitive repositories. The Action needs `contents: read`; it does not need `pull-requests: write` or a token in Strata's process.

Set `model: gpt-4o` instead of `tokenizer: estimate` to use a documented local OpenAI model-to-encoding mapping. The Action uses `model` when provided; the default tokenizer is used otherwise.

For precise per-provider totals, set `precise: 'true'` and give the step the keys it may use. This sends recognized Claude and Gemini instruction text from both commits to those providers' token-count APIs; a provider without a key falls back to the estimate, and Codex is counted locally:

```yaml
      - uses: nabondance/strata@<release-tag-or-commit>
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
        with:
          base: ${{ github.event.pull_request.base.sha }}
          head: ${{ github.event.pull_request.head.sha }}
          precise: 'true'
```

A job that authenticates `gcloud` first, for example with `google-github-actions/auth`, can count through Vertex AI instead of a Gemini key. Pull requests from forks do not receive secrets, so their counts fall back to the estimate. The summary then gains a table of each provider's totals at both commits and the host that counted them.

For local use after building, run:

```sh
node dist/cli.js diff /path/to/repo --base <full-commit-id> --head <full-commit-id> --output delta.md
node dist/cli.js diff /path/to/repo --base <full-commit-id> --head <full-commit-id> --format json --output delta.json
```

The JSON delta has its own schema version 5 and the report's measurement metadata. Component matching uses provider, category, and path, so a rename can appear as removal plus addition. The same measurement mode is applied to both endpoints. This compares stored configuration in Git, not loaded session context or billing tokens.

Strata's [manual Action smoke workflow](https://github.com/nabondance/strata/actions/workflows/action-smoke.yml) tests the composite Action against two commits in this repository. Its first [run](https://github.com/nabondance/strata/actions/runs/37747127783) succeeded on 2026-10-08 and wrote the model-labeled summary. This validates the Action on GitHub's runner; it does not test every downstream repository or fork layout.
