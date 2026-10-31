# Current analysis scope

Strata reads the files Git tracks in every commit on the selected branch's first-parent path, from oldest to newest. The first-parent path is the branch's own line of commits: at a merge commit, Strata continues along the branch that received the merge and does not walk the commits merged into it. Each commit on that path is a _revision_ in the report. File contents come from Git's stored copy of each file version, called a _blob_, not from the files on disk.

Strata does not inspect:

- untracked or ignored files;
- global user configuration;
- the working tree, meaning the files currently checked out on disk.

A shallow fetch downloads only recent commits. A history that starts where a shallow fetch cut it is labeled incomplete.

Files inside a Git submodule belong to that submodule's repository and are not analyzed. So that configuration kept in a submodule is not silently missing, Strata checks each submodule present at the last revision:

- When the submodule's repository is checked out locally and has the commit the parent repository records, Strata lists that commit's files with the same path rules and counts the recognized ones.
- It reads only Git objects, never the submodule's working tree. Nothing in the submodule is measured or added to any total.
- The report names the submodules that hold recognized files, and counts those it could not check.

To see a submodule's history, run Strata on the submodule's own checkout.

## Recognized paths

These are inventory rules: they say which tracked files Strata lists, not that an agent loaded a file in a session. `**/` means the pattern also applies under a nested project directory. In the Measurement column:

- **estimated stored-text tokens**: Strata estimates the tokens in the file's stored text; see [Measurements and history](#measurements-and-history). These are the _instructional_ files.
- **listed name and description tokens**: the skill's frontmatter `name` and `description`, which an agent lists before the skill is used, are also measured on their own.
- **source bytes only**: Strata records the file's size in bytes and gives it no token figure. This page calls such files _source-only_.

