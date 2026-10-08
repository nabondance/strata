# First-release decisions

Recorded 2026-10-08. These choices describe the current implementation, not a package publication or claim about runtime context.

## Name and command

The npm package name is `context-strata`; its executable is `strata`. Direct queries to the npm registry on 2026-10-08 returned 404 for `context-strata` and `strata@0.20.1` for `strata`. A 404 is not a reservation. Version 0.1.0 is prepared but unpublished; verify availability again before release. The intended command after publication is `npx context-strata analyze . --output report.html`.

## License and contributions

Strata uses the OSI-approved MIT license, chosen to allow broad use and redistribution with a short attribution requirement. The repository has a contribution guide and a security-reporting path. The packaged runtime dependency `d3-hierarchy` has a separate ISC license, which remains embedded in offline HTML reports alongside its code.

## Measurement

By default, stored instructional text uses Strata's `utf8-bytes-divided-by-four-v1` comparison estimate: `ceil(UTF-8 bytes / 4)` per file, then sum. An opt-in `--tokenizer openai-cl100k_base` or `openai-o200k_base` uses local `js-tiktoken@1.0.21` to count valid UTF-8 text under that encoding. `--model` maps the explicitly supported OpenAI model names (`gpt-4`, `gpt-4o`, `gpt-4.1`, `gpt-5`, `o3`, `o4-mini`) to the encoding documented in [OpenAI's tiktoken model map](https://github.com/openai/tiktoken/blob/main/tiktoken/model.py). Unknown names fail rather than guessing. The count is exact for the selected text encoding, but excludes message framing, special-token handling, actual loaded context, and billing. It does not claim accuracy for Claude or Gemini. One encoding is applied to every instructional file and every revision in a report. These default and local modes make no network request or content transfer. Structured config and supporting resources are source bytes only. See [the tokenizer study](tokenizers.md) for evidence.

`strata analyze --provider-api` is an explicit content-transfer opt-in. It requires a Claude model and a Gemini model, uses `ANTHROPIC_API_KEY` and `GEMINI_API_KEY` (or `GOOGLE_API_KEY`), and sends each recognized Claude or Gemini instruction blob to its matching count endpoint as one user text message. Shared instructions are counted separately for both selected provider models. `--codex-model` optionally adds a local OpenAI encoding count for Codex instructions. Provider counts are cached by provider, model, and blob; the same provider/blob is requested once across history. Separate provider counts are never added to each other or to the generic estimate. The legacy `estimatedTokens` history remains the default byte estimate, and `strata diff` remains local-only.

## Report contract and privacy

Schema version 8 adds Gemini CLI to provider labels and optional `providerTokenCounts` on instruction components, with separate `providerTokenTotals` on revisions. Each provider count carries its provider, explicit model, method, implementation/API version, and `api-counted` or `encoding-exact` accuracy label. Provider labels identify recognized path conventions, not exclusive runtime support; shared `AGENTS.md` is stored once and receives separate counts per selected provider. A shortened, illustrative JSON shape:

```json
{
  "schemaVersion": 8,
  "repository": "example",
  "branch": "main",
  "shallow": false,
  "privacy": { "mode": "local" },
  "measurement": {
    "label": "Estimated stored-text tokens",
    "method": "utf8-bytes-divided-by-four-v1: UTF-8 bytes / 4, rounded up per instructional file",
    "limitations": "Comparison estimate only.",
    "family": "generic",
    "accuracy": "estimate",
    "encoding": null,
    "model": null,
    "implementation": "strata-v1"
  },
  "revisions": [{
    "id": "<full Git commit ID>",
    "date": "<author ISO timestamp>",
    "firstParent": null,
    "components": [{
      "path": "AGENTS.md", "provider": "shared", "category": "instructions",
      "blob": "<Git blob ID>", "bytes": 8, "estimatedTokens": 2
    }],
    "skillGroups": [],
    "categoryTotals": {
      "instructions": { "count": 1, "bytes": 8, "estimatedTokens": 2, "sourceOnlyCount": 0 }
    },
    "estimatedTokens": 2,
    "changes": [{
      "kind": "added", "path": "AGENTS.md", "previousTokens": null,
      "estimatedTokens": 2, "deltaTokens": 2
    }]
  }]
}
```

The actual `categoryTotals` has an entry for every category. Skill components have a `skill` object with directory root and `manifest` or `resource` role. `skillGroups` summarizes those same files, separating manifest token estimates from resource byte sizes; these summaries are not additional measurements. Default HTML and JSON contain commit IDs, dates, paths, provider/category labels, blob IDs, byte sizes, and estimates. They contain no source text. Paths and blob IDs can still disclose repository structure. Generated reports are local artifacts; the CLI sets output mode `0600`. The default measurement modes make no network request and upload no content. Explicit `--provider-api` mode sends recognized Claude and Gemini instructional text to the selected provider APIs for counting; reports store counts and measurement metadata, not submitted text.

`--shareable` produces schema version 8 with `privacy.mode: "shareable"`. It replaces repository and branch names, commit and first-parent IDs, component and change paths, skill roots, and blob IDs with deterministic aliases local to that report. The alias maps are not embedded. Dates, category and provider labels, counts, byte sizes, estimates, change kinds, and timeline shape remain visible. The default local report is unchanged. Shareable means reduced identifier exposure, not guaranteed anonymity; inspect before publishing.

## Revision comparison

The offline HTML report compares any two revisions present in the report; comparison semantics are unchanged by schema version 8. The timeline and target selector refer to the same revision; the baseline selector stays fixed when the target changes. The chart is capped at 100 bars, grouping adjacent revisions when needed and displaying the last revision in each group. The slider and selectors still address every revision. The comparison shows signed differences in estimated stored-text tokens and tracked file counts, grouped by provider and category. A zero-token baseline has no meaningful percentage change and is shown without a percentage.

The HTML view defaults to all tracked files, counted once. A provider view includes that provider's files and shared instruction candidates; a shared-only view displays those candidates by themselves. Shared files can occur in several provider views, so provider totals cannot be summed to recover the all-files total. Switching views projects every report panel from the same stored JSON data and resets inventory filters. A move between providers appears as a removal in one view and an addition in the other. This is a display choice, not a claim about an agent's active or loaded context. It does not change report schema version 8. The per-component change table omits file-count deltas because a single matched path can only be added (+1), removed (-1), or edited (0); aggregate file deltas remain in the provider/category and summary comparisons.

Components are matched by provider, category, and path. A changed blob at the same identity is shown as edited even if its token estimate is unchanged. A renamed or reorganized file may appear as a removal and addition; the comparison does not assert that instructions survived or that a refactor occurred. Source-only files affect file counts but contribute zero to estimated-token deltas.

## Composition treemap

The HTML report uses component measurements to draw a category-grouped treemap at the selected revision. Each positive-token instructional component receives a rectangle with area proportional to its estimated stored-text tokens; categories are contiguous and color-coded. Interior labels use the skill directory name or file name. They are checked against their rendered space and again on resize: the token count is removed when both lines do not fit, then the name is reduced or removed if it still cannot fit. Every rectangle has a hover/focus detail line and an accessible name with the full path and token count. Source-only and zero-token components have no area and remain in the inventory, with their counts stated beside the treemap. The treemap is a stored-configuration composition view, not a map of runtime dependencies or loaded context. Keyboard-accessible rectangles locate the corresponding inventory row; the table remains the text alternative. The skill-bundle list begins with eight rows and offers an explicit control to reveal the rest.

Rectangle layout uses `d3-hierarchy@3.1.2`'s squarified treemap. The generated report embeds the minified library and its ISC license and calculates the selected revision's layout in the browser; it requires no network access or separate assets.

## Pull-request comparison

`strata diff` compares two supplied full commit IDs by reading their tracked Git trees directly. It does not check out revisions or write into the target repository. It uses the same path classification, instructional-text boundary, and selected measurement mode as the history report. Its JSON has a separate schema version 3; Markdown is intended for a local file or an opt-in GitHub Actions job summary. Paths and commit IDs are visible, but source text is not. The composite Action does not post comments or enforce a token budget.
