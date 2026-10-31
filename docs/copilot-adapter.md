# GitHub Copilot repository configuration

Implemented in report schema version 15. [The analysis scope](analysis-scope.md) lists these patterns as recognized; this page keeps the evidence behind them.

- Studied 2026-10-17.
- Open questions checked 2026-10-18 against VS Code 1.142.0 source, the Copilot CLI 1.0.98 changelog, and the GitHub Docs source.

GitHub Copilot is several clients, not one agent. This page calls each client a _surface_:

- Copilot Chat on GitHub.com
- the cloud agent (formerly the coding agent)
- code review
- Copilot CLI
- Copilot Chat in VS Code, Visual Studio, JetBrains, Eclipse, and Xcode

Each surface reads a different subset of the same tracked files. GitHub's [support matrix](https://docs.github.com/en/copilot/reference/custom-instructions-support) is the authority for which surface reads which instruction type.

The adapter adds provider `copilot`. A Copilot label means "documented as read by at least one Copilot surface". It never means that a given session loaded the file.

Copilot also reads files that Strata already assigns to other providers: `AGENTS.md`, `CLAUDE.md`, `REVIEW.md`, `GEMINI.md`, `.claude/agents`, `.claude/rules`, `.claude/skills`, `.agents/skills`, and `.mcp.json`. Each of those stays one component, counted once, as `AGENTS.md` already is for Cursor.

## Terms used on this page

- **Provider**: the tool a file belongs to, such as `claude`, `gemini`, or `copilot`. `shared` marks a file that several tools own equally.
- **Category**: the kind of configuration a file is, such as `instructions`, `rules`, `commands`, `agents`, `skills`, `settings`, `tools`, or `other`.
- **Component**: one tracked file in the report, counted once.
- **Stored instructional text**: prose an agent may read. Strata gives it a token estimate.
- **Source bytes only** (source-only): Strata records the file's size but gives it no token count, because it is structured configuration, a supporting resource, or a file the tool does not read as prompt text.
- **Readers**: the providers documented as reading a file. A file can list readers besides its own provider.
- **Listing**: a skill's frontmatter `name` and `description`, which an agent keeps in context before it uses the skill. Strata measures it separately.
- **Frontmatter**: the YAML block between `---` lines at the top of a Markdown file.
- **Legacy**: a format the tool still reads but documents as replaced.

## Copilot-owned paths

`**/` means the path is recognized at any depth, not only at the repository root.

| Tracked path                                                           | Classification                                                                                         |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `**/.github/copilot-instructions.md`                                   | Copilot / instructions / stored instructional text                                                     |
| `**/.github/instructions/**/*.instructions.md`                         | Copilot / rules / stored instructional text                                                            |
| `**/.github/prompts/*.prompt.md`                                       | Copilot / commands / stored instructional text                                                         |
| `**/.github/agents/**/*.md`, except `README.md`                        | Copilot / agents / stored instructional text                                                           |
| `.chatmode.md` files                                                   | inside `.github/agents`: Copilot / agents, `legacy: true`; in `.github/chatmodes`: source-only `other` |
| `.github/skills/<name>/SKILL.md`                                       | Copilot / skills / stored instructional text, plus listing                                             |
| Other files under `.github/skills/<name>/`                             | Copilot / skills / source bytes only                                                                   |
| `**/REVIEW.md`                                                         | Claude / instructions, with Copilot as a conditional reader                                            |
| `.github/hooks/*.json` at the root                                     | Copilot / settings / source bytes only                                                                 |
| `.github/copilot/settings.json`, `.github/copilot/settings.local.json` | Copilot / settings / source bytes only                                                                 |
| `**/.github/mcp.json`                                                  | Copilot / tools / source bytes only                                                                    |
| `.vscode/mcp.json`                                                     | Copilot / tools / source bytes only                                                                    |
| `.github/workflows/copilot-setup-steps.yml`                            | Copilot / settings / source bytes only                                                                 |
| `.github/workflows/copilot-code-review.yml`                            | Copilot / settings / source bytes only                                                                 |

The evidence and limits for each row follow.

### Repository instructions: `copilot-instructions.md`

- [Repository instructions](https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions): one repository-wide file in the root `.github` directory, with no frontmatter, applied to every request in the repository.
- Every surface in the support matrix reads it except Eclipse code review.
- GitHub.com reads the root file. [Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions) also reads it in the working directory and in the directories between it and the root. So a nested project's file is recognized too.

### Path-specific instructions: `*.instructions.md`

