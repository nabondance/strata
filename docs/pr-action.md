# Opt-in pull-request delta

The repository provides a composite GitHub Action and a local `strata diff` command. Neither runs automatically in a repository that has not added a workflow. The Action reads the checked-out repository's tracked blobs at the supplied base and head commit IDs, applies the selected offline measurement to instructional text, and appends a Markdown delta to the job summary. It does not modify the target repository, post a PR comment, upload source text, or treat token growth as a failure.

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

Pin the Action to a reviewed commit or published release tag when one exists. Both commits must be present locally; a shallow checkout may omit the base. The summary contains commit IDs, file paths, category deltas, and up to 25 changed components, but no source text. Review the summary's metadata visibility before enabling it for sensitive repositories. The Action needs `contents: read`; it does not need `pull-requests: write` or a token in Strata's process.

Set `model: gpt-4o` instead of `tokenizer: estimate` to use a documented local OpenAI model-to-encoding mapping. The Action uses `model` when provided; the default tokenizer is used otherwise. Claude and Gemini counts remain estimates.

For local use after building, run:

```sh
node dist/cli.js diff /path/to/repo --base <full-commit-id> --head <full-commit-id> --output delta.md
node dist/cli.js diff /path/to/repo --base <full-commit-id> --head <full-commit-id> --format json --output delta.json
```

The JSON delta has its own schema version 2 and the report's measurement metadata. Component matching uses provider, category, and path, so a rename can appear as removal plus addition. The same measurement mode is applied to both endpoints. This compares stored configuration in Git, not loaded session context or billing tokens.

Strata's [manual Action smoke workflow](https://github.com/nabondance/strata/actions/workflows/action-smoke.yml) tests the composite Action against two commits in this repository. Its first [run](https://github.com/nabondance/strata/actions/runs/37747127783) succeeded on 2026-10-08 and wrote the model-labeled summary. This validates the Action on GitHub's runner; it does not test every downstream repository or fork layout.
