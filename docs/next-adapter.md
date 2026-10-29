# Cursor adapter study

Implemented in report schema version 14. [The analysis scope](analysis-scope.md) lists these patterns as recognized; this page keeps the evidence behind them.

Studied 2026-10-08. Cursor was chosen as the next provider for two reasons:

- its repository files include both instructional Markdown and structured configuration;
- it reads `AGENTS.md`, which Strata already recognizes as shared.

The adapter adds provider `cursor` without counting the shared `AGENTS.md` twice.

Terms used below:

- A *provider* is the tool a file belongs to.
- A *category* is the kind of configuration (`rules`, `commands`, `tools`, and so on).
- *Stored instructional text* is prose Strata gives a token estimate.
- *Source bytes only* means Strata records the file's size but no token count, because it is structured configuration, a supporting resource, or a file the tool does not read as prompt text.
- *Readers* are the providers documented as reading a file.
- *Legacy* marks a format the tool still reads but documents as replaced.

| Tracked path | Classification | Evidence and boundary |
| --- | --- | --- |
| `**/.cursor/rules/**/*.mdc` | Cursor / rules / stored instructional text | [Cursor's current rules documentation](https://cursor.com/docs/rules) says project rules use `.mdc` files under `.cursor/rules`, including nested directories. A rule can be always applied, applied when a glob matches, requested by the agent, or applied manually. A tracked file is not proof it loaded. |
| Root `.cursorrules` | Cursor / rules / stored instructional text, legacy | [Cursor's help](https://prod.cursor.com/help/customization/rules) describes this as supported legacy configuration. Keep it visibly labeled legacy; do not treat it as the preferred current format. |
| `.cursor/commands/*.md` | Cursor / commands / stored instructional text | [Cursor's command documentation](https://docs.cursor.com/en/agent/chat/commands) describes project commands as Markdown files the user runs with `/`. The feature is beta. A command runs only on request, so its source size is not a cost paid in every session. |
| `.cursor/mcp.json` | Cursor / tools / source bytes only | [Cursor's MCP documentation](https://docs.cursor.com/context/model-context-protocol) identifies this project configuration file. Its JSON size is not the token cost of the tool definitions the servers expose at runtime. |
| `AGENTS.md` | Stays shared / instructions; Cursor reads it at revisions with Cursor configuration | [Cursor's rules documentation](https://cursor.com/docs/rules) accepts `AGENTS.md` as an alternative. Strata already measures it once under `shared`. |
| `.cursor/skills/<name>/SKILL.md` | Cursor / skills | [Cursor's skills documentation](https://cursor.com/docs/context/skills) lists `.cursor/skills` and `.agents/skills`, plus `.claude/skills` and `.codex/skills` for compatibility. This row was added after a smoke run found `.cursor/skills` in a real project. `.codex/skills`, which current Codex documentation no longer lists, stays Codex `other`, because Strata cannot tell which tool it is kept for. |
| Root `.cursorignore` | Cursor / settings / source bytes only | [Cursor's ignore-file documentation](https://cursor.com/docs/context/ignore-files). |
| `.agents/skills`, `.claude/skills` | Keep their labels; Cursor reads them at revisions with Cursor configuration | Same skills documentation. Cursor needs no repository file, so a Claude-only repository must stay Claude-only. Cursor counts as a reader of another tool's file only at a revision that tracks a Cursor file. |

## Files kept as `other`

- Plain `.md` files inside `.cursor/rules` are not rules. Cursor's current documentation says the rules system ignores them.
- Those files, and any other `.md`, `.mdc`, or `.json` file that no rule above recognizes under `.cursor/rules`, `.cursor/commands`, or `.cursor/skills`, stay visible as source-only `other`, with no token count. So do top-level `.cursor/*.json` files.
- Projects also keep their own notes and reports under `.cursor/`, so Markdown elsewhere under it is not inventoried.

## What the adapter does not infer

- Whether a rule was active. `alwaysApply`, globs, or the path alone cannot show it; that needs evidence from the session and from the files it referenced.
- Links between files. Do not draw graph edges from `@filename` references without resolving and validating them.

## Test coverage

The synthetic fixture in `test/analyze.test.mjs` covers:

- a root and a nested `.mdc` rule;
- a plain `.md` file in `.cursor/rules`, which is ignored as a rule;
- scratch notes under `.cursor/`;
- skills in each directory Cursor reads;
- a Claude-only phase before Cursor appears, and a phase after it is removed;
- a command, the MCP JSON file, the legacy `.cursorrules`, and the shared `AGENTS.md`;
- additions, a deletion, and a rename of `.cursorrules` into `.cursor/rules`.

Adding the provider label moved the report schema to version 14 and the `strata diff` schema to version 7. All file text stays local and out of default exports.
