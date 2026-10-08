# Analysis benchmark

Run `pnpm build && pnpm benchmark` to create a disposable 1,000-commit repository with 32 tracked skill manifests and time **analysis only**. Use `pnpm benchmark --commits N --files M` to change fixture size, or `pnpm benchmark --repo /path/to/repository` to time an existing repository read-only. The synthetic fixture is removed after the run. The output reports revision count, latest component count, analysis seconds, and revisions per second; it does not include fixture creation, compilation, or HTML rendering time.

Baseline on 2026-10-08, macOS arm64, Node 24.21.0, Git 2.48.1, Strata schema v3:

| Input | Revisions | Latest components | Analysis time | Revisions/s |
| --- | ---: | ---: | ---: | ---: |
| Synthetic, 32 skill manifests | 1,000 | 32 | 21.997 s | 45.5 |
| Synthetic, 128 skill manifests | 300 | 128 | 7.858 s | 38.2 |
| Local Claudes repository | 89 | 69 | 2.536 s | 35.1 |

These are single runs, not a performance guarantee. The local repository is only an illustrative workload; its content was not copied into the benchmark file or uploaded. Current extraction launches Git for each tree and adjacent diff, plus one blob read for each distinct blob. This process startup pattern is a likely cost center; that is an inference from the implementation, not a profiler result. Before introducing sampling or more caching, repeat this benchmark on slow platforms and histories with many more unique blobs. Sampling must disclose omitted history because it changes the report's meaning.
