# First-release decisions

Recorded 2026-10-08. These choices describe the current implementation, not a package publication or claim about runtime context.

## Name and command

The npm package name is `context-strata`; its executable is `strata`. Direct queries to the npm registry on 2026-10-08 returned 404 for `context-strata` and `strata@0.20.1` for `strata`. A 404 is not a reservation. The package remains private and unpublished; verify availability again before release. The intended command after publication is `npx context-strata analyze . --output report.html`.

## Measurement

Stored instructional text uses Strata's `utf8-bytes-divided-by-four-v1` comparison estimate: `ceil(UTF-8 bytes / 4)` per file, then sum. There is no tokenizer dependency or network request. Four synthetic instruction, skill, multilingual, and code samples produced 14, 29, 23, and 16 estimated tokens. A local `js-tiktoken@1.0.21` `cl100k_base` comparison produced 9, 26, 25, and 15. The reference tokenizer is not Claude's tokenizer either, and the sample is too small to establish general accuracy. The estimate is useful for consistent historical trends, not exact context or billing claims. Structured config and supporting resources are source bytes only.

## Report contract and privacy

Schema version 2 adds provider labels, an `other` category for visible unsupported candidates, and `sourceOnlyCount` in each category total. A shortened, illustrative JSON shape:

```json
{
  "schemaVersion": 2,
  "repository": "example",
  "branch": "main",
  "shallow": false,
  "measurement": {
    "label": "Estimated stored-text tokens",
    "method": "utf8-bytes-divided-by-four-v1: UTF-8 bytes / 4, rounded up per instructional file",
    "limitations": "Comparison estimate only."
  },
  "revisions": [{
    "id": "<full Git commit ID>",
    "date": "<author ISO timestamp>",
    "firstParent": null,
    "components": [{
      "path": "AGENTS.md", "provider": "shared", "category": "instructions",
      "blob": "<Git blob ID>", "bytes": 8, "estimatedTokens": 2
    }],
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

The actual `categoryTotals` has an entry for every category. Default HTML and JSON contain commit IDs, dates, paths, provider/category labels, blob IDs, byte sizes, and estimates. They contain no source text. Paths and blob IDs can still disclose repository structure. Generated reports are local artifacts; the CLI sets output mode `0600`. No telemetry or content upload is used.

## Revision comparison

The offline HTML report compares any two revisions already present in schema version 2, so the JSON schema is unchanged. The timeline and target selector refer to the same revision; the baseline selector stays fixed when the target changes. The comparison shows signed differences in estimated stored-text tokens and tracked file counts, grouped by provider and category. A zero-token baseline has no meaningful percentage change and is shown without a percentage.

Components are matched by provider, category, and path. A changed blob at the same identity is shown as edited even if its token estimate is unchanged. A renamed or reorganized file may appear as a removal and addition; the comparison does not assert that instructions survived or that a refactor occurred. Source-only files affect file counts but contribute zero to estimated-token deltas.

## Composition treemap

The HTML report uses schema version 2 component measurements to draw a category-grouped treemap at the selected revision. Each positive-token instructional component receives a rectangle with area proportional to its estimated stored-text tokens; categories are contiguous and color-coded. Source-only and zero-token components have no area and remain in the inventory, with their counts stated beside the treemap. The treemap is a stored-configuration composition view, not a map of runtime dependencies or loaded context. Keyboard-accessible rectangles locate the corresponding inventory row; the table remains the text alternative.
