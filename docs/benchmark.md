# Analysis benchmark

The benchmark times **analysis only**. It does not include fixture creation, compilation, or HTML rendering time.

| Command                                     | What it does                                                                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm build && pnpm benchmark`              | Creates a disposable repository with 1,000 commits and 32 tracked skill manifests, times its analysis, and removes it after the run. |
| `pnpm benchmark --commits N --files M`      | Same, with `N` commits and `M` skill manifests.                                                                                      |
| `pnpm benchmark --repo /path/to/repository` | Times an existing repository, read-only.                                                                                             |

The output reports the revision count, the latest revision's component count and estimated tokens, analysis seconds, and revisions per second. A _revision_ is one commit in the analyzed history; a _component_ is one tracked configuration file.

## Analysis time: per-commit Git processes vs. streamed log

Measured on 2026-10-09, macOS arm64, Node 24.21.0, Git 2.48.1, default estimate mode:

| Input                          | Revisions | Latest components | Per-commit Git processes (before) | Streamed log (current) |
| ------------------------------ | --------: | ----------------: | --------------------------------: | ---------------------: |
| Synthetic, 32 skill manifests  |     1,000 |                32 |                          23.944 s |                0.778 s |
| Synthetic, 128 skill manifests |       300 |               128 |              7.858 s (2026-10-08) |                0.158 s |
| Local Claudes repository       |        89 |                69 |                            3.41 s |                0.191 s |

These are single runs, not a performance guarantee. The local repository is only an example workload; its content was not copied into the benchmark file or uploaded.

The two implementations start Git differently:

- **Before:** Git ran once per tree, once per pair of adjacent revisions to diff, and once per distinct blob (a stored file version).
- **Current:** a fixed number of Git processes, however long the history: one streamed log for all commits, one size lookup for all distinct blobs, and batched content reads only when a tokenizer needs the text.

Both produced byte-identical JSON on five local repositories (16 to 505 revisions) in three modes: the default estimate, `openai-o200k_base`, and provider counts, the last against a stubbed API.

## Report size

Report size no longer grows with revisions multiplied by tracked files. Schema version 9 stores each distinct file version once, and each revision as its changes and totals.

HTML report sizes on local repositories, schema 8 against schema 9. About 62 KB of each is the page itself.

| Repository       | Revisions | Inventory rows across history | Distinct file versions | Schema 8 | Schema 9 |
| ---------------- | --------: | ----------------------------: | ---------------------: | -------: | -------: |
| Agents-Template  |       181 |                       177,750 |                  2,838 |  57.5 MB |   1.5 MB |
| Claudes          |        89 |                         3,965 |                    204 |   1.4 MB |   211 KB |
| Trailhead-Banner |       505 |                           785 |                     45 |   748 KB |   504 KB |

Trailhead-Banner changes configuration in only 16 of its 505 revisions. What remains of its report is the per-revision totals, not file lists.

## Tokenizer cost

With an OpenAI encoding (the removed `--tokenizer` option, measured before version 20), tokenization took most of the time.

Example: one local repository with 181 revisions and 627 distinct instruction blobs.

- `js-tiktoken` took about 2.8 s for each version of a roughly 93 KB instruction file: 33 of the run's 35 seconds.
- Two thirds of that file is whitespace: Markdown table cells padded with runs of about 1,000 spaces.
- The cause: after each merge, `js-tiktoken`'s merge loop rescans every adjacent pair in a piece of text and builds a string key per pair. One run of spaces costs about 60 ms, while the same amount of ordinary prose costs 7 ms in total.

The fix: Strata now splits text with the encoding's own pattern and remembers the token count of each distinct piece. It encodes a piece with `js-tiktoken` only the first time that piece appears.

- Counts are unchanged: all 863 instruction blobs across four local repositories match whole-text `encode`.
- That repository's analysis went from 34.6 s to 5.3 s. What remains is the first encounter with each distinct long run of spaces.

Sampling history is not implemented. It would change the report's meaning, so it would have to disclose which history it left out.
