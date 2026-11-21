# Agent plugin study

Studied 2026-11-21 from each tool's current documentation. Claude Code's plugin references are implemented in report schema version 23. The other tools are not implemented yet; this page keeps the evidence for them.

## What Strata can say

A plugin has separate states, and a repository can show any of them:

- **Defined:** a manifest and its files are in Git. This does nothing by itself.
- **Listed:** a marketplace file in Git offers it. Strata keeps the file's name and how many plugins it lists, not each entry.
- **Enabled or turned off:** a settings file says so. This does not install it, and its content may be outside Git.
- **Loaded:** a session actually uses it. This depends on what each person installed and trusted, so Git cannot show it.

Strata reports the first three, with the file that says so. It does not fetch a plugin or estimate what one outside Git adds, and it never adds plugin text to up-front context.

## Claude Code

Sources: [manifest](https://code.claude.com/docs/en/plugins/manifest-reference), [marketplace](https://code.claude.com/docs/en/plugins/marketplace-reference), [loading](https://code.claude.com/docs/en/plugins/loading), [settings](https://code.claude.com/docs/en/settings-reference#enabledplugins).

| Tracked path                                       | What Strata keeps                                                                  | Evidence and boundary                                                                                                                                                                                                                                             |
| -------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `**/.claude-plugin/plugin.json`                    | Its `name`, as `defined`                                                           | `name` is the only required field. The manifest alone enables nothing.                                                                                                                                                                                            |
| `.claude/skills/<name>/.claude-plugin/plugin.json` | `<name>@skills-dir`, as `skills-folder`, or `defined` with `defaultEnabled: false` | Claude Code loads a plugin saved here without an `enabledPlugins` entry, after the folder trust check.                                                                                                                                                            |
| `**/.claude-plugin/marketplace.json`               | Its name, as `catalog`, with counts of `local` and `external` plugins              | A relative path is `local`. A `github`, `url`, `git-subdir`, `npm`, `archive`, or `command` source is `external`. Sources are never stored, and entries are counted because the official marketplace would otherwise add almost a million references to a report. |
| `**/.claude/settings[.local].json`                 | `enabledPlugins` as `enabled` or `disabled`; `extraKnownMarketplaces` names        | Project settings turn a plugin on for collaborators but do not install it.                                                                                                                                                                                        |

All of these stay source-only. A file that does not parse, or whose plugin fields do not have the documented shape, is `unresolved` rather than empty.

Files inside a plugin, such as `plugins/fmt/skills/lint/SKILL.md`, are not counted as the repository's own context. Claude Code namespaces them as `<plugin>:<name>`, lists a skill's name and description at session start, and loads its body on use, but only once the plugin is enabled and installed. Measuring the text of plugins defined in the repository is a separate step.

## The other tools

| Tool       | Manifest                                                                | Marketplace in a repository                                             | A repository can enable a plugin                                                    |
| ---------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Copilot    | root `plugin.json`, `.plugin/`, `.github/plugin/`, or `.claude-plugin/` | `marketplace.json` in those places; `.github/plugin/` recommended       | Yes: `enabledPlugins` in `.github/copilot/settings.json` or `.claude/settings.json` |
| Codex      | root `plugin.json`, or `.codex-plugin/plugin.json`                      | `.agents/plugins/marketplace.json` or `.claude-plugin/marketplace.json` | Yes: `[plugins."<plugin>@<marketplace>"]` with `enabled` in `.codex/config.toml`    |
| Cursor     | `.cursor-plugin/plugin.json`, or root `plugin.json`                     | `.cursor-plugin/marketplace.json`                                       | Not documented                                                                      |
| Gemini CLI | `gemini-extension.json`                                                 | None documented                                                         | Not documented; extensions install per user                                         |

Sources: [Copilot CLI plugins](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference), [Copilot configuration](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference), [VS Code agent plugins](https://code.visualstudio.com/docs/agents/reference/agent-plugin-reference), [Codex plugins](https://developers.openai.com/codex/plugins/build), [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference), [Cursor plugins](https://cursor.com/docs/reference/plugins), [Gemini CLI extensions](https://geminicli.com/docs/extensions/reference/).

A bare root `plugin.json` is ambiguous across tools and is a common file name, so a later adapter must not treat one as a plugin from its path alone. Copilot and Codex also read `.claude-plugin/` files. Strata labels those files Claude's until their adapters add these readers.

Suggested order: Copilot and Codex, because a repository can enable plugins for them, then Cursor and Gemini CLI, which can only show defined plugins.