| Path pattern                                                                                                      | Provider                                                                                   | Category                                          | Measurement                                                          |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------- | -------------------------------------------------------------------- |
| `**/CLAUDE.md`, `**/.claude/CLAUDE.md`                                                                            | Claude (also read by Copilot when configured)                                              | instructions                                      | estimated stored-text tokens                                         |
| `**/CLAUDE.local.md`                                                                                              | Claude                                                                                     | instructions                                      | estimated stored-text tokens                                         |
| `**/REVIEW.md`                                                                                                    | Claude, for Code Review (also read by Copilot code review when configured)                 | instructions                                      | estimated stored-text tokens                                         |
| `**/AGENTS.md`                                                                                                    | shared (Claude, Codex; Gemini CLI, Copilot, and Cursor when configured)                    | instructions                                      | estimated stored-text tokens                                         |
| `**/AGENTS.override.md`                                                                                           | Codex                                                                                      | instructions                                      | estimated stored-text tokens                                         |
| `**/.claude/skills/<name>/SKILL.md`                                                                               | Claude (also read by Copilot and Cursor when configured)                                   | skills                                            | estimated stored-text tokens, and listed name and description tokens |
| `**/.agents/skills/<name>/SKILL.md`                                                                               | shared (Codex, Gemini CLI; Copilot and Cursor when configured)                             | skills                                            | estimated stored-text tokens, and listed name and description tokens |
| Other tracked files under either skill directory                                                                  | same provider as the skill                                                                 | skills                                            | source bytes only                                                    |
| `**/.claude/agents/**/*.md`                                                                                       | Claude (also read by Copilot when configured, except `README.md`)                          | agents                                            | estimated stored-text tokens                                         |
| `**/.claude/rules/**/*.md`                                                                                        | Claude (also read by Copilot when configured, except `README.md`)                          | rules                                             | estimated stored-text tokens                                         |
| `**/.claude/commands/**/*.md`                                                                                     | Claude                                                                                     | commands                                          | estimated stored-text tokens                                         |
| `**/.claude/agent-memory[-local]/<name>/**/*.md`                                                                  | Claude                                                                                     | memory                                            | estimated stored-text tokens                                         |
| `**/.claude/settings.json`, `**/.claude/settings.local.json`                                                      | Claude                                                                                     | settings                                          | source bytes only                                                    |
| `.mcp.json` at repository root                                                                                    | Claude (also read by Copilot when configured)                                              | tools                                             | source bytes only                                                    |
| `**/.codex/config.toml`                                                                                           | Codex                                                                                      | settings                                          | source bytes only                                                    |
| `**/.codex/agents/*.toml`                                                                                         | Codex                                                                                      | agents                                            | source bytes only                                                    |
| `**/.codex/rules/**/*.rules`                                                                                      | Codex                                                                                      | rules                                             | source bytes only                                                    |
| `**/GEMINI.md`                                                                                                    | Gemini CLI (unless `context.fileName` leaves it out; also read by Copilot when configured) | instructions                                      | estimated stored-text tokens                                         |
| `**/.gemini/system.md`                                                                                            | Gemini CLI                                                                                 | instructions (conditional system-prompt override) | estimated stored-text tokens                                         |
| `**/.gemini/agents/*.md`, except names starting with `_`                                                          | Gemini CLI                                                                                 | agents                                            | estimated stored-text tokens                                         |
| `**/.gemini/skills/<name>/SKILL.md`, `**/.gemini/skills/SKILL.md`, `**/.agents/skills/SKILL.md`                   | Gemini CLI                                                                                 | skills                                            | estimated stored-text tokens, and listed name and description tokens |
| Other tracked files under `.gemini/skills/<name>/`                                                                | Gemini CLI                                                                                 | skills                                            | source bytes only                                                    |
| `**/.gemini/settings.json`                                                                                        | Gemini CLI                                                                                 | settings                                          | source bytes only                                                    |
| `**/.gemini/commands/**/*.toml`                                                                                   | Gemini CLI                                                                                 | commands                                          | source bytes only                                                    |
| `**/.cursor/rules/**/*.mdc`                                                                                       | Cursor                                                                                     | rules                                             | estimated stored-text tokens                                         |
| `.cursorrules` at repository root                                                                                 | Cursor                                                                                     | rules, labeled legacy                             | estimated stored-text tokens                                         |
| `**/.cursor/commands/*.md`                                                                                        | Cursor                                                                                     | commands                                          | estimated stored-text tokens                                         |
| `**/.cursor/mcp.json`                                                                                             | Cursor                                                                                     | tools                                             | source bytes only                                                    |
| `**/.cursor/skills/<name>/SKILL.md`                                                                               | Cursor                                                                                     | skills                                            | estimated stored-text tokens, and listed name and description tokens |
| Other tracked files under `.cursor/skills/<name>/`                                                                | Cursor                                                                                     | skills                                            | source bytes only                                                    |
| `.cursorignore` at repository root                                                                                | Cursor                                                                                     | settings                                          | source bytes only                                                    |
| `**/.github/copilot-instructions.md`                                                                              | Copilot                                                                                    | instructions                                      | estimated stored-text tokens                                         |
| `**/.github/instructions/**/*.instructions.md`                                                                    | Copilot                                                                                    | rules                                             | estimated stored-text tokens                                         |
| `**/.github/prompts/*.prompt.md`                                                                                  | Copilot                                                                                    | commands                                          | estimated stored-text tokens                                         |
| `**/.github/agents/**/*.md`, except `README.md`                                                                   | Copilot                                                                                    | agents; a `.chatmode.md` is labeled legacy        | estimated stored-text tokens                                         |
| `**/.github/skills/<name>/SKILL.md`                                                                               | Copilot                                                                                    | skills                                            | estimated stored-text tokens, and listed name and description tokens |
| Other tracked files under `.github/skills/<name>/`                                                                | Copilot                                                                                    | skills                                            | source bytes only                                                    |
| `**/.github/mcp.json`, `.vscode/mcp.json` at repository root                                                      | Copilot                                                                                    | tools                                             | source bytes only                                                    |
| `.github/hooks/*.json`, `.github/copilot/settings.json`, `.github/copilot/settings.local.json` at repository root | Copilot                                                                                    | settings                                          | source bytes only                                                    |
| `.github/workflows/copilot-setup-steps.yml`, `.github/workflows/copilot-code-review.yml`                          | Copilot                                                                                    | settings                                          | source bytes only                                                    |

Files in a provider's folder that no rule above recognizes stay visible as category `other`, with source bytes only:

