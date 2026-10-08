# Current analysis scope

Strata reads Git-tracked files from every commit on the selected branch's first-parent path, oldest to newest. It does not inspect untracked or ignored files, global user configuration, or the working tree's current contents. A shallow clone is labeled incomplete.

## Recognized paths

These are inventory rules, not claims that an agent loaded a file in a session. `**/` means the pattern also applies under a nested project directory.

| Path pattern | Provider | Category | Measurement |
| --- | --- | --- | --- |
| `**/CLAUDE.md`, `**/CLAUDE.local.md`, `**/.claude/CLAUDE.md` | Claude | instructions | estimated stored-text tokens |
| `**/AGENTS.md` | shared | instructions | estimated stored-text tokens |
| `**/AGENTS.override.md` | Codex | instructions | estimated stored-text tokens |
| `**/.claude/skills/<name>/SKILL.md` | Claude | skills | estimated stored-text tokens |
| `**/.agents/skills/<name>/SKILL.md` | Codex | skills | estimated stored-text tokens |
| Other tracked files under either skill directory | same provider as the skill | skills | source bytes only |
| `**/.claude/agents/**/*.md` | Claude | agents | estimated stored-text tokens |
| `**/.claude/rules/**/*.md` | Claude | rules | estimated stored-text tokens |
| `**/.claude/commands/**/*.md` | Claude | commands | estimated stored-text tokens |
| `**/.claude/agent-memory[-local]/<name>/**/*.md` | Claude | memory | estimated stored-text tokens |
| `**/.claude/settings.json`, `**/.claude/settings.local.json` | Claude | settings | source bytes only |
| `.mcp.json` at repository root | Claude | tools | source bytes only |
| `**/.codex/config.toml` | Codex | settings | source bytes only |
| `**/.codex/agents/*.toml` | Codex | agents | source bytes only |
| `**/.codex/rules/**/*.rules` | Codex | rules | source bytes only |

Other `.md`, `.json`, `.toml`, and `.rules` files under `.claude/`, `.codex/`, or `.agents/` remain visible as `other` with source bytes only. Tracked skill references, scripts, and assets of any extension are grouped with their skill directory as source-only resources; a resource-only directory is not treated as a valid skill manifest. `.agents/` files outside a recognized skill directory have provider `unknown`. Files outside these conventions are not inferred to be agent configuration. Git symlinks are skipped. `AGENTS.md` is marked shared because both [Codex](https://learn.chatgpt.com/docs/agent-configuration/agents-md) and, conditionally, [Claude Code](https://code.claude.com/docs/en/memory) can read it. Claude's default may prefer `CLAUDE.md`; Codex overrides may supersede `AGENTS.md`. Strata does not resolve those runtime conditions.

The recognition rules follow current provider documentation for [Claude instructions and rules](https://code.claude.com/docs/en/memory), [Claude skills and commands](https://code.claude.com/docs/en/skills), [Claude subagents and memory](https://code.claude.com/docs/en/sub-agents), [Claude settings](https://code.claude.com/docs/en/settings), [Claude MCP](https://code.claude.com/docs/en/mcp), [Codex instructions](https://learn.chatgpt.com/docs/agent-configuration/agents-md), [Codex skills](https://learn.chatgpt.com/docs/build-skills), [Codex custom agents](https://learn.chatgpt.com/docs/agent-configuration/subagents), [Codex project configuration](https://learn.chatgpt.com/docs/config-file/config-basic), and [Codex rules](https://learn.chatgpt.com/docs/agent-configuration/rules). Recognition is intentionally conservative: a Codex TOML agent or `.rules` file can contain text, but Strata does not count its entire source as an instruction prompt.

## Measurements and history

The token figure is a **comparison estimate**: `ceil(UTF-8 byte length / 4)` for each recognized instructional file, summed across files. The same method is applied to every revision. This is neither an Anthropic nor OpenAI tokenizer, and it is not a model-specific context or billing count. On four representative synthetic snippets, the estimates were 14, 29, 23, and 16, while a local `cl100k_base` reference tokenizer produced 9, 26, 25, and 15. The difference moves in both directions; even that reference tokenizer would not measure Claude context. No repository content was sent to a tokenizer service. [Anthropic's token counting API](https://platform.claude.com/docs/en/build-with-claude/token-counting) is model-dependent and remote. Strata keeps analysis local.

Structured configuration, MCP, permission rules, and supporting files are inventoried by source bytes and excluded from instructional token totals. Category counts describe stored files, not active skills, loaded rules, or runtime cost. Category totals include a `sourceOnlyCount` so a zero token total is not mistaken for an empty source file. Schema version 4 includes a `skill` root and role on each skill component, `skillGroups` on each revision, and a report `privacy.mode`. The group summaries refer to the same components already counted by category and must not be added to category totals.

Changes compare adjacent first-parent revisions. Git rename detection (`-M`) supports a rename label when Git finds sufficient content similarity; otherwise the report shows a removal and addition. A merge is compared with its first parent. The report does not infer a refactor or architecture dependency from paths alone.

The HTML comparison view can compare any two sampled revisions, including earlier targets. Its provider, category, and component deltas use the stored measurements at each endpoint. Component identity is provider, category, and path, so an arbitrary-range move can appear as a removal and addition even when an adjacent revision's `changes` array labels a Git-detected rename.

The default HTML and JSON contain full commit IDs, dates, paths, provider and category labels, blob IDs, byte sizes, and estimates. They contain no file contents. `--shareable` replaces the repository and branch names, commit IDs, paths, skill roots, and blob IDs with deterministic aliases while retaining dates and measurements. These values can still reveal the shape and timing of a project; inspect reports before distribution. Use `--output` to choose where the report is written; Strata does not write to the repository it analyzes unless that path is chosen explicitly.
