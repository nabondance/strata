# Analysis benchmark

Run `pnpm build && pnpm benchmark` to create a disposable 1,000-commit repository with 32 tracked skill manifests and time **analysis only**. Use `pnpm benchmark --commits N --files M` to change fixture size, or `pnpm benchmark --repo /path/to/repository` to time an existing repository read-only. The synthetic fixture is removed after the run. The output reports revision count, latest component count, analysis seconds, and revisions per second; it does not include fixture creation, compilation, or HTML rendering time.

Measured on 2026-10-09, macOS arm64, Node 24.21.0, Git 2.48.1, default estimate mode:

| Input | Revisions | Latest components | Per-commit Git processes (before) | Streamed log (current) |
| --- | ---: | ---: | ---: | ---: |
| Synthetic, 32 skill manifests | 1,000 | 32 | 23.944 s | 0.778 s |
| Synthetic, 128 skill manifests | 300 | 128 | 7.858 s (2026-10-08) | 0.158 s |
| Local Claudes repository | 89 | 69 | 3.41 s | 0.191 s |

These are single runs, not a performance guarantee. The local repository is only an illustrative workload; its content was not copied into the benchmark file or uploaded.

The earlier implementation launched Git once per tree, once per adjacent diff, and once per distinct blob. The current one starts a fixed number of Git processes regardless of history length: one streamed log for all commits, one size lookup for all distinct blobs, and, only when a tokenizer needs text, batched content reads. Both implementations produced byte-identical JSON on five local repositories (16 to 505 revisions) in the estimate, `openai-o200k_base`, and provider-count modes, the last against a stubbed API.

Report size no longer follows revisions multiplied by tracked files. Schema version 9 stores each distinct file version once and each revision as its changes and totals. HTML report sizes on local repositories, schema 8 against schema 9 (about 62 KB of each is the page itself):

| Repository | Revisions | Inventory rows across history | Distinct file versions | Schema 8 | Schema 9 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Agents-Template | 181 | 177,750 | 2,838 | 57.5 MB | 1.5 MB |
| Claudes | 89 | 3,965 | 204 | 1.4 MB | 211 KB |
| Trailhead-Banner | 505 | 785 | 45 | 748 KB | 504 KB |

The last repository changes configuration in only 16 of its 505 revisions, so what remains there is the per-revision totals rather than file lists.

With an OpenAI encoding selected, tokenization dominates. In one local repository (181 revisions, 627 distinct instruction blobs) `js-tiktoken` took about 2.8 s for each version of a roughly 93 KB instruction file, 33 of the run's 35 seconds. Two thirds of that file is whitespace: Markdown table cells padded with runs of about 1,000 spaces. `js-tiktoken`'s merge loop rescans every adjacent pair of a piece after each merge and builds a string key per pair, so one such run costs about 60 ms while the same amount of ordinary prose costs 7 ms in total.

Strata now splits text with the encoding's own pattern and remembers the token count of each distinct piece, encoding a piece with `js-tiktoken` only the first time it appears. Counts are unchanged: all 863 instruction blobs across four local repositories match whole-text `encode`. That repository's analysis went from 34.6 s to 5.3 s; what remains is the first encounter with each distinct long run. Sampling is not implemented; it would have to disclose omitted history because it changes the report's meaning.
