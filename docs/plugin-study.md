# Agent plugin study

Studied 2026-11-21 from each tool's current documentation. Implemented for Claude Code, Codex, GitHub Copilot, Cursor, and Gemini CLI in report schema version 23.

## What Strata can say

A plugin has separate states, and a repository can show any of them:

- **Defined:** a manifest and its files are in Git. This does nothing by itself.
- **Listed:** a marketplace file in Git offers it. Strata keeps the file's name and how many plugins it lists, not each entry.
- **Enabled, turned off, or configured:** a settings file says so. Claude's settings schema also allows a list of strings as a value, which its documentation does not explain, so Strata labels it `configured`. A setting does not always install it, and its content may be outside Git.
- **Loaded:** a session actually uses it. This depends on what each person installed and trusted, so Git cannot show it.

Strata reports the first three, with the file that says so. It does not fetch a plugin or estimate what one outside Git adds, and it never adds plugin text to up-front context. All these files are source-only. A file that does not parse, or whose plugin fields do not have the documented shape, is `unresolved` rather than empty.

## What each tool documents

| Tool        | Manifest                                                                         | Marketplace in a repository                                                  | A repository can enable a plugin                                                            |
| ----------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Claude Code | `.claude-plugin/plugin.json`                                                     | `.claude-plugin/marketplace.json`                                            | Yes: `enabledPlugins` in `.claude/settings.json`                                            |
| Copilot     | Agent Plugins `plugin.json`, `.plugin/`, `.github/plugin/`, or `.claude-plugin/` | Root `marketplace.json`, `.plugin/`, `.github/plugin/`, or `.claude-plugin/` | Yes: `enabledPlugins` in `.github/copilot/settings.json` or `.claude/settings[.local].json` |
| Codex       | Agent Plugins `plugin.json`, or `.codex-plugin/plugin.json`                      | `.agents/plugins/marketplace.json` or `.claude-plugin/marketplace.json`      | Yes: `[plugins."<plugin>@<marketplace>"]` with `enabled` in `.codex/config.toml`            |
| Cursor      | Agent Plugins `plugin.json`, or `.cursor-plugin/plugin.json`                     | `.cursor-plugin/marketplace.json`                                            | Not documented                                                                              |
| Gemini CLI  | `gemini-extension.json`                                                          | None documented                                                              | Not documented; extensions install per user                                                 |

Sources: [Claude Code manifest](https://code.claude.com/docs/en/plugins/manifest-reference), [marketplace](https://code.claude.com/docs/en/plugins/marketplace-reference), [loading](https://code.claude.com/docs/en/plugins/loading), and [settings](https://code.claude.com/docs/en/settings-reference#enabledplugins); [Copilot CLI plugins](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference) and [configuration](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference); [VS Code agent plugins](https://code.visualstudio.com/docs/agents/reference/agent-plugin-reference); [Codex plugins](https://developers.openai.com/codex/plugins/build); [Cursor plugins](https://cursor.com/docs/reference/plugins); [Gemini CLI extensions](https://geminicli.com/docs/extensions/reference/).

## Decisions

- **Common file names are confirmed from their content.** `plugin.json` is used by many unrelated projects. Strata tracks one outside a tool's folder only when it declares the [Agent Plugins](https://agent-plugins.org) `$schema`, which Copilot, Codex, and Cursor share. A root `marketplace.json` needs the required `name`, `owner`, and `plugins`. Copilot's legacy bare `plugin.json` has no such mark, so Strata leaves it out.
- **A package does not show the repository uses a tool.** A repository can publish a Cursor plugin without using Cursor. Plugin manifests and marketplace files therefore do not turn on the Cursor or Copilot view of files those tools read for compatibility.
- **Shared formats keep their readers.** An Agent Plugins manifest is labeled `shared`, for Codex, Copilot, and Cursor. Claude's `.claude-plugin/` files are also read by Copilot, and the root `.claude/settings.json` and `.claude/settings.local.json` give Copilot its plugin settings. Codex also reads `.claude-plugin/marketplace.json`, but it is not listed as a reader, because Codex is not a conditional reader and would then appear in every repository that publishes a Claude marketplace.
- **A Claude skill folder is special.** A manifest under the root `.claude/skills/<name>/` loads without an `enabledPlugins` entry, after the folder trust check, unless `defaultEnabled` is `false`. Its ID is `<name>@skills-dir`.
- **Marketplaces are counted, not listed.** A source is `local` when it is a relative path inside the repository, including Codex's `{ "source": "local", "path": ... }` and Cursor's `{ "path": ... }`, and `external` otherwise. Source values are never stored. Storing each entry would add almost a million references to the report of the official Claude marketplace.
- **Files inside a plugin are not the repository's context.** A tool namespaces and loads them only once the plugin is enabled and installed. Measuring the text of plugins defined in a repository is a separate step.
