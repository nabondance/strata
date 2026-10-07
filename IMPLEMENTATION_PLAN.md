# Strata implementation plan

Working plan, 2026-10-07. [brief.md](brief.md) records the original discussion and distinguishes confirmed direction from proposals. This plan turns that direction into a first release; technical choices below remain revisable as the early research tasks are completed.

## First release

Run one command inside a Git repository and open an interactive, local report showing how tracked AI-agent configuration changed over time. The first report should let a user select a revision and see total stored instruction tokens, category totals, component counts, and the files behind those numbers. It should make a root instruction file shrinking while skills grow easy to spot.

The report measures **stored configuration**, not tokens loaded into a particular agent session. It must name the tokenizer or estimation method. Configuration such as hooks or MCP settings can be inventoried separately, but source-file size must not be presented as runtime prompt or tool-schema cost.

### Release boundary

- Read local Git history without uploading repository content or requiring a GitHub account.
- Recognize an initial, documented set of Claude Code and Codex instruction and skill paths. Add other ecosystems through the same adapter interface after their conventions are verified.
- Analyze the first-parent history of the selected branch, one commit at a time. Show the commit range and warn when a shallow clone makes the history incomplete. Merge-topology and sampling options can follow once correctness is established.
- Generate a local interactive HTML report. It can be opened directly in a browser; no hosted service is needed. The report should default to paths and measurements, with source text excluded unless explicitly requested in a later feature.
- Support additions, edits, deletions, and renames in the revision inventory and change list. A rename must not be reported as an unexplained disappearance and new file when Git provides enough evidence to identify it.
- Leave survival attribution, inferred architecture edges, CI integration, badges, and session-cost estimates outside the first release.

## Work sequence

| Stage | Outcome | Exit check |
| --- | --- | --- |
| 0. Establish contracts | Confirm package and command names, supported Node version, provider path rules, token method, and report content policy. | Short decision records cite direct npm registry checks and current provider documentation; a sample report schema is reviewed. |
| 1. Git history and inventory | Enumerate revisions and reconstruct candidate files at each revision without changing the target repository. | Fixture covers addition, growth, reduction, deletion, rename, and a merge; timestamps and commit IDs match Git. |
| 2. Classification and measurement | Normalize provider-specific files into components and compute consistent, labeled token counts. | Fixture totals equal the sum of component counts; unsupported or ambiguous files are visible as such and are not silently misclassified. |
| 3. Interactive report | Select a revision on a timeline and inspect category composition, file inventory, and revision changes. | Report works offline against the fixture and a real repository; chart, counts, and inventory all update together. |
| 4. CLI and release readiness | Package the command, handle errors and large-history progress, document installation and privacy behavior. | Fresh install and end-to-end run succeed on supported platforms; published package name is verified before any release. |

Each stage should produce a usable vertical slice. In particular, the history extractor should emit a stable data model independently of the chart so report design can change without re-reading Git.

## Initial data contract

Each revision should retain its full commit ID, parent used for comparison, timestamp, and whether history is complete. Each component should retain its path, provider, category, and measurement. The report model should include category totals and a change list derived from two adjacent analyzed revisions. Counts and totals should be computed from components, not maintained as separate mutable facts.

The token method and version belong in report metadata. A fixed method must be used across all revisions in one report. If a tokenizer is provider-specific, its counts are a comparison metric for stored text rather than a claim about another provider's runtime usage. Files that are not instructional text need a separate source-size measure or explicit exclusion from token totals.

## Private GitHub Project

The [Strata GitHub Project](https://github.com/users/nabondance/projects/4) is **private**, owned by `nabondance`, and linked to `nabondance/strata`. It is the live task tracker; this file holds the release boundary and durable design decisions. Early planning work is in project draft items, so a public repository issue is created only when that task is ready to be public.

Configured fields: the built-in Status (`Todo`, `In Progress`, `Done`), Priority (`P0`, `P1`, `P2`), Stage (`0 Decisions`, `1 History`, `2 Measurement`, `3 Report`, `4 Release`, `Later`), and Work type (`Study`, `Setup`, `Core`, `Feature`, `Docs`, `Bug`). The initial batch contains 13 draft items plus a pnpm setup task:

| Priority | Stage | Draft item | Done when |
| --- | --- | --- | --- |
| P0 | 0 | Verify npm package and executable names | Direct registry queries, naming choice, and command example are recorded. |
| P0 | 0 | Verify Claude Code and Codex path conventions | Initial recognition table links to current official docs and states what is excluded. |
| P0 | 0 | Choose token measurement and labels | Method, version, treatment of non-instruction files, and limitations are documented. |
| P0 | 0 | Define report schema and privacy defaults | Example fixture output and default HTML contents are reviewable. |
| P0 | 0 | Set up pnpm TypeScript CLI package | A clean install, typecheck, build, and installed CLI smoke check pass. |
| P0 | 1 | Build synthetic Git history fixture | Fixture contains addition, growth, reduction, deletion, rename, and merge cases. |
| P0 | 1 | Extract revisions and candidate blobs | First-parent sequence and files match Git; shallow history is signaled. |
| P0 | 2 | Classify components through provider adapters | Claude and Codex fixtures classify to documented categories. |
| P0 | 2 | Measure and aggregate stored text | Per-file, category, and revision totals reconcile and state the token method. |
| P0 | 3 | Render timeline and revision details | One selection updates chart, totals, counts, inventory, and changes. |
| P0 | 4 | Wire CLI and validate end to end | A fresh checkout generates an offline report on fixture and real repositories. |
| P1 | 4 | Document usage and limitations | README explains supported inputs, privacy, shallow clones, merge policy, and token semantics. |
| P2 | Later | Prototype instruction survival | Attribution method handles moves and copies before percentages are shown. |
| P2 | Later | Evaluate evidence-based architecture view | Edges have traceable evidence; directory location alone creates no dependency. |

## Decisions to make during Stage 0

1. **Package and command:** the provisional npm package is `context-strata` and the binary is `strata`. A direct npm registry check on 2026-10-07 found `strata@0.20.1` and returned 404 for `context-strata`. This is not a reservation; recheck before publication. The package remains private during development.
2. **Implementation stack:** favor a Node CLI if `npx` remains the desired entry point. Choose the smallest build and UI stack that can produce an offline report, then pin supported Node versions.
3. **Recognition rules:** verify current provider docs. Start with explicit paths and file types; avoid interpreting arbitrary Markdown as agent configuration.
4. **Token method:** compare a real tokenizer with a clearly labeled estimate on fixture text. Pick one stable default, record its version, and allow a future tokenizer option without changing report semantics.
5. **History policy:** first-parent per commit is the initial view; decide how to label merge commits and renames. Do not call an inferred move or refactor a fact.
6. **Output format:** use interactive HTML for the first release. Assess report size and data exposure before adding embedded file contents or shareable exports.

## Verification and release gates

The synthetic fixture is the correctness baseline. It should include nested instructions, at least one skill, a file removed after several revisions, and a rename with and without content changes. Test against a real repository to catch unexpected Git paths and history size. Include a golden report model so UI totals can be checked against extraction independently. Before release, run the packaged CLI from a clean install and confirm the generated HTML opens offline.

No timeline should claim a complete repository history when the clone is shallow or analysis is sampled. No total should be labeled as actual session context cost. The first release is complete when the user can answer: “When did my stored agent context grow or shrink, which components caused it, and what was present at that revision?”