| Where                                                             | Provider   | Files kept as `other`                                                                                                                                |
| ----------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.claude/`                                                        | Claude     | `.md`, `.json`, `.toml`, `.rules`                                                                                                                    |
| `.codex/`                                                         | Codex      | `.md`, `.json`, `.toml`, `.rules`, including `.codex/skills` (see [Cursor](#cursor))                                                                 |
| `.gemini/`                                                        | Gemini CLI | `.md`, `.json`, `.toml`, `.rules`, including `.gemini/agents` files whose names start with `_` or that sit in a subdirectory, which Gemini CLI skips |
| `.agents/`, outside a skill directory                             | `unknown`  | `.md`, `.json`, `.toml`, `.rules`                                                                                                                    |
| `.cursor/rules/`, `.cursor/commands/`, `.cursor/skills/`          | Cursor     | `.md`, `.mdc`, `.json`, including plain `.md` rules, which Cursor ignores because a rule needs the `.mdc` extension                                  |
| Directly in `.cursor/`                                            | Cursor     | `.json` other than `mcp.json`, such as `hooks.json`                                                                                                  |
| `.github/instructions/`, `.github/prompts/`, `.github/chatmodes/` | Copilot    | `.md`                                                                                                                                                |
| `.github/agents/`                                                 | Copilot    | `README.md`, which VS Code skips                                                                                                                     |
| `.github/skills/`, `.github/copilot/`                             | Copilot    | `.md`, `.json`, `.toml`, `.rules`                                                                                                                    |

Other path rules:

- Projects also keep their own notes and reports in `.cursor/`, so Markdown elsewhere under it, such as `.cursor/docs/` or `.cursor/NOTES.md`, is not inventoried.
- Tracked skill references, scripts, and assets of any extension are grouped with their skill directory as source-only resources. A directory that holds only resources, with no `SKILL.md`, is not treated as a valid skill.
- Files outside these conventions are not assumed to be agent configuration.
- Git symlinks are skipped. The exception is a symlink that a Claude `@path` import names: the link is still not inventoried, but the import reaches the file it leads to; see [How an import path resolves](#how-an-import-path-resolves).
- These path labels identify candidate files. They do not claim that a file was loaded at runtime.
- Recognition is deliberately conservative: structured Codex and Gemini command and configuration files stay source-only, rather than counting their full source as prompt text.

### Shared files and readers

A _component_ is one version of a tracked file, as the report's `components` table lists it. A shared component lists in `readers` the providers documented as reading its path. A reader can still depend on a runtime condition Strata does not resolve.

- `AGENTS.md` is marked shared because both [Codex](https://learn.chatgpt.com/docs/agent-configuration/agents-md) and, conditionally, [Claude Code](https://code.claude.com/docs/en/memory) can read it. Claude's default may prefer `CLAUDE.md`, and Codex overrides may take the place of `AGENTS.md`. Strata does not resolve those runtime conditions.
- Gemini CLI reads `AGENTS.md` only when its settings name it in `context.fileName`. Strata resolves that one condition per revision; see [Gemini CLI context files](#gemini-cli-context-files).
- `.agents/skills` is shared between Codex and Gemini CLI, which both discover project skills there. Claude Code does not.
- Cursor and Copilot also read some files that belong to other tools, under the conditions described next.

### Cursor

Cursor needs no file in the repository, so a repository cannot prove whether or not it is used with Cursor. Cursor reads these files that belong to other tools:

- [`AGENTS.md`](https://cursor.com/docs/rules), including nested ones;
- [skills](https://cursor.com/docs/context/skills) from `.agents/skills` and, for compatibility, `.claude/skills`.

Strata counts Cursor as reading those files only at a revision that tracks Cursor configuration: any file labeled Cursor, such as `.cursor/rules`, `.cursorrules`, or `.cursorignore`. As a result:

- A Claude-only repository is described as Claude-only. Its `.claude/skills` stay `claude`, and when no revision tracks Cursor configuration, the report never mentions Cursor.
- When some revision does, Cursor appears in the `readers` of `AGENTS.md`, `.agents/skills`, and `.claude/skills` (which stays labeled `claude`). The Cursor view includes them only from the revisions that track Cursor files. Adding or removing the last Cursor file lists them as added or removed in that view.
- A team that uses Cursor without tracking any Cursor file is not detected.

Skills:

- Cursor also loads `.codex/skills`, which current Codex documentation no longer lists. Those files stay Codex `other`, because Strata cannot tell which tool they are kept for.
- A skill Cursor reads from `.claude/skills` or `.agents/skills` keeps the listing measured by its own tool's rules: Claude Code's, or Codex and Gemini CLI's. Cursor requires `name` and `description`, and would skip a skill that relies on Claude's defaults.
- Strata does not check Cursor's rule that `name` match the skill directory.

Rules, commands, and MCP:

- A Cursor rule can be always applied, applied when a glob matches, requested by the agent, or applied only when mentioned. Strata measures each rule's text, frontmatter included.
- Strata reads `alwaysApply` only to label a root rule as kept from the start of a session (see [Up-front context](decisions.md#up-front-context)). It does not read `globs` or `description` to decide whether a rule was active, and does not resolve `@file` references in a rule. A tracked rule is a candidate, not proof it loaded.
- A Cursor command is invoked by the user, so its stored size is not a cost paid in every session.
- The root `.cursorrules` still works, but Cursor documents it as replaced by `.cursor/rules`. Its component carries `legacy: true`, and the HTML report labels its category `rules (legacy)`.
- `.cursor/mcp.json` is measured in source bytes. Its size is not the token cost of the tool schemas the servers expose.
- `--precise` has no Cursor count, because Cursor runs many models. Cursor files keep the estimate, and `AGENTS.md` is counted only for its other readers.

### GitHub Copilot

GitHub Copilot is several clients:

- Copilot Chat on GitHub.com;
- the cloud agent;
- code review;
- Copilot CLI;
- Copilot Chat in VS Code and other IDEs.

Each client reads a different subset of these files; GitHub's [support matrix](https://docs.github.com/en/copilot/reference/custom-instructions-support) lists which. Strata labels a file Copilot when at least one client is documented as reading it. It does not say which client did.

Like Cursor, Copilot needs no file in the repository, and it reads files that belong to other tools:

- `AGENTS.md`;
- `CLAUDE.md` and `.claude/CLAUDE.md`, but not `CLAUDE.local.md`;
- `REVIEW.md`;
- `GEMINI.md`, whatever Gemini's `context.fileName` says;
- `.claude/agents` and `.claude/rules`, except a `README.md` there, which VS Code skips;
- `.claude/skills` and `.agents/skills`;
- the root `.mcp.json`.

Strata counts Copilot as reading them only at a revision that tracks a file labeled Copilot. When no revision does, Copilot is left out of every `readers`. This condition is separate from Cursor's. Those files keep their own provider label, so the Claude, Gemini CLI, and shared totals do not change when a repository adopts Copilot.

Copilot also reads hooks from `.claude/settings.json`, but that file stays Claude-only, because Copilot uses only its `hooks` field.

Strata does not interpret `applyTo`, `excludeAgent`, `target`, or `description` frontmatter. It does not resolve which file wins when several apply, such as the nearest `AGENTS.md`.

Agents and chat modes:

- VS Code reads prompt files and agents only directly inside `.github/prompts` and `.github/agents`. Copilot CLI also reads agents in subfolders and in nested `.github/agents` folders. The agents pattern covers both.
- A `.chatmode.md` is the format that custom agents replaced. VS Code still reads one inside `.github/agents`, and Strata labels it legacy. VS Code no longer reads `.github/chatmodes` unless a user setting adds it, so files there stay `other`.

`REVIEW.md` holds code review guidance:

- [Claude Code's Code Review](https://code.claude.com/docs/en/code-review-customize) reads it at the root and in subfolders, for changes under that folder.
- Copilot code review reads it as it reads `CLAUDE.md`.
- The local Claude Code `/code-review` command does not read it.
- It is labeled Claude, with Copilot as a reader.

Skills and measurement:

- Copilot CLI also accepts namespaced skills (`.github/skills/<group>/<name>/SKILL.md`). Strata groups those files under `<group>` as resources and does not list them.
- A skill Copilot reads from `.claude/skills` or `.agents/skills` keeps the listing measured by its own tool's rules. Copilot requires `name` and `description`.
- Copilot has no token count endpoint, so `--precise` sends no Copilot text, and Copilot files keep the report's measurement.

Organization and enterprise agents, personal instructions, and settings stored on GitHub are outside the repository.

### Gemini CLI context files

Gemini CLI reads project instructions from _context files_. The default context filename is `GEMINI.md`, and a configured `context.fileName` replaces that default.

At each revision, Strata reads the tracked `.gemini/settings.json` at the repository root, ignoring `//` and `/* */` comments as Gemini CLI does:

