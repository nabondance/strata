# First-release decisions

Recorded 2026-10-08. These choices describe the current implementation, not a package publication or claim about runtime context.

## Name and command

The npm package name is `context-strata`; its executable is `strata`. Direct queries to the npm registry on 2026-10-08 returned 404 for `context-strata` and `strata@0.20.1` for `strata`. A 404 is not a reservation. Version 0.1.0 is prepared but unpublished; verify availability again before release. The intended command after publication is `npx context-strata analyze . --output report.html`.

## License and contributions

Strata uses the OSI-approved MIT license, chosen to allow broad use and redistribution with a short attribution requirement. The repository has a contribution guide and a security-reporting path. The packaged runtime dependency `d3-hierarchy` has a separate ISC license, which remains embedded in offline HTML reports alongside its code.

## Measurement

By default, stored instructional text uses Strata's `utf8-bytes-divided-by-four-v1` comparison estimate: `ceil(UTF-8 bytes / 4)` per file, then sum. An opt-in `--tokenizer openai-cl100k_base` or `openai-o200k_base` uses local `js-tiktoken@1.0.21` to count valid UTF-8 text under that encoding. `--model` maps the explicitly supported OpenAI model names (`gpt-4`, `gpt-4o`, `gpt-4.1`, `gpt-5`, `o3`, `o4-mini`) to the encoding documented in [OpenAI's tiktoken model map](https://github.com/openai/tiktoken/blob/main/tiktoken/model.py). Unknown names fail rather than guessing. The count is exact for the selected text encoding, but excludes message framing, special-token handling, actual loaded context, and billing. Text that spells a special token, such as `<|endoftext|>` in a file about language models, is counted as ordinary text rather than rejected. Counting is done per pattern piece with a cache of distinct pieces, which gives the same total as encoding the whole text (see [the benchmark notes](benchmark.md)). It does not claim accuracy for Claude or Gemini. One encoding is applied to every instructional file and every revision in a report. These default and local modes make no network request or content transfer. Structured config and supporting resources are source bytes only. See [the tokenizer study](tokenizers.md) for evidence.

`strata analyze --provider-api` is an explicit content-transfer opt-in. It requires a Claude model and a Gemini model, uses `ANTHROPIC_API_KEY` and `GEMINI_API_KEY` (or `GOOGLE_API_KEY`), and sends each recognized Claude or Gemini instruction blob to its matching count endpoint as one user text message. Shared instructions are counted separately for both selected provider models. `--codex-model` optionally adds a local OpenAI encoding count for Codex instructions. Provider counts are cached by provider, model, and blob; the same provider/blob is requested once across history. Separate provider counts are never added to each other or to the generic estimate. The legacy `estimatedTokens` history remains the default byte estimate, and `strata diff` remains local-only.

## History extraction

Analysis reads the whole first-parent history from one streamed `git log --first-parent --diff-merges=first-parent --raw -M` process, which needs Git 2.31 or newer. Each commit's raw diff against its first parent updates an in-memory inventory of recognized regular files; symlinks and submodules are never tracked. Renames are the ones Git reports in that diff, and only a rename between two recognized paths is labeled as such. Blob sizes come from `git cat-file --batch-check`. Blob content is read, in bounded batches, only for instructional text and only when the selected measurement needs the text, so the default estimate reads no file content at all. `strata diff` lists the two commit trees directly and shares the same classification and measurement code.

Analysis keeps one running inventory and records, for each revision, only what that commit changed. It never materializes a per-revision file list, so memory and report size grow with the number of distinct file versions plus the number of revisions, not with revisions multiplied by tracked files.

## Report contract and privacy

Schema version 9 stores each distinct file version once and each revision as a delta. A top-level `components` table holds one entry per distinct path-and-blob pair across the whole history, ordered by path. A revision carries its `componentCount`, `categoryTotals`, `estimatedTokens`, and `changes`; it no longer repeats its inventory, and `skillGroups` is no longer stored. Every change has a `component` field: the index in `components` of the file version now at `path`, or `null` for a removal. On one local repository with 181 revisions this cut the HTML report from 57.5 MB to 1.5 MB.

To rebuild the inventory at a revision, start empty and apply every revision's changes in order up to it: drop `previousPath` when present, then drop `path` if `component` is `null`, otherwise set `path` to that component. `src/expand.ts` implements this rule, the HTML report embeds the same function, and a fixture test checks the replayed inventory of every revision against a direct listing of that commit's tree. Skill bundles are derived from the rebuilt inventory by grouping components on `skill.root`. Stored totals let a consumer chart history without replaying anything.

Schema version 8 added Gemini CLI to provider labels and optional `providerTokenCounts` on instruction components, with separate `providerTokenTotals` on revisions; version 9 keeps both. Each provider count carries its provider, explicit model, method, implementation/API version, and `api-counted` or `encoding-exact` accuracy label. Provider labels identify recognized path conventions, not exclusive runtime support; shared `AGENTS.md` is stored once and receives separate counts per selected provider. A shortened, illustrative JSON shape:

```json
{
  "schemaVersion": 9,
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
  "components": [{
    "path": "AGENTS.md", "provider": "shared", "category": "instructions",
    "blob": "<Git blob ID>", "bytes": 8, "estimatedTokens": 2
  }],
  "revisions": [{
    "id": "<full Git commit ID>",
    "date": "<author ISO timestamp>",
    "firstParent": null,
    "componentCount": 1,
    "categoryTotals": {
      "instructions": { "count": 1, "bytes": 8, "estimatedTokens": 2, "sourceOnlyCount": 0 }
    },
    "estimatedTokens": 2,
    "changes": [{
      "kind": "added", "path": "AGENTS.md", "previousTokens": null,
      "estimatedTokens": 2, "deltaTokens": 2, "component": 0
    }]
  }]
}
```

The actual `categoryTotals` has an entry for every category. Skill components have a `skill` object with directory root and `manifest` or `resource` role. The HTML report's skill-bundle table summarizes those same files, separating manifest token estimates from resource byte sizes; these summaries are not additional measurements. Default HTML and JSON contain commit IDs, dates, paths, provider/category labels, blob IDs, byte sizes, and estimates. They contain no source text. Paths and blob IDs can still disclose repository structure. HTML and JSON reports are local artifacts; the CLI writes them with mode `0600`. The HTML report carries a Content-Security-Policy that allows only its own inline style and script, so a browser will not load anything from the network on its behalf. The default measurement modes make no network request and upload no content. Explicit `--provider-api` mode sends recognized Claude and Gemini instructional text to the selected provider APIs for counting; reports store counts and measurement metadata, not submitted text.

`--shareable` produces schema version 9 with `privacy.mode: "shareable"`. It replaces repository and branch names, commit and first-parent IDs, component and change paths, skill roots, and blob IDs with deterministic aliases local to that report. The alias maps are not embedded. Dates, category and provider labels, counts, byte sizes, estimates, change kinds, and timeline shape remain visible. The default local report is unchanged. Shareable means reduced identifier exposure, not guaranteed anonymity; inspect before publishing.

## Revision comparison

The offline HTML report compares any two revisions present in the report; comparison semantics are unchanged by schema version 9. The timeline and target selector refer to the same revision; the baseline selector starts on "Previous revision", which follows the target so the comparison lists what the selected revision changed, and stays fixed once a specific revision is chosen. Before the first revision the baseline is empty. There is no separate list of changes at the selected revision; like any comparison, this one shows a rename as a removal plus an addition and says so, while the treemap's detail line still names a rename. The chart is capped at 100 bars, grouping adjacent revisions when needed and displaying the last revision in each group. Each bar's tooltip and accessible name give the revision numbers it covers. The chart starts at the first revision that has a tracked file in the current view, and the date under its left edge is that revision's; otherwise a repository that adopted agent configuration late would spend most of its bars on nothing. The slider covers the charted revisions so it stays aligned with the bars, and the baseline and target selectors still address every revision. While the slider is dragged, the summary, chart selection, legend, and treemap follow it immediately; the file inventory and comparison tables, which can hold thousands of rows, are redrawn once the slider settles or is released. Panels are not redrawn when moving between revisions that share the same inventory. The comparison shows signed differences in estimated stored-text tokens and tracked file counts, grouped by provider and category; groups with no difference are left out. No percentage is shown: it is derivable from the two totals and meaningless against a zero-token baseline. The timeline legend gives each category's stored-text tokens at the selected revision, or its file count when the category is source-only; there is no separate composition table.

The HTML view defaults to all tracked files, counted once. A provider view includes that provider's files and shared instruction candidates; a shared-only view displays those candidates by themselves. Shared files can occur in several provider views, so provider totals cannot be summed to recover the all-files total. Switching views projects every report panel from the same stored JSON data and resets inventory filters. A move between providers appears as a removal in one view and an addition in the other. This is a display choice, not a claim about an agent's active or loaded context. It does not change report schema version 9. The per-component change table omits file-count deltas because a single matched path can only be added (+1), removed (-1), or edited (0); aggregate file deltas remain in the provider/category and summary comparisons.

Components are matched by provider, category, and path. A changed blob at the same identity is shown as edited even if its token estimate is unchanged. A renamed or reorganized file may appear as a removal and addition; the comparison does not assert that instructions survived or that a refactor occurred. Source-only files affect file counts but contribute zero to estimated-token deltas.

## Composition treemap

The HTML report uses component measurements to draw a category-grouped treemap at the selected revision. Each positive-token instructional component receives a rectangle with area proportional to its estimated stored-text tokens; categories are contiguous and color-coded. Interior labels use the skill directory name or file name. They are checked against their rendered space and again on resize: the token count is removed when both lines do not fit, then the name is reduced, then cut to one small line ending in an ellipsis, and removed only when even that cannot fit. The treemap has no category legend of its own; the timeline legend above it uses the same colors. Every rectangle has a hover/focus detail line and an accessible name with the full path and token count; there is no separate browser tooltip repeating it. A rectangle whose file the selected revision added is outlined with a solid line, and one it edited or renamed with a dashed line; the detail line and accessible name say the same in words. The outline describes that one commit against its first parent, like the list of changes at this revision, and files a commit removed have no rectangle to mark. Source-only and zero-token components have no area and remain in the inventory; their counts are on the line under the treemap, which gives way to a rectangle's details while it is hovered or focused. A tall, narrow rectangle sets its name top to bottom rather than breaking it mid-word. The treemap is a stored-configuration composition view, not a map of runtime dependencies or loaded context. Keyboard-accessible rectangles locate the corresponding inventory row; the table remains the text alternative. The skill-bundle list is collapsed under its heading, which gives the bundle count, and is left out when the revision has no skill bundles; opened, it begins with eight rows and offers an explicit control to reveal the rest.

Rectangle layout uses `d3-hierarchy@3.1.2`'s squarified treemap. The generated report embeds the minified library and its ISC license and calculates the selected revision's layout in the browser; it requires no network access or separate assets.

## Report masthead

The HTML report's masthead names the analyzed repository and holds the figures for the selected revision. Its lower edge repeats the timeline as stepped category layers, following the same view, grouping, and scale as the chart beneath it; the layers use the chart's category colors and are decoration, hidden from assistive technology. The headline face, Archivo under the SIL Open Font License, and the page icon are inlined as `data:` URLs. The content security policy therefore allows fonts and images from `data:` only; the report still loads nothing from the network. The Strata name in the masthead and footer links to the package's npm page; it is the report's only outbound link, is followed only on click, opens without a referrer, and is the same in every report, so it carries nothing about the analyzed repository. [docs/brand](brand/README.md) describes the logo, colors, and type.

Category colors are shared by the HTML report and the SVG image. Instructions and skills take the brand's verdigris and clay hues and the other categories are spaced around them; the set is checked so that categories adjacent in the stack stay distinguishable under protanopia and deuteranopia and keep at least 3:1 contrast on both the light and the dark page ground. Treemap labels are white or near-black, whichever contrasts more with the category color. Token and file changes are colored by direction only, ochre for growth and verdigris for reduction, in darker steps on the light ground: stored configuration growing is not a failure, so the report does not use red and green, and the sign always carries the direction. The report follows the system's light or dark setting; the masthead is the same in both.

The tracked-components table is collapsed under its heading, which gives the file count; selecting a treemap rectangle opens it. It and the changed-components list show their first 25 rows, each with a control to show the rest. This limits what is drawn, not what is counted: totals, filters, and comparisons always cover every file. The measurement method and its limits sit behind a disclosure whose visible label states that the figures describe what Git stores, not loaded session context; a shallow-clone warning stays visible outside it.

## SVG image

`strata analyze --format svg` writes a static image of the history for a README or similar page. It draws the all-files view from the stored revision totals, so it needs no inventory replay. Each category with stored-text tokens is a stepped layer stacked on the previous ones in category order, using the HTML report's colors. The layers carry no outline: the top edge of the stack is the total. The chart follows the HTML timeline's rules: it starts at the first revision with a tracked file, holds at most 100 steps, and each step shows the last revision in its group. As in the HTML timeline, the vertical scale and legend cover every charted revision, so a peak or category inside a group is not dropped from them. Notes state when revisions were grouped and how many leading revisions without tracked configuration were left out. Axis steps are whole numbers. A header gives the latest token total, tracked-file count, revision count, and the token change since the first charted revision. The measurement label and a statement that this is stored configuration, not loaded session context or billing, are part of the image, as is a shallow-clone warning when it applies.

The image contains the repository and branch names, the first and last charted dates, category labels, and totals. It contains no paths, commit IDs, blob IDs, source text, script, links, or external resources, so it displays wherever SVG images are allowed, including GitHub READMEs. `--shareable` replaces the repository and branch names. Repository-derived text is XML-escaped, and characters XML cannot carry are removed. Text width is not measured, so the repository label is truncated to 60 characters and legend entries are placed by an estimated width. The output is deterministic for a given report: it contains no generation time. Because the image is meant for publication, the CLI does not restrict it to mode `0600` as it does HTML and JSON reports: a new image gets the permissions the user's umask allows, and an existing file keeps its mode.

`--minimal` reduces the image to the layers alone, for a banner or decorative use. It is 800 by 200 with a transparent background, and the layers fill it edge to edge: the tallest charted revision touches the top, so heights are relative and there is no axis to read a value from. It has no visible text, grid, legend, or notes, and so shows neither the measurement label nor the stored-configuration statement, nor the grouping, late-start, and shallow-clone notes; use the full image where a reader needs to interpret the numbers. The bucketing, chart start, category order, and colors match the full image. Its accessible description names the measurement kind and the latest totals. It contains no repository or branch name and no dates, so `--shareable` does not change it. `--minimal` with another format is a usage error.

## Pull-request comparison

`strata diff` compares two supplied full commit IDs by reading their tracked Git trees directly. It does not check out revisions or write into the target repository. It uses the same path classification, instructional-text boundary, and selected measurement mode as the history report. Its JSON has a separate schema version 3; Markdown is intended for a local file or an opt-in GitHub Actions job summary. Paths and commit IDs are visible, but source text is not. The composite Action does not post comments or enforce a token budget.
