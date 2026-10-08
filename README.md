# strata

See how your agent context evolved across Git history.

Strata is in early development. The CLI reads tracked configuration across Git history and produces an offline interactive report. See [the project foundation](brief.md), [the implementation plan](IMPLEMENTATION_PLAN.md), [the current analysis scope](docs/analysis-scope.md), and [first-release decisions](docs/decisions.md).

Strata is released under the [MIT license](LICENSE). See [CONTRIBUTING.md](CONTRIBUTING.md) for development and contribution guidance and [SECURITY.md](SECURITY.md) for vulnerability reporting.

## Try it locally

After installing dependencies and building, run:

```sh
node dist/cli.js analyze /path/to/git/repository
```

The CLI writes an offline HTML report to a private temporary directory and prints its path. Add `--open` to launch it in a browser, or `--output report.html` to save it where you choose. For machine-readable data, use `--format json`, optionally with `--output report.json`. The CLI prints scan progress to stderr. The first slice tracks documented Claude and Codex instruction, skill, agent, rule, and configuration paths. It uses a clearly labeled stored-token estimate for instructional files and source bytes for structured or supporting files; it does not measure actual session context. The report contains paths and measurements but no source text.

Add `--shareable` to either HTML or JSON output to replace repository and branch names, file paths, skill directory names, commit IDs, and blob IDs with deterministic aliases. Dates, provider/category labels, counts, byte sizes, token estimates, and change kinds remain visible. The default local report retains full metadata; inspect even a shareable report before distributing it.

In the HTML report, select any baseline and target revision to compare signed estimated-token and file-count changes by provider, category, and component. The timeline controls the target revision. Comparison is based on stored files at those two points; a moved file may appear as a removal and an addition.

The tracked-components table can be filtered by provider, category, and a case-insensitive path search. Filters stay active as you move along the timeline. The chart, summary, and comparison always use the full revision, while the inventory shows its own filtered file count.

The treemap shows the selected revision's instructional components with rectangle area proportional to each stored-text token estimate and color by category. Select a rectangle to locate its file in the inventory. Source-only and zero-token files stay in the inventory and receive no invented area; the treemap does not represent which files an agent loaded in a session.

To give your own coding agent guidance for interpreting Strata JSON, print the bundled skill with `node dist/cli.js skill`, or save it to a skill directory:

```sh
node dist/cli.js skill --output .agents/skills/strata-interpret/SKILL.md
# For Claude Code, use .claude/skills/strata-interpret/SKILL.md instead.
```

The command refuses to overwrite an existing skill file. The same commands will work with `strata` once the package is installed. The skill explains schema version 4, stored-text estimates, source-only files, skill bundles, shareable aliases, revision deltas, and the limits of what JSON can establish.

## Development

Use Node.js 22.13 or newer and pnpm 10.29.3:

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
node dist/cli.js --help
pnpm dev --help
```

Run `pnpm build && pnpm benchmark` for a disposable large-history analysis fixture, or see [the benchmark notes](docs/benchmark.md) for the baseline and read-only real-repository mode.

The npm package name is `context-strata`, with `strata` as the executable. Version 0.1.0 is a release candidate and has not been published. The npm registry returned 404 for this name on 2026-10-08; recheck availability before publication.

## Agent-assisted development

[AGENTS.md](AGENTS.md) gives coding agents the repository's purpose, code map, and checks. [CLAUDE.md](CLAUDE.md) imports that same guidance for Claude Code. Optional `strata_reviewer` for Codex and `strata-reviewer` for Claude Code focus on the correctness and privacy of analysis changes; their definitions live in [.codex/agents](.codex/agents/strata_reviewer.toml) and [.claude/agents](.claude/agents/strata-reviewer.md). Invoke a reviewer when that focused check is useful.