- When `context.fileName` (or its older name, `contextFileName`) is set, the revision's `geminiContextFiles` records which of `AGENTS.md` (`agents-md`) and `GEMINI.md` (`gemini-md`) it names. The Gemini view and Gemini provider totals for that revision include exactly those context files, at any depth.
- Without that setting, only `GEMINI.md` is included.
- `AGENTS.md` and `GEMINI.md` components carry the matching `contextFile` label, so the decision does not depend on paths and survives `--shareable`, which replaces folder and file names with aliases.
- A `GEMINI.md` the settings leave out stays labeled Gemini and is counted once in All files.

Strata does not resolve:

- other configured names, which are not stored either;
- settings that do not parse;
- nested `.gemini/settings.json` files;
- user and system settings outside the repository.

`.gemini/system.md` is used only when `GEMINI_SYSTEM_MD` selects it.

### Gemini CLI skills

- Gemini CLI also discovers project skills from `.agents/skills`, and gives them precedence over `.gemini/skills`. Those files are stored once, as shared components read by Codex and Gemini CLI, and by Cursor and Copilot at revisions that track their configuration.
- A skill with the same name in both directories appears twice in the Gemini view, because Strata does not resolve that precedence.
- Gemini CLI also accepts a single `SKILL.md` directly in either skill directory. Strata records it as a Gemini skill rooted at that directory. Other files beside it are grouped by their own subdirectory, as bundles with no manifest, because Strata labels each path on its own and cannot see the manifest next to them.

