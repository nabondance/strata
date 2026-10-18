# Cursor adapter study

Implemented in report schema version 14; [the analysis scope](analysis-scope.md) lists the patterns as recognized. This page keeps the evidence behind them.

Studied 2026-10-08. Cursor is the next candidate because its repository-level inputs include both instructional Markdown and structured configuration, and `AGENTS.md` is already recognized as shared. The adapter adds provider `cursor` without counting the same shared `AGENTS.md` twice.

| Tracked path | Classification | Evidence and boundary |
| --- | --- | --- |
| `**/.cursor/rules/**/*.mdc` | Cursor / rules / stored instructional text | [Cursor's current rules documentation](https://cursor.com/docs/rules) says project rules use `.mdc` under `.cursor/rules`, including nested directories. Rules can be always applied, conditional by glob, agent requested, or manual. A tracked file is not proof it loaded. |
| Root `.cursorrules` | Cursor / rules / stored instructional text, legacy | [Cursor's help](https://prod.cursor.com/help/customization/rules) describes this as supported legacy configuration. Keep it visibly labeled legacy; do not treat it as preferred current format. |
| `.cursor/commands/*.md` | Cursor / commands / stored instructional text | [Cursor's command documentation](https://docs.cursor.com/en/agent/chat/commands) describes project commands as Markdown files invoked through `/`; the feature is beta. A command's source size is not an always-loaded context cost. |
| `.cursor/mcp.json` | Cursor / tools / source bytes only | [Cursor's MCP documentation](https://docs.cursor.com/context/model-context-protocol) identifies this project config. Its JSON bytes are not runtime tool-schema tokens. |
| `AGENTS.md` | Retain shared / instructions | [Cursor's rules documentation](https://cursor.com/docs/rules) recognizes `AGENTS.md` as an alternative. Strata already measures it once under `shared`. |

The adapter does not treat plain `.md` files inside `.cursor/rules` as rules; Cursor's current documentation says a plain `.md` file there is ignored by the rules system. Like other unrecognized `.md`, `.mdc`, and `.json` files under `.cursor/`, they stay visible as source-only `other`, with no token count. Do not infer whether a rule was active from `alwaysApply`, globs, or path alone: that requires session and referenced-file evidence. Do not invent graph edges from `@filename` references without resolving and validating them.

The synthetic fixture in `test/analyze.test.mjs` covers a root and nested `.mdc`, ignored `.md` candidate, command, MCP JSON, legacy `.cursorrules`, and shared `AGENTS.md`, including additions, deletion, and a rename of `.cursorrules` into `.cursor/rules`. Adding the provider label moved the report schema to version 14 and the `strata diff` schema to version 7; all text stays local and out of default exports.
