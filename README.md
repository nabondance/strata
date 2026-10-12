<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://cdn.jsdelivr.net/npm/context-strata@latest/docs/brand/logo-wordmark-dark.svg">
    <img src="https://cdn.jsdelivr.net/npm/context-strata@latest/docs/brand/logo-wordmark.svg" alt="Strata" width="272">
  </picture>
</h1>

**See how your agent context evolved across Git history.**

Your `CLAUDE.md`, `AGENTS.md`, skills, rules, and agent definitions started small. Then every incident, convention, and "always remember to…" got appended. Strata replays your Git history and shows what that configuration weighs today, when it grew, and which files did it.

```sh
npx context-strata analyze --open
```

One command, run inside any Git repository. You get a single offline HTML report. Nothing is uploaded and the repository is never modified.

![The Strata report: stored instruction tokens per revision, stacked by category](https://cdn.jsdelivr.net/npm/context-strata@latest/docs/images/report-timeline.png)

The screenshots on this page are Strata's report on its own repository.

## What you get

- **A timeline** of stored instruction tokens across your branch's history, split by category.
- **A treemap** of any revision, so the file eating most of the budget is the biggest rectangle.
- **A comparison** between any two revisions, with signed token and file-count changes per provider, category, and file.
- **Per-provider views** for Claude Code, Codex, and Gemini CLI, with shared files such as `AGENTS.md` counted once in the overall total.
- **A pull-request delta**, as Markdown or JSON, to see what a change adds before it merges.
- **An SVG image** of the history to embed in your own README, in full or as the layers alone (`--minimal`).
- **JSON output** for your own scripts, plus a bundled skill that teaches a coding agent how to read it.

The treemap sizes each file by its stored-text tokens at the selected revision:

![Treemap of instruction files at one revision, sized by tokens and colored by category](https://cdn.jsdelivr.net/npm/context-strata@latest/docs/images/report-treemap.png)

Pick any two revisions to see what changed between them:

![Comparison of two revisions with token and file deltas by provider, category, and file](https://cdn.jsdelivr.net/npm/context-strata@latest/docs/images/report-compare.png)

From the command line, `strata diff` prints a summary like this one:

```text
Stored instructional text: +330 tokens (681 → 1011); tracked files: 0 (4 → 4).

| File      | Change | Δ tokens |
| --------- | ------ | -------: |
| AGENTS.md | edited |     +330 |
```

## Is it for you?

Strata is useful if you maintain agent configuration in a repository and want to answer questions like:

- When did our instructions double, and which commit did it?
- Did moving guidance from the root file into skills actually shrink it?
- How much does this pull request add?
- Which skills carry the most text and bundled resources?

It is honest about what it cannot tell you. Strata measures the text **stored in Git**. It counts every tracked instruction file, including skills and nested instructions that an agent only loads on demand, so totals describe what the repository holds, not what a session loaded or what you were billed.

## Private by default

- **Read-only.** Strata reads tracked Git blobs. It never touches your working tree, index, or history.
- **Offline.** No network access, unless you explicitly opt in to provider token-count APIs with `--provider-api`.
- **No file contents in reports.** HTML and JSON hold paths, commit IDs, dates, and measurements, never the text of your instructions.
- **Shareable mode.** `--shareable` replaces repository and branch names, paths, and commit IDs with stable aliases before you send a report to someone else.

## Usage

Requires Node.js 22.13 or newer and Git 2.31 or newer.

```sh
# Analyze the current repository and open the report
npx context-strata analyze --open

# Analyze another repository and choose where the report goes
npx context-strata analyze ~/src/project --output report.html

# Machine-readable output
npx context-strata analyze --format json --output report.json

# A picture of the history for your README
npx context-strata analyze --format svg --output docs/strata.svg

# What changed between two commits
npx context-strata diff --base <base-commit> --head <head-commit>
```

Install it globally with `npm install --global context-strata` to get the `strata` command. Run `strata --help` or `strata <command> --help` for every option.

### Token counts

By default Strata estimates tokens as UTF-8 bytes divided by four: fast, offline, and consistent across a whole history. For offline OpenAI encoding counts, pass `--model gpt-4o` or `--tokenizer openai-o200k_base`. Every report names the method it used. See [the tokenizer study](docs/tokenizers.md) for the evidence and limits.

### In pull requests

An opt-in [GitHub Action](docs/pr-action.md) writes the configuration delta of a pull request to the job summary. It needs only `contents: read` and posts no comments. [Running Strata in CI](docs/ci.md) covers publishing the full report or keeping a README image current.

## What Strata recognizes

Claude Code, Codex, and Gemini CLI configuration tracked in the repository: root and nested instruction files, skills with their bundled resources, agents, rules, commands, and settings. Structured configuration and supporting resources are measured in bytes rather than given an invented token count. [The analysis scope](docs/analysis-scope.md) lists every recognized path.

## Learn more

- [Using Strata](docs/usage.md): CLI output options, reading the report, and the JSON format.
- [Running Strata in CI](docs/ci.md): reports, README images, and pull-request deltas from a workflow.
- [Analysis scope](docs/analysis-scope.md): recognized paths and exclusions.
- [Decisions](docs/decisions.md): measurement and report contracts.
- [Benchmark notes](docs/benchmark.md): performance on large histories.
- [Changelog](CHANGELOG.md)

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers the development setup and checks, [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) the community expectations, and [SECURITY.md](SECURITY.md) how to report a vulnerability.

Strata is released under the [MIT license](LICENSE).
