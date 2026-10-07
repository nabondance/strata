# strata

See how your agent context evolved across Git history.

Strata is in early development. The CLI reads tracked configuration across Git history and produces an offline interactive report. See [the project foundation](brief.md), [the implementation plan](IMPLEMENTATION_PLAN.md), [the current analysis scope](docs/analysis-scope.md), and [first-release decisions](docs/decisions.md).

## Try it locally

After installing dependencies and building, run:

```sh
node dist/cli.js analyze /path/to/git/repository
```

The CLI writes an offline HTML report to a private temporary directory and prints its path. Add `--open` to launch it in a browser, or `--output report.html` to save it where you choose. For machine-readable data, use `--format json`, optionally with `--output report.json`. The CLI prints scan progress to stderr. The first slice tracks documented Claude and Codex instruction, skill, agent, rule, and configuration paths. It uses a clearly labeled stored-token estimate for instructional files and source bytes for structured or supporting files; it does not measure actual session context. The report contains paths and measurements but no source text.

To give your own coding agent guidance for interpreting Strata JSON, print the bundled skill with `node dist/cli.js skill`, or save it to a skill directory:

```sh
node dist/cli.js skill --output .agents/skills/strata-interpret/SKILL.md
# For Claude Code, use .claude/skills/strata-interpret/SKILL.md instead.
```

The command refuses to overwrite an existing skill file. The same commands will work with `strata` once the package is installed. The skill explains schema version 2, stored-text estimates, source-only files, revision deltas, and the limits of what JSON can establish.

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

The npm package name is `context-strata`, with `strata` as the executable. The package is private while the first release is being built and has not been published. Registry availability was checked on 2026-10-08 and must be checked again before publication.

## Agent-assisted development

[AGENTS.md](AGENTS.md) gives coding agents the repository's purpose, code map, and checks. [CLAUDE.md](CLAUDE.md) imports that same guidance for Claude Code. Optional `strata_reviewer` for Codex and `strata-reviewer` for Claude Code focus on the correctness and privacy of analysis changes; their definitions live in [.codex/agents](.codex/agents/strata_reviewer.toml) and [.claude/agents](.claude/agents/strata-reviewer.md). Invoke a reviewer when that focused check is useful.
