---
name: strata-interpret
description: Interpret a Strata JSON report about Git-tracked AI-agent configuration history. Use when a user asks what changed in a Strata report or what its token estimates mean.
metadata:
  version: 1
---

# Interpret a Strata report

Read the user's Strata JSON report and check `schemaVersion` before interpreting fields. This skill describes schema version 2; if the report has another version, inspect its fields and avoid assuming this schema still applies.

Use `revisions` in array order as the first-parent history sampled by the report. Each revision has a commit `id`, `date`, `firstParent`, `components`, `categoryTotals`, `estimatedTokens`, and changes from its predecessor. The first revision's changes are relative to an empty baseline. If `shallow` is true, earlier history is unavailable. A merge appears as one revision measured against its first parent, not as a full branch history.

Explain growth or reduction using the relevant revisions, paths, categories, and providers. `estimatedTokens` is the sum of instructional-file estimates. The report's `measurement` object identifies the method; `utf8-bytes-divided-by-four-v1` rounds UTF-8 bytes / 4 up for each instructional file. It is a consistent stored-text comparison estimate, not a model tokenizer, session load, context-window use, or billing count. `bytes` measures source size. A component with `estimatedTokens: null` is source-only and contributes no estimated tokens; `sourceOnlyCount` counts these files. Do not turn settings, hooks, MCP files, or skill resources into prompt-token estimates.

Use `changes` to explain additions, removals, edits, and detected renames. `deltaTokens` describes the change in the stored-text estimate, not whether a change improved quality. A rename, a move into skills, or a claimed refactor may need content evidence beyond the report. Do not infer that a skill was loaded, a rule was active, or an agent used a component in a particular session.

The default report omits source text but includes repository paths, commit and blob IDs, and measurements. Treat these as potentially sensitive repository metadata. If the user asks for instruction-level meaning or why wording changed, inspect the relevant Git content with their authorization instead of inventing it from the JSON.