### Sources

The recognition rules follow current provider documentation:

| Provider           | Documentation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code        | [instructions and rules](https://code.claude.com/docs/en/memory), [skills and commands](https://code.claude.com/docs/en/skills), [subagents and memory](https://code.claude.com/docs/en/sub-agents), [settings](https://code.claude.com/docs/en/settings), [MCP](https://code.claude.com/docs/en/mcp)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Codex              | [instructions](https://learn.chatgpt.com/docs/agent-configuration/agents-md), [skills](https://learn.chatgpt.com/docs/build-skills), [custom agents](https://learn.chatgpt.com/docs/agent-configuration/subagents), [project configuration](https://learn.chatgpt.com/docs/config-file/config-basic), [rules](https://learn.chatgpt.com/docs/agent-configuration/rules)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Gemini CLI         | [context files](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/gemini-md.md), [configuration](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md), [agents](https://github.com/google-gemini/gemini-cli/blob/main/docs/core/subagents.md), [skills](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/using-agent-skills.md), [custom commands](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/custom-commands.md)                                                                                                                                                                                                                                                                                                                                                                                             |
| Cursor             | [rules](https://cursor.com/docs/rules), [legacy `.cursorrules`](https://prod.cursor.com/help/customization/rules), [commands](https://docs.cursor.com/en/agent/chat/commands), [skills](https://cursor.com/docs/context/skills), [ignore files](https://cursor.com/docs/context/ignore-files), [MCP configuration](https://docs.cursor.com/context/model-context-protocol)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| GitHub Copilot     | [repository instructions](https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions), [CLI instructions](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions), [code review](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/request-a-code-review/use-code-review), [custom agents](https://docs.github.com/en/copilot/reference/custom-agents-configuration), [skills](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/add-skills), [hooks](https://docs.github.com/en/copilot/reference/hooks-reference), [CLI MCP servers](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers), [cloud agent environment](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/customize-the-agent-environment) |
| Copilot in VS Code | [instructions](https://code.visualstudio.com/docs/copilot/customization/custom-instructions), [prompt files](https://code.visualstudio.com/docs/copilot/customization/prompt-files), [custom agents](https://code.visualstudio.com/docs/copilot/customization/custom-agents), [MCP servers](https://code.visualstudio.com/docs/copilot/customization/mcp-servers)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

[The Cursor adapter study](next-adapter.md) and [the Copilot adapter study](copilot-adapter.md) record the evidence for each pattern.

## Claude imports

Claude Code expands `@path` imports in the instruction files it loads. The file an import names is loaded with the file that names it, and that file's own imports are expanded in turn, up to four hops from the starting file ([Claude Code memory](https://code.claude.com/docs/en/memory#import-additional-files)). A _hop_ is one import step: a file the starting file imports is one hop away, and a file that file imports is two hops away. Strata resolves imports at each revision against that revision's tracked files, never the working tree.

### Where expansion starts

- Expansion starts at every `CLAUDE.md`, `CLAUDE.local.md`, and `.claude/CLAUDE.md`, at any depth. It does not start at `REVIEW.md`, which Claude Code's Code Review reads but sessions do not load.
- It then starts at every `AGENTS.md` those chains did not reach.
- An `AGENTS.md` that a `CLAUDE.md` imports, the documented way to share it, is one hop on that chain, so its own imports are one hop further on.
- Claude Code also expands imports in an `AGENTS.md` it reads directly. Whether it reads one is a runtime condition Strata does not resolve. So files that only an `AGENTS.md` imports are counted as Claude's, even in a repository whose agents never read them that way.
- Imports in rules, agents, commands, and skills are followed only when an import reaches the file.
- Imports are read from Markdown (`.md`) files only.

### How an import path resolves

- A relative path resolves against the directory of the file that holds the import.
- A home-directory (`~/`) path, an absolute path, or a relative path that climbs above the repository root points outside the repository and is `external`.
- Paths are matched exactly, so a case-insensitive file system that loads `@agents.md` as `AGENTS.md` is not modeled.
- An import of a Git symlink reaches the file the link leads to, as Claude Code reads it. The link's text resolves against the link's directory, and a chain of links is followed for up to four links. A link that points outside the repository, or a chain that is longer or ends at no file, leaves the import `missing`.
  - In history analysis, a link is followed only when every version of it in the analyzed history points to the same place. The import then reaches that file at each revision where the path it names is a symlink. So an import of a file later replaced by a link to its new place resolves before and after the change. Before the link exists, or after it is deleted, the import is `missing` and the linked file is not added. The one approximation: if the linked file is in that revision's inventory anyway, because a path rule recognizes it or another import reaches it, the import is shown as resolved through the link; the totals do not change.
  - `strata diff` follows the links in each of its two trees as they are there.

### What counts as an import

Strata reads an import where Claude Code reads one:

- The `@` is at the start of a line or after whitespace.
- The path runs to the next whitespace. A backslash before a space keeps that space in the path, and a `#` fragment is removed.
- Trailing punctuation is removed: `.`, `,`, `:`, `;`, `!`, `?`, and quotes, and a closing `)`, `]`, or `}` that the path does not open. So `- @styleguides/DOC.md: Pages` names `styleguides/DOC.md`, and `(@a.md, @b.md)` names `b.md`, while `@docs/file(1).md` keeps its bracket. This is Strata's reading: Claude Code does not document how it ends a path.
- The path must start with `./`, `~/`, `/`, or a letter, digit, `.`, `_`, or `-`. A quoted path is not an import.
- Imports inside fenced code blocks, code spans, and HTML comments are skipped. An HTML comment that starts a line is a block that runs to the end of the line that closes it, or to the end of the file. A comment inside a paragraph is inline, and a `<!--` that its paragraph never closes is literal text.
- Strata reads Markdown structure only that far: an indented code block is read as text, and an `@` directly after emphasis or a link bracket is not an import.

### Depth limit and unresolved imports

- Expansion follows the shortest chain to each file.
- A file four hops from a starting file is loaded, but its own imports, external ones included, are `depth-limit`. An external one keeps its `external` flag, so the HTML report and the command line still say it points outside the repository.
- An import of a path where the revision has no tracked regular file is `missing`, unless it is a symlink Strata follows to a file. An import of a submodule or a directory is `missing` too.
- A `missing` import written as a path, with a `/` or ending with `.md`, `.txt`, `.json`, `.yaml`, `.yml`, `.toml`, `.mdc`, or `.rules`, keeps the path it names, even when no file ever had it. An npm scope such as `@mastra/server` reads as an import, so the report lists it as `missing` with a path such as `packages/server/mastra/server`, which shows it is a package name rather than a broken file reference. A bare word that no file has, such as `@alice`, is listed as `missing` without its text.
- An import of a directory does not bring in the files under it. For the repository root, or a path ending in `/`, no history is read at all.
- Imports Claude Code would skip for other reasons, such as an unapproved external import or a non-text file, are not modeled.

### Files an import reaches

A file an import reaches that no path rule above recognizes joins that revision's inventory with `imported: true` and provider `claude`:

- Markdown becomes `instructions`, measured like any instruction file.
- Anything else, such as `package.json`, becomes source-only `other`.

Whether the file is in the inventory follows the imports. When a commit adds or drops an import, the file is listed as added or removed in that commit, even if the file itself did not change. A renamed imported file appears as a removal and an addition.

A file reached by an import that a path rule already recognizes, such as `AGENTS.md` or a rule, keeps its labels and is not counted again. So a recognized source-only Markdown file, such as a skill resource, stays source-only when imported, although Claude Code loads its text.

Imported files are Claude's only. Copilot also reads `CLAUDE.md`, but its documentation does not say it expands `@path` imports, so imported files gain no Copilot reader.

### What the report stores about imports

Each version of an instruction file, or of Markdown an import reaches, stores its `imports`:

- Each import has a 1-based `line` and the repository path it names, as `target`. A repository target named more than once is stored once, at its first line; each external import is kept.
- `target` is null, with `external: true`, for an import outside the repository.
- `target` is kept for an import that names a path no regular file or symlink has anywhere in the analyzed history only when the import is written as a path (a `/` or one of the extensions above), such as a package name like `@mastra/server`. That resolved path is the one piece of the file's text a report holds, and `--shareable` aliases it like any path.
- `target` is null, without `external`, for a bare word that no file or symlink has, such as `ask @alice` or `@john.doe`. Such an import is most likely prose, so its text is not stored.
- `symlinkTarget` is set when `target` is a symlink Strata follows: the path of the file it leads to.
- A report never holds the rest of the import's line.

The links at a revision are derived from the rebuilt inventory by `importLinks` in `src/import-links.ts`, which the HTML report embeds. Each link has:

- its source and target, the target being the file a followed symlink leads to;
- `symlink`, the path the import named, when it resolved through a symlink;
- its hop count;
- its status: `resolved`, `missing`, `external`, or `depth-limit`;
- `external` when it points outside the repository, which a `depth-limit` link can too.

The report lists the links with unresolved imports first, and the command line counts the last revision's unresolved imports. An import is a link between stored files, labeled `links to`, not proof that a session loaded the target.

## Measurements and history

### Token figures

The token figure is a **comparison estimate**: `ceil(UTF-8 byte length / 4)` for each recognized instructional file, that is, its size in bytes divided by four and rounded up, summed across files. The same method is applied to every revision and every provider, so totals stay comparable, and limits use it. It is neither an Anthropic nor an OpenAI tokenizer. There is no option to change it.

Codex's own count, on every run:

- Each instructional file version Codex reads (its own files and shared ones such as `AGENTS.md`) is also counted with OpenAI's `o200k_base` encoding through the local `js-tiktoken@1.0.21` package. Every current OpenAI model uses that encoding.
- These counts are Codex's own totals, labeled `encoding-exact`, beside the estimate; they never replace it.
- Nothing is sent. A Codex file version that is not valid UTF-8 makes Codex's totals use the estimate, and the run says so.

`--precise` is the explicit opt-in for Claude's and Gemini's own counts:

- For each provider, it picks a signed-in provider CLI account, then an API key, then a local exact tokenizer, then the estimate; see [the decision record](decisions.md#measurement).
- It sends only recognized instructional text, to [Anthropic's Messages count endpoint](https://platform.claude.com/docs/en/api/messages/count_tokens), [Gemini's countTokens endpoint](https://ai.google.dev/api/tokens), or Vertex AI's count endpoints.
- It labels returned counts by provider, model, method, implementation/API version, accuracy, credential source, and receiving host.
- Markdown that a Claude import reaches is counted, and sent, as a Claude instruction file.
- A shared instruction file gets a separate count for each selected provider in its `readers`. Counts from different providers are never added together.
- A Gemini context file version is sent to Gemini only when it is present in some revision whose settings make Gemini read it. Its count joins the Gemini total, and appears in the report's Gemini column, only in such revisions.
- API counts exclude the endpoint's one-message wrapper, the tokens the request adds around the text, measured per model. They describe stored text, not actual loaded context or billing.
- `strata diff --precise` uses the same methods for its two commits.

Without `--precise`, no repository content is sent.

### Source-only files and category counts

- Structured configuration, MCP, permission rules, and supporting files are inventoried by source bytes and excluded from instructional token totals.
- MCP files, and Gemini CLI and Codex settings that define MCP servers, also carry the names of the servers they define and whether each runs locally or connects to a URL. They never carry the servers' commands, URLs, or environment; see [MCP servers](decisions.md#mcp-servers).
- Instruction age, how much of the instruction text dates from each earlier period, matches the lines of instructional files only; see [Instruction age](decisions.md#instruction-age).
- Category counts describe stored files, not active skills, loaded rules, or runtime cost.
- Category totals include a `sourceOnlyCount`, so a zero token total is not mistaken for an empty source file.

### Report fields

The report is schema version 20. Each field below first appeared in the version shown. "9 or earlier" marks a field that predates the recorded schema history. [Schema versions](decisions.md#schema-versions) describes each version's change.

| Field                                                                                                | Meaning                                                                                                                                                  | Since version |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `providerTokenCounts` on instructional components, `providerTokenTotals` on revisions                | each provider's own counts, kept apart from the estimate: Codex's on every run, Claude's and Gemini's with `--precise`                                   | 8             |
| `privacy.mode`                                                                                       | `local`, or `shareable` for a report with aliased identifiers                                                                                            | 9 or earlier  |
| `measurement` (`family`, `accuracy`, `encoding`, `model`, `implementation`)                          | how the report's token figures were measured                                                                                                             | 9 or earlier  |
| `skill` (`root`, `role`) on skill components                                                         | the skill directory a file belongs to, and whether it is the manifest or a resource                                                                      | 9 or earlier  |
| top-level `components`, `changes` on revisions                                                       | each distinct file version stored once; each revision stores its totals and what changed from the previous one                                           | 9             |
| `readers`                                                                                            | the providers documented as reading a shared component, or another tool's file that Cursor or Copilot reads in a history that tracks their configuration | 10            |
| `contextFile` on `AGENTS.md` and `GEMINI.md`                                                         | `agents-md` or `gemini-md`, the label Gemini CLI settings are matched against                                                                            | 10            |
| `geminiContextFiles` on revisions                                                                    | the context files the revision's Gemini settings name; absent means `GEMINI.md` only                                                                     | 10            |
| `credential`, `recipient`, `alsoSentTo`, `wrapperTokens`, `fallbacks` on `providerMeasurements`      | how each provider count was obtained and which hosts received text                                                                                       | 11            |
| `submodules`                                                                                         | submodules at the last revision and how many recognized files each holds; omitted when there are none                                                    | 12            |
| `listing` in a skill manifest's `skill`; `skillListingTokens`, `skillListingUnresolved` on revisions | the listed name and description of each skill, and their totals                                                                                          | 13            |
| provider `cursor`; `legacy` on the root `.cursorrules`                                               | Cursor files; the legacy rules file                                                                                                                      | 14            |
| provider `copilot`; `legacy` on a `.chatmode.md`                                                     | Copilot files; the chat mode format custom agents replaced                                                                                               | 15            |
| `imported`, `imports`, `importRoot`                                                                  | files Claude `@path` imports reach, the imports each file holds, and the files expansion starts from                                                     | 16            |
| `upFront` on root instruction files and root rules                                                   | stored text a provider keeps from the start of a session                                                                                                 | 17            |
| `mcp` on MCP files and on settings files that define MCP servers                                     | the names and transports of the servers they define                                                                                                      | 18            |
| top-level `lineAgeMethod`; `lineAge` on revisions that added or removed instruction lines            | how instruction age is matched; instruction age                                                                                                          | 19            |

### Figures that are never added together

- The legacy `estimatedTokens` field stays the default comparison estimate when provider counts are requested. Provider counts are kept separate, and are never combined into a total that mixes counting methods.
- Skill-bundle summaries are derived from the same components already counted by category, and must not be added to category totals.
- A manifest's listing measures the frontmatter `name` and `description` that an agent keeps in context before the skill is used. It is measured separately and mostly repeats text the manifest's count already includes, so it is never added to a total. Its text boundary is defined in [the decision record](decisions.md#skill-listings).
- For each provider, the report also splits its stored text in two: what it keeps from the start of a session at the repository root (root instructions, rules that load at launch, Claude imports, and skill listings), and the rest, which it reads on demand. [The decision record](decisions.md#up-front-context) defines that boundary and the conditions it does not resolve. Both parts are stored text, not loaded context.

### Changes between revisions

- Changes compare adjacent first-parent revisions. A merge is compared with its first parent.
- Git rename detection (`-M`) supports a rename label when Git finds the old and new content similar enough. Otherwise the report shows a removal and an addition.
- The report does not infer a refactor or architecture dependency from paths alone.

The HTML comparison view can compare any two sampled revisions, including a target earlier than the baseline. Its provider, category, and component differences use the stored measurements at each end. A component's identity is its provider, category, and path. So across an arbitrary range, a moved file can appear as a removal and an addition, even when an adjacent revision's `changes` array labels a Git-detected rename.

### What each output contains

- The SVG image contains only the repository and branch names, dates, category labels, and totals. With `--minimal`, it contains only the layer shapes and, in its accessible description, the latest totals.
- The default HTML and JSON contain full commit IDs, dates, paths, provider and category labels, blob IDs, byte sizes, and estimates. They contain no file contents.
- `--precise`, when it finds a credential, sends recognized instruction text to the named services during analysis. `--shareable` changes report identifiers but does not change that transfer.
- `--shareable` replaces the repository and branch names, commit IDs, MCP server names, and blob IDs with deterministic aliases, local to that report. In paths (including import targets, skill roots, and submodule paths) it aliases each folder name and file stem and keeps tool convention names and file extensions, so the folder tree stays. It keeps dates and measurements. These values can still reveal the shape and timing of a project, so inspect reports before sharing them.
- Use `--output` to choose where the report is written. Strata does not write to the repository it analyzes unless that path is chosen explicitly.
