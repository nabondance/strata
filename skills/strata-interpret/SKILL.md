---
name: strata-interpret
description: Interpret a Strata JSON report about Git-tracked AI-agent configuration history. Use when a user asks what changed in a Strata report or what its token estimates mean.
metadata:
  version: 3
---

# Interpret a Strata report

Read the user's Strata JSON report and check `schemaVersion` before interpreting fields. This skill describes schema version 6; if the report has another version, inspect its fields and avoid assuming this schema still applies.

Use `revisions` in array order as the first-parent history sampled by the report. Each revision has a commit `id`, `date`, `firstParent`, `components`, `skillGroups`, `categoryTotals`, `estimatedTokens`, and changes from its predecessor. The first revision's changes are relative to an empty baseline. If `shallow` is true, earlier history is unavailable. A merge appears as one revision measured against its first parent, not as a full branch history.

`skillGroups` summarizes each tracked skill directory. A group lists its provider, manifest path and estimated tokens, plus supporting resource count and bytes. Each component also has a `skill` root and `manifest` or `resource` role. These are alternate views of the same files: do not add group numbers to `categoryTotals` or count resource bytes as tokens. A group without a manifest is a directory of tracked resources, not evidence that a runnable skill exists.

Explain growth or reduction using the relevant revisions, paths, categories, and providers. `estimatedTokens` sums instructional-file counts. Check `measurement.family`, `accuracy`, `model`, `encoding`, and `implementation` before describing them. The default `utf8-bytes-divided-by-four-v1` is a comparison estimate. An OpenAI encoding mode is exact for stored text under the named encoding, but does not measure full requests, session load, context-window use, or billing; it does not establish Claude or Gemini counts. `bytes` measures source size. A component with `estimatedTokens: null` is source-only and contributes no tokens; `sourceOnlyCount` counts these files. Do not turn settings, hooks, MCP files, or skill resources into prompt-token estimates.

Use `changes` to explain additions, removals, edits, and detected renames. `deltaTokens` describes the change in the stored-text estimate, not whether a change improved quality. A rename, a move into skills, or a claimed refactor may need content evidence beyond the report. Do not infer that a skill was loaded, a rule was active, or an agent used a component in a particular session.

The default local report omits source text but includes repository paths, commit and blob IDs, and measurements. A `privacy.mode` of `shareable` means those identifiers were replaced with aliases; dates and measurements remain visible. Aliases are stable within one report but are not cross-report identities. Treat all remaining metadata as potentially sensitive. If the user asks for instruction-level meaning or why wording changed, inspect the relevant Git content with their authorization instead of inventing it from the JSON.
