# Current analysis scope

This is Strata's first local report slice. It reads Git-tracked files from every commit on the selected branch's first-parent path, oldest to newest. It does not inspect untracked or ignored files, global user configuration, or the working tree's current contents. A shallow clone is labeled incomplete.

## Recognized files

| Path pattern | Category | Measurement |
| --- | --- | --- |
| `CLAUDE.md` at any depth | instructions | estimated stored-text tokens |
| `AGENTS.md` at any depth | instructions, shared | estimated stored-text tokens |
| `.claude/skills/<name>/SKILL.md` | skills | estimated stored-text tokens |
| `.claude/agents/**/*.md` | agents | estimated stored-text tokens |
| `.claude/rules/**/*.md` | rules | estimated stored-text tokens |
| `.claude/commands/**/*.md` | commands | estimated stored-text tokens |
| `.claude/agent-memory/<name>/**/*.md` | memory | estimated stored-text tokens |
| `.claude/settings.json`, `.claude/settings.local.json` | settings | source bytes only |
| `.mcp.json` at repository root | tools | source bytes only |

The `.claude/` patterns also work under nested project directories. Git symlinks are skipped; the bytes of a symlink path are not an instruction file. Supporting files inside skill folders are currently excluded unless they match one of the paths above. This boundary will be revisited when skill bundles are modeled explicitly.

These paths follow Claude Code's current documentation for [instructions and rules](https://code.claude.com/docs/en/memory), [skills and commands](https://code.claude.com/docs/en/skills), and [subagents and project memory](https://code.claude.com/docs/en/sub-agents). `AGENTS.md` is labeled shared because Claude Code can read it as project instructions and other agents use it too. Recognition does not imply that every file was loaded into a particular session.

## Measurements and history

The token figure is a **comparison estimate**: `ceil(UTF-8 byte length / 4)` for each instructional file, summed across files. The same method is applied to every revision. This is neither an Anthropic tokenizer nor a model-specific context or billing count. [Anthropic's token counting API](https://platform.claude.com/docs/en/build-with-claude/token-counting) is model-dependent and may include message structure; calling it for every historical file would also send repository content to an external service. Strata keeps this analysis local.

Settings and MCP files are inventoried by source bytes and excluded from instructional token totals. This avoids equating JSON source bytes with prompt or tool-schema tokens. Category counts describe stored files, not active skills, loaded rules, or runtime cost.

Changes compare adjacent first-parent revisions. Git rename detection (`-M`) supports a rename label when Git finds sufficient content similarity; otherwise the report shows a removal and addition. A merge is compared with its first parent. The report does not infer a refactor or architecture dependency from paths alone.

The generated HTML and JSON include revision IDs, dates, paths, blob IDs, byte sizes, and estimates. They contain no file contents. Use `--output` to choose where the report is written; Strata does not write to the repository it analyzes unless that path is chosen explicitly.
