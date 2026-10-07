# strata

See how your agent context evolved across Git history.

Strata is in early development. The planned CLI will analyze tracked AI-agent configuration and produce an offline interactive report. See [the project foundation](brief.md) for the original discussion and [the implementation plan](IMPLEMENTATION_PLAN.md) for the first release scope.

## Development

Use Node.js 22.13 or newer and pnpm 10.29.3:

```sh
pnpm install
pnpm typecheck
pnpm build
node dist/cli.js --help
pnpm dev --help
```

The provisional npm package name is `context-strata`, with `strata` as the executable. The package is private while the first release is being built and has not been published.
