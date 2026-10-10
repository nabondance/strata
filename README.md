# strata

See how your agent context evolved across Git history.

Strata is in early development. The CLI reads tracked configuration across Git history and produces an offline interactive report. See [the project foundation](brief.md), [the current analysis scope](docs/analysis-scope.md), and [first-release decisions](docs/decisions.md).

See [the tokenizer study](docs/tokenizers.md) for the evidence and limits behind optional local token-counting modes.

Strata is released under the [MIT license](LICENSE). See [CONTRIBUTING.md](CONTRIBUTING.md) for development and contribution guidance, [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for community expectations, and [SECURITY.md](SECURITY.md) for vulnerability reporting.

## Using the CLI

Strata reads tracked Git blobs from a repository's first-parent history and creates a local report of how recognized agent configuration changed over time. It does not inspect the repository's working tree or send its contents anywhere. The report inventories supported Claude, Codex, and Gemini CLI instruction, skill, agent, rule, and configuration paths. Instructional text gets a labeled stored-text token measurement; structured configuration and supporting resources are measured in source bytes. These measurements do not show what an agent loaded in a session. Reports include paths and measurements, never file contents.

To run from a checkout, install dependencies and build the CLI:

```sh
pnpm install
pnpm build
```

Analyze a repository to create the interactive HTML report:

```sh
node dist/cli.js analyze /path/to/git/repository
```

The repository argument defaults to the current directory. By default, Strata writes the report to a private temporary directory and prints its path. Use `--open` to open HTML in a browser or `--output report.html` (`-o`) to choose a destination. For machine-readable output, use `--format json` (`-f json`), and `--output -` to write the report to standard output for another program. Progress and the summary go to stderr in that case; `--quiet` silences both and prints only the report path.

```sh
node dist/cli.js analyze /path/to/repository --open
node dist/cli.js analyze /path/to/repository --format json --output report.json
node dist/cli.js analyze --format json --output - | jq '.revisions[] | [.date, .estimatedTokens]'
```

Strata exits with status 0 on success, 2 when the command line is invalid, and 1 for any other failure, such as a path that is not a Git repository.

Compare two full commit IDs with `diff`. It reads both revisions directly from Git and prints a Markdown summary by default; choose `--format json` for structured data or `--output` to save the result.

```sh
node dist/cli.js diff /path/to/repository --base <base-commit> --head <head-commit>
node dist/cli.js diff /path/to/repository --base <base-commit> --head <head-commit> --format json --output delta.json
```

The default `--tokenizer estimate` divides instructional text's UTF-8 byte length by four. For offline OpenAI text-encoding counts, use `--tokenizer openai-cl100k_base` or `--tokenizer openai-o200k_base`, or select a supported model with `--model gpt-4o` (also `gpt-4`, `gpt-4.1`, `gpt-5`, `o3`, or `o4-mini`). Use either `--model` or `--tokenizer`, not both. The chosen method applies consistently across the history and measures stored text, not loaded context, message framing, or billing. See [the tokenizer study](docs/tokenizers.md) for details and limits.

For HTML or JSON analysis output, `--shareable` replaces repository and branch names, file paths, skill directory names, commit IDs, and blob IDs with deterministic aliases. Dates, labels, and measurements remain visible, so inspect a report before sharing it.

To print the bundled JSON interpretation skill for a coding agent, or save it at a chosen path:

```sh
node dist/cli.js skill
node dist/cli.js skill --output .agents/skills/strata-interpret/SKILL.md
```

The `skill` command refuses to overwrite an existing file. Run `node dist/cli.js --help` for the command list and `node dist/cli.js <command> --help` for a command's options. The same commands work as `strata` after installing the package.

In the HTML report, select any baseline and target revision to compare signed estimated-token and file-count changes by provider, category, and component. The timeline controls the target revision. For histories longer than 100 revisions, the chart groups adjacent revisions into at most 100 bars; each bar shows its group's last revision, while the slider still reaches every charted commit. The chart and slider start at the first revision with tracked configuration in the current view; earlier revisions stay available in the baseline and target selectors. Comparison is based on stored files at those two points; a moved file may appear as a removal and an addition.

The report opens on **All files**, counting each tracked file once. Provider tabs show a provider's files together with shared instruction candidates; shared files can appear in multiple provider tabs, so the tab totals should not be added together. These are stored-file views, not measurements of what an agent actually loaded. The selected view applies to the chart, summary, treemap, skill bundles, comparison, and inventory. The tracked-components table can also be filtered by provider, category, and a case-insensitive path search. Those inventory filters stay active as you move along the timeline and reset when you change provider tabs.

The treemap shows the selected revision's instructional components with rectangle area proportional to each stored-text token estimate and color by category. Rectangles of files that the selected revision added, edited, or renamed are outlined. Hover or focus any rectangle for its full path and token count; select it to locate its file in the inventory. Source-only and zero-token files stay in the inventory and receive no invented area. The skill-bundle table initially shows eight rows and can be expanded to the full list.

JSON reports store each distinct file version once in a top-level `components` list; every revision carries its totals and its `changes`, each pointing at the component now at that path. Replaying the changes in order rebuilds the files present at any revision, which keeps reports small on long histories. The bundled interpretation skill explains schema version 9 and that replay rule, stored-text measurement methods, source-only files, skill bundles, shareable aliases, and the limits of what JSON can establish.

## Development

Use Node.js 22.13 or newer, Git 2.31 or newer, and pnpm 10.29.3:

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
node dist/cli.js --help
pnpm dev --help
```

Run `pnpm build && pnpm benchmark` for a disposable large-history analysis fixture, or see [the benchmark notes](docs/benchmark.md) for the baseline and read-only real-repository mode.

For pull requests, the opt-in [composite Action and `strata diff` command](docs/pr-action.md) compare two full commit IDs and produce a Markdown or JSON configuration delta. They read Git blobs without checking out either revision or posting a comment.

The npm package name is `context-strata`, with `strata` as the executable. Version 0.1.0 is a release candidate and has not been published yet. Changes are recorded in [CHANGELOG.md](CHANGELOG.md).

## Agent-assisted development

[AGENTS.md](AGENTS.md) gives coding agents the repository's purpose, code map, and checks. [CLAUDE.md](CLAUDE.md) imports that same guidance for Claude Code. Optional `strata_reviewer` for Codex and `strata-reviewer` for Claude Code focus on the correctness and privacy of analysis changes; their definitions live in [.codex/agents](.codex/agents/strata_reviewer.toml) and [.claude/agents](.claude/agents/strata-reviewer.md). Invoke a reviewer when that focused check is useful.
