# Using Strata

This page covers the CLI's output options, how to read the HTML report, and the shape of the JSON. For the short version, see the [README](../README.md).

Strata reads a repository's Git history and writes a local report of how its agent configuration changed over time. A few terms used on this page:

- **First-parent history:** the chain of commits you get by following each commit's first parent back from the branch tip. It includes merge commits but skips the commits that came in only through a merge's other parent. Strata follows this history.
- **Blob:** a file version as Git stores it. Strata reads tracked blobs only. It never looks at the repository's working tree, and, without `--precise`, it sends no content anywhere.
- **Stored-text tokens:** the token measurement Strata gives instruction files. The report names the method used.
- **Source-only:** structured configuration and supporting resources, measured in source bytes instead of tokens.

These measurements do not show what an agent loaded in a session. Reports include paths and measurements, never file contents.

## Analyze a repository

```sh
strata analyze /path/to/git/repository
```

The repository argument defaults to the current directory. By default, Strata writes the report to a private temporary directory and prints its path.

| Option                     | What it does                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------ |
| `--output <file>` (`-o`)   | Write the report to this file. `--output -` writes it to standard output, for another program to read. |
| `--format <format>` (`-f`) | `html` (default), `json` for machine-readable output, `svg` for an image, or `badge`.                  |
| `--open`                   | Open the HTML report or SVG image with the default application.                                        |
| `--quiet` (`-q`)           | Print only the report path, with no progress or summary.                                               |

With `--output -`, the summary joins the progress on standard error, and `--quiet` silences both. Progress appears only once a run has taken more than two seconds: one line updated in place on a terminal, or a line per tenth of the history in a log such as CI's.

The summary's `At session start:` line gives each agent's up-front and on-demand tokens. When an agent skips a root `AGENTS.md` by default (Claude Code beside a root Claude file, Codex beside a non-empty `AGENTS.override.md`), the line adds the tokens it skips. When no revision has a recognized file, the summary names the main paths Strata looks for and links to [the analysis scope](analysis-scope.md).

```sh
strata analyze /path/to/repository --open
strata analyze /path/to/repository --format json --output report.json
strata analyze --format json --output - | jq '.revisions[] | [.date, .estimatedTokens]'
```

### An image for a README

For a picture of the history to put in a README, use `--format svg`. The image shows stored-text tokens per category through time, with the latest totals. It contains the repository and branch names, dates, and totals, but no paths, commit IDs, or file contents. `--shareable` also replaces the repository and branch names.

```sh
strata analyze /path/to/repository --format svg --output docs/strata.svg
```

![The full image: header, latest totals, layered chart with axis, legend, and measurement note](images/strata.svg)

Add `--minimal` to draw only the layers, edge to edge on a transparent background, with no text, axes, or legend. That image carries no repository or branch name and no dates.

```sh
strata analyze /path/to/repository --format svg --minimal --output docs/strata-minimal.svg
```

![The minimal image: the category layers alone, with no text or axes](images/strata-minimal.svg)

Both images are Strata's own repository.

