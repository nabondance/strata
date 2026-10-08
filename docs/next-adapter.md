# Next ecosystem adapter: Cursor

Studied 2026-10-08. Cursor is the next candidate because its repository-level inputs include both instructional Markdown and structured configuration, and `AGENTS.md` is already recognized as shared. The proposed implementation should add provider `cursor` without counting the same shared `AGENTS.md` twice.

| Tracked path | Proposed classification | Evidence and boundary |
| --- | --- | --- |
| `**/.cursor/rules/**/*.mdc` | Cursor / rules / stored instructional text | [Cursor's current rules documentation](https://cursor.com/docs/rules) says project rules use `.mdc` under `.cursor/rules`, including nested directories. Rules can be always applied, conditional by glob, agent requested, or manual. A tracked file is not proof it loaded. |
| Root `.cursorrules` | Cursor / rules / stored instructional text, legacy | [Cursor's help](https://prod.cursor.com/help/customization/rules) describes this as supported legacy configuration. Keep it visibly labeled legacy; do not treat it as preferred current format. |
| `.cursor/commands/*.md` | Cursor / commands / stored instructional text | [Cursor's command documentation](https://docs.cursor.com/en/agent/chat/commands) describes project commands as Markdown files invoked through `/`; the feature is beta. A command's source size is not an always-loaded context cost. |
| `.cursor/mcp.json` | Cursor / tools / source bytes only | [Cursor's MCP documentation](https://docs.cursor.com/context/model-context-protocol) identifies this project config. Its JSON bytes are not runtime tool-schema tokens. |
| `AGENTS.md` | Retain shared / instructions | [Cursor's rules documentation](https://cursor.com/docs/rules) recognizes `AGENTS.md` as an alternative. Strata already measures it once under `shared`. |

The initial adapter should exclude plain `.md` files inside `.cursor/rules`; Cursor's current documentation explicitly says that a rule without `.mdc` and frontmatter is ignored. Other files under `.cursor/` can remain visible as source-only candidates after verifying their semantics. Do not infer whether a rule was active from `alwaysApply`, globs, or path alone: that requires session and referenced-file evidence. Do not invent graph edges from `@filename` references without resolving and validating them.

Before implementation, build a synthetic fixture covering a root and nested `.mdc`, ignored `.md` candidate, command, MCP JSON, legacy `.cursorrules`, and shared `AGENTS.md`, including additions and deletion. Update the report schema when adding the provider label, and keep all text local and excluded from default exports.
