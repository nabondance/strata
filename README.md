# strata

See how your agent context evolved across Git history.

Strata is in early development. The CLI now reads tracked configuration across Git history and produces an offline interactive report. See [the project foundation](brief.md), [the implementation plan](IMPLEMENTATION_PLAN.md), and [the current analysis scope](docs/analysis-scope.md).

## Try it locally

After installing dependencies and building, run:

```sh
node dist/cli.js analyze /path/to/git/repository --output .strata-output/report.html
```

The HTML report opens directly in a browser. For machine-readable data, add `--format json` and use a `.json` output path. The first slice tracks Claude instruction files, skills, agents, rules, commands, project agent memory, and settings. It uses a clearly labeled stored-token estimate; it does not measure actual session context. The report contains paths and measurements but no source text.

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

The provisional npm package name is `context-strata`, with `strata` as the executable. The package is private while the first release is being built and has not been published.