Then reference the image from the README as `![Agent context through time](docs/strata.svg)`. To keep it current without committing it by hand, see [Running Strata in CI](ci.md#readme-image).

### A badge

For a badge instead of a chart, `--format badge` writes the latest total as [shields.io endpoint JSON](https://shields.io/badges/endpoint-badge). The badge reads `agent context | ≈1,151 tokens`. The `≈` marks the estimate. The badge names nothing from the repository.

Publish the file somewhere public and point shields.io at it:

```sh
strata analyze /path/to/repository --format badge --output strata-badge.json
```

```markdown
![Agent context](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/<owner>/<repository>/<branch>/strata-badge.json)
```

Shields' `label`, `color`, and `style` query parameters change its look. [Running Strata in CI](ci.md#readme-image) publishes the badge next to the image.

### Exit status

| Status | Meaning                                                        |
| ------ | -------------------------------------------------------------- |
| 0      | Success                                                        |
| 1      | Any other failure, such as a path that is not a Git repository |
| 2      | The command line is invalid                                    |
| 3      | A [limit](#limits) you set was passed                          |

## Compare two commits

`diff` compares two commits. Each can be any Git revision that names a commit, such as a commit ID, a short ID, a branch, a tag, or `HEAD~10`; the output names both by full commit ID. A revision that names no commit, or one a shallow clone lacks, is an error. It reads both revisions directly from Git and prints a Markdown summary by default. When no tracked file changed, the summary says so instead of printing empty tables.

- `--format json` gives structured data instead.
- `--output` saves the result to a file.
- `--json-output <file>` also writes the JSON from the same comparison to a second file. One run then gives both formats, without counting twice under `--precise`.

```sh
strata diff /path/to/repository --base <base-commit> --head <head-commit>
strata diff /path/to/repository --base <base-commit> --head <head-commit> --format json --output delta.json
```

Besides the token and file changes, the summary can include:

- **Listed skill tokens**, when either commit has a skill manifest (a skill's `SKILL.md`). These are the frontmatter name and description an agent keeps in context before a skill is used. The summary gives the total change and, for each changed manifest, its own change.
- **MCP servers**, when either commit has an MCP file: a line names the servers the change adds or removes.
- **Up-front and on-demand text**, in a table with one row per agent whose figures changed. For a session started at the repository root, it gives the stored text the agent keeps up front (root instructions, rules that load at launch, Claude imports, and skill names and descriptions) and the rest, which it reads on demand.

### Limits

Both commands can check token limits you choose. None is set by default, and Strata never treats growth as a failure on its own: a limit says only that a figure passed the number you gave it. Every limit is a whole number of tokens.

| Flag                                    | Checks                                                                                         | Commands          |
| --------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------- |
| `--limit-tokens <n>`                    | Stored instructional text at the head, or at the latest revision                               | `diff`, `analyze` |
| `--limit-increase <n>`                  | Its growth from base to head                                                                   | `diff`            |
| `--limit-up-front-tokens [agent=]<n>`   | What each agent keeps at session start (see [up-front context](decisions.md#up-front-context)) | `diff`, `analyze` |
| `--limit-up-front-increase [agent=]<n>` | Its growth from base to head                                                                   | `diff`            |

Limits use the byte estimate, never the provider counts (Codex's, or those from `--precise`). The percentage change is shown beside each increase, but it is never a limit.

#### Limits for one agent

A session-start limit without an agent applies to every agent that keeps text at session start. To set one agent's limit, repeat the flag with `claude=`, `codex=`, `copilot=`, `cursor=`, or `gemini=`. That limit then replaces the general one for that agent.

If no agent is left for the general limit, for example because no agent keeps text at session start, the run says the limit was not applied.


```sh
strata diff --base <base-commit> --head <head-commit> --limit-increase 500 --limit-up-front-tokens claude=8000
strata analyze --limit-up-front-tokens 8000 --format json --output report.json
```

#### What a run prints and returns

- Each limit passed prints an `Over limit:` line on standard error. Each limit not applied prints a `Limit not applied:` line. Both appear even with `--quiet`.
- A run with a limit passed exits with status 3. It still writes its output first, and exits before `--open` opens it.
- `--on-limit warn` keeps the lines but exits with 0.
- `--limit-annotations` also prints each line as a GitHub Actions annotation: an error for a limit passed (a warning under `--on-limit warn`), and a warning for a limit not applied.
- `--precise --dry-run` checks limits too, since they use the local measurement it has already taken.
- `strata diff` also puts a table of every limit and its result at the top of the Markdown, and in the JSON's `limits`.

For pull requests, the opt-in [composite Action](pr-action.md) runs the same comparison and writes the delta to the job summary. It reads Git blobs without checking out either revision, and it posts no comment. To publish the full history report or a README image from CI, see [Running Strata in CI](ci.md).

## Token measurement

Strata measures instructional text in two ways, with no option to choose:

| Figure                                                                       | Method                                                                                   |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Every total, chart, comparison, and limit                                    | The text's UTF-8 byte length divided by four                                             |
| Codex's own totals, in the report's Codex view and the `diff` provider table | OpenAI's `o200k_base` encoding, the one every current OpenAI model uses, counted offline |

`--precise` adds Claude's and Gemini's own totals in the same way. Provider totals stay separate and are never added to the estimate. Neither method measures loaded context, message framing, or billing. See [the tokenizer study](tokenizers.md) for details and limits.

### Precise counts

`strata analyze --precise` counts each provider's instructions with the most precise method it can find. It needs no other flag. It tries these methods in order:

1. **A signed-in account.** For Claude, an `ant auth login` profile from the Anthropic CLI, or, with neither that nor `ANTHROPIC_API_KEY`, a ready `gcloud` account on Vertex AI with Claude enabled. For Gemini, a `gcloud` account with a project set (`gcloud config set project`, or `GOOGLE_CLOUD_PROJECT`), counted through Vertex AI in `GOOGLE_CLOUD_LOCATION` (default `global`). See [signing in](#signing-in-for-precise-counts) below.
2. **An API key** in the environment: `ANTHROPIC_API_KEY`; `GEMINI_API_KEY` or `GOOGLE_API_KEY`.
3. **A local exact tokenizer.** Codex instructions always use OpenAI's `o200k_base` encoding and are never sent, with or without `--precise`. Claude and Gemini have none.
4. **The byte estimate.**

Strata counts only providers that have recognized instructions somewhere in the history:

- A repository with only Gemini files never runs `ant`.
- A repository with only Claude files never asks for a Gemini key. It runs `gcloud` only when neither an `ant` account nor `ANTHROPIC_API_KEY` is available.

The default models are `claude-opus-5-5` and `gemini-3.8-flash`. Override them with `--claude-model` and `--gemini-model`.

#### What leaves the machine

Without `--precise`, nothing is sent. With it:

- **What is sent.** When step 1 or 2 applies, Strata sends the text of each recognized Claude or Gemini instruction file version to that provider's token-count endpoint.
- **What you are told.** Before sending, Strata prints the host and the number of file versions. The run ends with each provider's method and anything it skipped.
- **What is never sent.** Settings, skill resources, and blank files. Codex is counted on this machine.
- **Files that are not text.** A file version that is not valid UTF-8 text cannot be counted as text. Each provider that reads it uses the byte estimate for all its files, so one provider's counts never mix methods, and nothing is sent.
- **Imported and shared files.** Markdown that a Claude `@path` import reaches is a Claude instruction file and is sent like one. A shared file such as `AGENTS.md` is sent to Claude's or Gemini's endpoint when Strata counts it as read by that provider.
- **What reports record.** The method, its accuracy, the credential source, and the receiving host, never a key or token.

#### How precise counting works

- **Message wrapper.** A count endpoint counts a whole request, so each file's count includes a few tokens for wrapping it in a message: about 8 for Claude. Strata counts a one-letter message once per model and takes that count, less one, as the wrapper. It subtracts the wrapper from every file, so counts describe the stored text and add up across files. The report records it as `wrapperTokens`.
- **Rate limits.** A request that is rate-limited, hits an overloaded server, or fails is retried up to six times, waiting longer each time and as long as the endpoint's `retry-after` asks. Only a method that still fails falls back to the next one. If it had already sent some files, the report and run output still name that host (`alsoSentTo`).
- **Cache.** Remote counts are kept per endpoint, model, and Git blob in `provider-counts.json`, in `STRATA_CACHE_DIR` or else the user cache directory:
  - macOS: `~/Library/Caches/strata`
  - Linux: `$XDG_CACHE_HOME/strata` or `~/.cache/strata`
  - Windows: `%LOCALAPPDATA%\strata`

  A later run sends only the file versions it has not counted before, and says how many came from the cache. A `-latest` model alias is not cached, because it moves to new models. The file holds blob IDs, model names, and counts, never paths or text, and only its owner can read it. `--no-cache` neither reads nor writes it. Delete the file to clear it.
- **Dry run.** `strata analyze --precise --dry-run` prints, for each provider, the method it would use, how many file versions it would send and where, and what it would skip. Then it stops, without sending anything or writing a report.
- **In the HTML report.** The "How tokens are counted" toggle names each provider's method on one line: the provider's API count, exact on this machine, or the estimate. It opens to a short table with the model, where the text was counted, and the credential, or why the estimate was used; hover a row for the full description.
  - "All files" adds providers together, so it always uses the estimate.
  - A provider tab opens on that provider's own counts when it has them, with a switch back to the byte estimate.
  - The chart, totals, treemap, and comparison follow the selected count, and the provider's row in the table is bold.
- **Pull requests.** `strata diff --precise` adds each provider's totals at the base and head commits, and the [GitHub Action](pr-action.md) takes `precise: 'true'`.

#### Signing in for precise counts

Strata does not install or sign in to provider CLIs. It asks an installed CLI for a short-lived access token and never reads credential files. If a CLI is missing, `--precise` falls back to the next method, and the run says so, with the install command:

```text
Claude: 1231 tokens latest, byte estimate.
  Skipped: the Anthropic CLI (`ant`) is not installed; to count with your Anthropic account, install it with `brew install anthropics/tap/ant` (or see https://github.com/anthropics/anthropic-cli) and run `ant auth login`.
```

**Claude.** [`ant`](https://github.com/anthropics/anthropic-cli) is Anthropic's command-line tool for the Claude API, separate from Claude Code. Install and sign in once:

```sh
brew install anthropics/tap/ant      # macOS; Linux builds are on the releases page
ant auth login                       # opens a browser
ant auth status                      # shows the active profile
```

`ant auth login` signs in to a Claude Platform (API Console) organization and workspace, not to a Claude.ai Pro or Max subscription, so you need an account there. A Claude Code login is not used: Anthropic does not permit other tools to use it.

**Gemini, and Claude through Google Cloud.** Install the [Google Cloud CLI](https://cloud.google.com/sdk/docs/install). Then run `gcloud auth login` and `gcloud config set project <project>` for a project with the Vertex AI API enabled.

- Claude is counted this way only when neither an `ant` account nor `ANTHROPIC_API_KEY` is available, and only if the project has Claude enabled in Model Garden. Someone who only uses Claude and has no ready `gcloud` is never asked about it.
- Vertex AI answers only for a project with billing enabled, even though token counts are free. Without billing, the count fails with `BILLING_DISABLED` and Strata moves on to the next method.
- To count Gemini without billing, create a key in [Google AI Studio](https://aistudio.google.com/apikey), whose free tier covers token counts, and set `GEMINI_API_KEY`.
- A Gemini CLI login is not used: its terms forbid third-party tools from using it.

## Shareable reports

In every `analyze` format, `--shareable` replaces repository and branch names with fixed placeholders, and file paths, skill directory names, MCP server names, commit IDs, and blob IDs with numbered aliases. The aliases are deterministic, so the same history always gets the same aliases. Dates, labels, and measurements remain visible, so inspect a report before sharing it.

## The interpretation skill

Strata comes with a skill that teaches a coding agent to read its output: `analyze` JSON and HTML reports, `diff` JSON and Markdown, the SVG image, and the badge. Print it, or save it at a path you choose:

```sh
strata skill
strata skill --output .agents/skills/strata-interpret/SKILL.md
```

The `skill` command refuses to overwrite an existing file.

## Reading the HTML report

### Timeline and comparison

- **Comparison.** Select a baseline and a target revision to compare them. The comparison shows signed changes (`+` or `-`) in estimated tokens and file counts, by provider, category, and component. When either revision has a skill, the change in listed skill tokens is shown beside them. It starts against the previous change: the revision before the latest change at or before the target, so it lists that change even when the selected revision changed nothing. "Previous revision" compares with the revision just before the target. The selectors list only revisions that changed something, plus the first and the latest.
- **Timeline.** The timeline sets the target revision. For histories longer than 100 revisions, the chart groups neighboring revisions into at most 100 bars. Each bar shows its group's last revision, a line under the chart says how many revisions the bars stand for, and the slider still reaches every charted commit. Hovering or focusing a bar shows the revisions it covers and its tokens by category.
- **Where the chart starts.** The chart and slider start at the first revision with tracked configuration in the current view. Earlier revisions that changed something stay available in the baseline and target selectors.
- **Moved files.** The comparison is based on the stored files at those two points, so a moved file may appear as a removal and an addition.

### Provider tabs

The report opens on **All files**, which counts each tracked file once. Each provider tab shows that provider's own files plus the shared files and other tools' files it reads:

| Tab            | Also shows                                                                                                                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude Code    | `AGENTS.md`                                                                                                                                                                                                                          |
| Codex          | `AGENTS.md`, `.agents/skills`                                                                                                                                                                                                        |
| Gemini CLI     | `.agents/skills`.`AGENTS.md` and `GEMINI.md` appear as the revision's `.gemini/settings.json` `context.fileName` names them; by default, `GEMINI.md` alone.                                                                          |
| Cursor         | `AGENTS.md`, `.agents/skills`, `.claude/skills`, only at revisions that track Cursor configuration                                                                                                                                   |
| GitHub Copilot | `AGENTS.md`, `CLAUDE.md`, `REVIEW.md`, `GEMINI.md`, `.claude/agents`, `.claude/rules`, `.claude/skills`, `.agents/skills`, `.mcp.json`, only at revisions that track Copilot configuration such as `.github/copilot-instructions.md` |
- A repository with no Cursor files has no Cursor tab.
- Shared files can appear in several provider tabs, so do not add the tab totals together.
- The Cursor tab labels the root `.cursorrules` `rules (legacy)`. The Copilot tab labels a `.chatmode.md` in `.github/agents` `agents (legacy)`.
- Cursor and Copilot files always use the report's measurement, since `--precise` has no count for either.
- These are views of stored files, not measurements of what an agent actually loaded.

The selected view applies to the chart, summary, treemap, skill bundles, comparison, and inventory. The tracked-components table (the inventory) can also be filtered by provider, category, and a path search that ignores case. Those inventory filters stay active as you move along the timeline, and reset when you change provider tabs.

### Treemap

The treemap shows the selected revision's instruction files as rectangles. Each rectangle's area is proportional to the file's stored-text token estimate, and its color shows its category.

- Rectangles of files that the selected revision added, edited, or renamed are outlined.
- Hover or focus a rectangle for its full path and token count. Select it to find its file in the inventory.
- A name that two rectangles share gets the folders that tell them apart, such as `core/AGENTS.md` and `server/AGENTS.md`, or `.claude/…/review` and `.agents/…/review`.
- Source-only and zero-token files stay in the inventory and get no area: source-only files have no token count, and zero-token files have nothing to size.

### Configuration map

The **Configuration map** lists the same revision's files in their folders. Each file has a bar for its share of the stored-text tokens.

- **Import lines.** The map draws a line for each Claude `@path` import Strata resolves, with the arrow at the imported file. These are the imports on chains that start at a `CLAUDE.md`, `CLAUDE.local.md`, or `AGENTS.md`, up to four hops (one file importing the next), as in the **Claude imports** panel.
- **Folders.** A folder holding only one folder shares its row, so `.claude/skills/review` takes one line. Large maps start with deeper folders closed. Select a folder, or use the arrow keys, to open or close it. Select a file to find it in the inventory.
- **Hover.** Hover or focus a row to highlight its import lines and read what it imports and what imports it.
- **Unresolved imports**, including those beyond four hops, are counted on the importing row and listed in the **Claude imports** panel, not drawn.
- **Provider tabs.** The map follows the provider tab. An import whose other file is outside the view has no line.

A folder only holds its files, and a line does not show that a session loaded a file.

### Other panels

- **At session start.** For each agent, this panel separates the stored text it keeps from the start of a session at the repository root from what it reads on demand. In a provider tab, it also lists the files that agent keeps up front. It always uses the report's measurement.
- **Skill bundles.** The skill-bundle table gives each manifest's stored tokens beside its listed tokens: the frontmatter name and description an agent keeps in context before the skill is used. Its heading totals both.
- **MCP servers.** This panel lists, by name, the servers that the selected revision's MCP and settings files define. For each, it shows whether it starts a local process or connects to a URL, and which file defines it. It follows the provider tab, and the comparison counts servers added and removed. A defined server is not a loaded one, and Strata never starts one, so the tool definitions a server sends are not measured.
- **Instruction age.** This panel stacks each revision's instruction text by the period it was added, oldest at the bottom. It shows how much of the text has stayed since early on and how much was rewritten.
  - Lines are matched by their exact text in every instruction file. A line moved into a skill keeps its age, a reworded line starts again, and text removed and later restored counts as new.
  - It is weighed by bytes, always covers all files, and groups text by author date.
  - "Compare revisions" also gives the share of the baseline's instruction text still present at the target.

When no revision tracks a recognized file, the report shows one card in place of the panels, listing the main paths Strata recognizes.

The skill-bundle and tracked-components tables are collapsed under their headings. Open one to see its first rows, and expand it to see the full list.

## The JSON report

- **Components.** JSON reports store each distinct file version once, in a top-level `components` list.
- **Revisions.** Every revision carries its `estimatedTokens`, `componentCount`, and `changes`. Each change points at the component now at that path.
- **Carried-forward fields.** A revision leaves out `categoryTotals` when they equal the previous revision's, and `firstParent` when it is the previous revision's `id`. The first revision always has both. To read a revision's category totals, take the nearest one at or before it, for example `jq '[.revisions[].categoryTotals | select(.)] | last'` for the latest.
- **Rebuilding a revision.** Replaying the changes in order rebuilds the files present at any revision. Together with the carried-forward fields, this keeps reports small on long histories.

The bundled interpretation skill explains schema version 21 and these rules, and also:

- up-front context, Claude imports, MCP servers, and instruction age;
- stored-text measurement methods, source-only files, skill bundles, and shareable aliases;
- the limits of what JSON can establish.

It also covers the `strata diff` JSON (schema version 14) and what its Markdown leaves out, reads the badge and SVG image, and maps each HTML report panel, including the configuration map, to the JSON it is drawn from.