- Source: the same [repository instructions](https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions) page. Files can sit at any depth under `.github/instructions`, and the name must end in `.instructions.md`.
- Frontmatter `applyTo` takes comma-separated globs relative to the repository root (`*` matches within one directory, `**` matches any depth).
- `excludeAgent: "code-review"` or `"cloud-agent"` hides a file from that surface.
- GitHub.com Chat does not read these files.
- [VS Code](https://code.visualstudio.com/docs/copilot/customization/custom-instructions) also loads a file on demand when its `description` matches the task. A file with neither `description` nor `applyTo` is used only when attached manually.
- VS Code [searches subfolders up to five levels deep](https://github.com/microsoft/vscode/blob/1.142.0/src/vs/workbench/contrib/chat/common/promptSyntax/utils/promptFilesLocator.ts). Deeper files are still recognized, since the CLI documents no limit.
- These files apply only under conditions, like Claude rules, so the category is `rules`, not `instructions`.
- Do not interpret `applyTo` or `excludeAgent`.
- Copilot ignores other `.md` files in that folder. They are `other`, source only.

### Prompt files: `*.prompt.md`

- [VS Code prompt files](https://code.visualstudio.com/docs/copilot/customization/prompt-files): Markdown files ending in `.prompt.md`. The user runs one manually with `/name`, the Command Palette, or the editor play button. They are "supported only in Local harness sessions".
- Because they run only on request, their size is not a cost paid in every session.
- VS Code [reads only files directly in the folder](https://github.com/microsoft/vscode/blob/1.142.0/src/vs/workbench/contrib/chat/common/promptSyntax/utils/promptFilesLocator.ts). Its subfolder search applies to instruction files alone, so only direct children are recognized.
- Copilot CLI and GitHub.com do not document prompt files.

### Custom agents: `.github/agents`

- [Cloud agent custom agents](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/create-custom-agents) live in `.github/agents` and use the `.agent.md` extension.
- The [configuration reference](https://docs.github.com/en/copilot/reference/custom-agents-configuration):
  - names an agent from its file name "minus `.md` or `.agent.md`";
  - requires `description`;
  - lets `target` (`vscode` or `github-copilot`) restrict the surface;
  - limits the prompt body to 30,000 characters.
- VS Code [treats any `.md` file directly in `.github/agents` as an agent, except `README.md`](https://github.com/microsoft/vscode/blob/1.142.0/src/vs/workbench/contrib/chat/common/promptSyntax/config/promptFileLocations.ts), and does not search its subfolders.
- Copilot CLI [discovers agents recursively in subdirectories (1.0.55) and in nested `.github/agents` directories between the working directory and the repository root (1.0.62)](https://github.com/github/copilot-cli/blob/main/changelog.md).
- The recognized pattern is the union of these. GitHub.com's cloud agent does not document subfolders; the label allows that, because it claims only that some surface reads the file.
- `README.md` stays source-only `other`, because VS Code skips it and the CLI's handling is undocumented.
- Frontmatter (`tools`, `model`, `mcp-servers`, `handoffs`, `hooks`) is stored text and is not interpreted.

### Chat modes: `.chatmode.md`

- Custom agents "were previously known as custom chat modes".
- VS Code still [parses `.chatmode.md` as an agent file](https://github.com/microsoft/vscode/blob/1.142.0/src/vs/workbench/contrib/chat/common/promptSyntax/config/promptFileLocations.ts), but its default agent folders are `.github/agents` and `.claude/agents` only.
- The deprecated `chat.modeFilesLocations` setting still declares `.github/chatmodes` as its default. The file locator no longer reads that setting, and VS Code offers to migrate those files.
- So a `.chatmode.md` in `.github/agents` is still read. It is labeled legacy, as `.cursorrules` is.
- A `.chatmode.md` left in `.github/chatmodes` is read only when a user adds that folder to `chat.agentFilesLocations`, a setting outside the repository. It stays visible as source-only `other`.

### Skills: `.github/skills`

- [Copilot skills](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/add-skills): one directory per skill, holding a `SKILL.md` with required `name` and `description` frontmatter.
- Used by the cloud agent, code review, CLI, and VS Code and JetBrains agent mode.
- Copilot picks a skill "based on your prompt and the skill's description" and then injects `SKILL.md`, so Strata's existing listing measurement applies.
- Other files in the skill directory: the same page says Copilot "automatically discovers all of the files in the skill's directory". They follow the same rule as other skill resources: source bytes only.
- Copilot CLI also [discovers skills recursively and supports namespaced skills](https://github.com/github/copilot-cli/blob/main/changelog.md), so `.github/skills/<group>/<name>/SKILL.md` can be a skill. The study left open whether the existing skill-root rule groups such a bundle by its manifest's directory rather than by `<group>`; [Coverage](#coverage) records the outcome.

### Code review instructions: `REVIEW.md`

- [Copilot code review](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/request-a-code-review/use-code-review) "also reads custom instructions from `CLAUDE.md`, `GEMINI.md`, and `REVIEW.md` files in your repository", taken from the pull request's head branch.
- The [changelog that added it](https://github.blog/changelog/2026-07-17-copilot-code-review-customization-and-configurability-improvements/) describes them as files teams "already maintain" for other tools.
- [Claude Code's Code Review](https://code.claude.com/docs/en/code-review-customize) owns the convention: a root file, plus subfolder files that add checks for changes under them, read from the base or default branch.
- So `REVIEW.md` is labeled Claude at any depth, with `readers` `["claude", "copilot"]`. On its own it does not mark a repository as using Copilot.

### Hooks and CLI settings

- `.github/hooks/*.json`: the [hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference) describes JSON with `version: 1` and a `hooks` object, loaded by the cloud agent and CLI.
- Hook commands are not prompt text. Strata has no `hooks` category, and Claude hooks also count as `settings`, so these do too.
- `.github/copilot/settings.json` and `settings.local.json`: the same page says Copilot CLI reads inline `hooks` and `disableAllHooks` there; the cloud agent does not.
- The local file is usually ignored by Git, so it is rarely tracked.

### MCP configuration

MCP (Model Context Protocol) files declare tool servers an agent can call.

- `**/.github/mcp.json`: [CLI MCP servers](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers) describes it as shared, committed project configuration. The CLI loads project servers only after the user trusts the folder, from every directory between the working directory and the root.
- `.vscode/mcp.json`: [VS Code MCP servers](https://code.visualstudio.com/docs/copilot/customization/mcp-servers) describes workspace configuration with a top-level `servers` object. Copilot CLI does not read it.
- Other `.vscode/` files are editor settings and are not recognized.

### Environment workflows

- `copilot-setup-steps.yml`: the [cloud agent environment](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/customize-the-agent-environment) page describes a workflow with a single `copilot-setup-steps` job, run before the agent starts, only from the default branch. It configures the agent's environment, not its prompt.
- `copilot-code-review.yml`: per the [code review environment](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/request-a-code-review/use-code-review#customizing-copilot-code-reviews-environment) section, code review uses this file when present, "instead of `copilot-setup-steps.yml`", which it otherwise reuses. Added in the [2026-07-17 changelog](https://github.blog/changelog/2026-07-17-copilot-code-review-customization-and-configurability-improvements/).
- Other workflows stay unrecognized.

## Files Strata already recognizes

These files belong to other providers. Copilot is added as a reader where its documentation says it reads them.

| Tracked path                                                                | Label before Copilot                      | What changed                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `**/AGENTS.md`                                                              | shared, readers Claude, Codex, Cursor     | `copilot` added to `readers`. "Nearest wins" is not resolved.                                                                                                                                                                          |
| Root `CLAUDE.md`, `.claude/CLAUDE.md`, root `GEMINI.md`                     | Claude; Gemini CLI                        | Owner unchanged. `readers` `["claude", "copilot"]` on `**/CLAUDE.md` (including `.claude/CLAUDE.md`) and `["copilot", "gemini"]` on `**/GEMINI.md`, the depth the CLI reads. `CLAUDE.local.md`, which GitHub does not list, gets none. |
| `.claude/skills/<name>/`, `.agents/skills/<name>/`                          | Claude; shared, readers Codex, Gemini CLI | `copilot` added to the readers of both.                                                                                                                                                                                                |
| Root `.mcp.json`                                                            | Claude / tools                            | `readers` `["claude", "copilot"]`. Nested `.mcp.json` files stay unrecognized.                                                                                                                                                         |
| `.claude/rules/**/*.md`, `.claude/agents/**/*.md`, `.claude/settings*.json` | Claude                                    | `.claude/agents` and `.claude/rules` get `readers` `["claude", "copilot"]`, except a `README.md`, which VS Code skips. `.claude/settings*.json` stays Claude-only, because Copilot reads only its `hooks` field.                       |

The Copilot evidence for each row:

- **`AGENTS.md`.** GitHub says the file may be anywhere and "the nearest `AGENTS.md` file in the directory tree will take precedence". Readers:
  - the cloud agent;
  - code review (root file);
  - the CLI (repository root, working directory, the directories between them, and those on the path to an edited file);
  - VS Code Chat, which reads nested files only with the experimental `chat.useNestedAgentsMdFiles` setting, off by default.
- **`CLAUDE.md` and `GEMINI.md`.** GitHub accepts one root `CLAUDE.md` or `GEMINI.md` as an alternative to `AGENTS.md`, read by the cloud agent, code review, and CLI. The [CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions) reads both at its standard locations, and `.claude/CLAUDE.md` too. VS Code reads `CLAUDE.md` and `.claude/CLAUDE.md` when `chat.useClaudeMdFile` is on.
- **Skills.** The Copilot skills docs list `.github/skills`, `.claude/skills`, and `.agents/skills`.
- **`.mcp.json`.** The CLI reads `.mcp.json` in every directory from the working directory up to the root, ahead of `.github/mcp.json`. VS Code reads the root file.
- **`.claude/` rules, agents, and settings.** VS Code reads `.claude/rules` (any depth, except `README.md`) and `.claude/agents` (direct children) in Claude's format, and [reads hooks from `.claude/settings*.json`](https://github.com/microsoft/vscode/blob/1.142.0/src/vs/workbench/contrib/chat/common/promptSyntax/config/promptFileLocations.ts). VS Code reads both folders by default. The CLI reads hooks from `.claude/settings*.json` and agents from nested `.claude/agents`, including subfolders.

## Decision: Copilot is a conditional reader, like Cursor

Copilot documents reading files labeled `claude` or `gemini`. Two simple options both fail:

- Relabeling those files `shared` would move tokens out of the Claude and Gemini CLI totals in every repository.
- Leaving Copilot out would make the Copilot view miss the instructions many repositories give it.

The Cursor adapter had already met this problem with `.claude/skills`. Its answer: the owner keeps its label, the file lists the other tool in `readers`, and that tool reads it only at a revision that tracks the tool's own configuration.

Copilot, like Cursor, needs no repository file, so it uses the same rule, applied separately from Cursor:

- `providerReads` counts a borrowed file for Copilot only at a revision with at least one `copilot` component.
- A history with no `copilot` component drops `copilot` from every `readers`. A repository that does not track Copilot files is reported exactly as before.

The cost is the same as for Cursor: a team using Copilot with only `AGENTS.md` or `CLAUDE.md` is not detected.

## Boundaries

- **Label no surface.** Which client read which file (Chat, cloud agent, code review, CLI, IDE) depends on the user, not the repository. The report must not say "code review read this".
- **Do not interpret** `applyTo`, `excludeAgent`, `target`, `description`, or `.claude/rules` `paths`. They are stored text. Whether they matched a session's files is runtime evidence.
- **Do not resolve precedence** between files:
  - the nearest `AGENTS.md`;
  - the `CLAUDE.md`/`GEMINI.md` alternative;
  - `.mcp.json` over `.github/mcp.json`;
  - repository-level agents overriding organization-level ones.
- **Out of scope**, because it lives outside the repository:
  - organization and enterprise configuration (`agents/*.agent.md` in a `.github` or `.github-private` repository);
  - personal instructions and `~/.copilot/`;
  - settings stored in GitHub, such as code review's "Use custom instructions" toggle and cloud agent MCP configuration in repository settings.
- **`@path` references.** The CLI expands them in `copilot-instructions.md`, `AGENTS.md`, and `CLAUDE.md`, but not in `GEMINI.md` or `*.instructions.md`. Do not add their contents or draw edges without resolving them.
- **No size limit.** GitHub sets no size limit for instruction files. Code review used to stop reading `copilot-instructions.md` and `*.instructions.md` at 4,000 characters; [that limit was removed on 2026-06-12](https://github.blog/changelog/2026-06-12-copilot-code-review-new-configurations-and-controls/). Do not truncate. A report of an older revision measures the stored file, not what code review read at the time.
- **No exact count.** There is no Copilot token count endpoint. Under `--precise`, Copilot files keep the report's default measurement, as Cursor's do.

## Coverage

The synthetic history in `test/copilot-adapter.test.mjs` runs through these phases:

1. It starts with Claude, Codex, and Gemini CLI files and ordinary `.github` files (a CI workflow, an issue template, a pull request template), and asserts that the report never mentions Copilot.
2. It then adds:
   - root and nested `copilot-instructions.md`;
   - a nested `.instructions.md` with `applyTo`, and a `README.md` beside it;
   - a prompt file, and one in a subfolder (source-only);
   - an `.agent.md`, a plain `.md` agent in a subfolder, an agents `README.md`, a `.chatmode.md` in `.github/agents` (legacy), and another in `.github/chatmodes` (source-only);
   - a skill with a resource, an unlistable skill, a loose `SKILL.md`, and a namespaced skill;
   - `REVIEW.md` at the root and in `docs/` (Claude, read by Copilot);
   - a `.claude/rules/README.md` (no Copilot reader);
   - a Cursor rule that outlives the Copilot files;
   - hooks, CLI settings, both MCP files, and both environment workflows.
3. It then migrates the chat mode by rename and removes Copilot.

It checks the readers, the per-revision Copilot view in Node and in the HTML report, listings, `strata diff`, shareable redaction, and that `--precise` sends no Copilot text. `test/provider-view.test.mjs` checks that Copilot's and Cursor's conditions are independent.

Copilot CLI's namespaced skills (`.github/skills/<group>/<name>/SKILL.md`) are grouped under `<group>` as source-only resources and are not listed. A path rule cannot see whether a sibling manifest exists. Supporting them needs a skill root chosen from the manifests present at each revision.
