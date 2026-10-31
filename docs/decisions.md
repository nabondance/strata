# First-release decisions

Recorded 2026-10-08. These choices describe the current implementation. They are not a claim about what an agent loads at runtime.

These terms are used throughout:

| Term | Meaning |
| --- | --- |
| Revision | One commit on the analyzed branch's first-parent history, stored as one entry in the report's `revisions`. |
| First-parent history | The chain of commits found by following each commit's first parent back from the branch tip. A merge commit's first parent is the commit the receiving branch pointed to before the merge, so the commits of a merged branch are not separate revisions: the merge is one change. |
| Blob | The content of one file version as Git stores it. A blob ID identifies that content. |
| Component | One distinct file version, a path paired with a blob, listed once in the report's `components` table. |
| Instructional file | A file whose text Strata measures in tokens, such as `CLAUDE.md`, a rule, or a skill manifest (`estimatedTokens` is not null). |
| Stored-text tokens | A token figure for the text as Git stores it. It is not the context an agent loads in a session, and not billing tokens. |
| Source-only | A file recorded by byte size alone, with no token figure: settings, MCP files, skill resources, and other structured or supporting files. |
| Provider | An agent tool whose file conventions Strata recognizes: `claude` (Claude Code), `codex`, `gemini` (Gemini CLI), `cursor`, and `copilot` (GitHub Copilot). A path convention that belongs to several of them, such as `AGENTS.md`, is labeled `shared`. |
| Readers | On a component, the providers documented as reading its path. |
| Provider view | The report narrowed to the files one provider reads. |
| Shallow clone | A clone that holds only recent history, so the analyzed history starts where the fetch cut it. |

## Name and command

The npm package name is `context-strata`; its executable is `strata`. On 2026-10-08, direct queries to the npm registry returned 404 for `context-strata` and an existing package, `strata@0.20.1`, for `strata`. A 404 is not a reservation. Version 0.1.0 was published to npm on 2026-10-12. The command is `npx context-strata analyze . --output report.html`.

## License and contributions

Strata uses the OSI-approved MIT license, chosen to allow broad use and redistribution with a short attribution requirement. The repository has a contribution guide and a security-reporting path. The packaged runtime dependency `d3-hierarchy` has its own ISC license, which stays embedded in offline HTML reports beside its code.

## Measurement

### The estimate and Codex's local count

Strata measures stored instructional text with its `utf8-bytes-divided-by-four-v1` comparison estimate: `ceil(UTF-8 bytes / 4)` for each file, then the sum. It is the only report-wide measurement: every total, chart, comparison, limit, badge, and image uses it, for every provider, and no option changes it. Earlier versions offered `--tokenizer` and `--model` to apply one OpenAI encoding to every file instead; they were removed because an OpenAI encoding says nothing exact about Claude, Gemini, Cursor, or Copilot files, and mixing methods inside one total would make it neither an estimate nor exact.

Files Codex reads are also counted on every run, with OpenAI's `o200k_base` encoding through `js-tiktoken@1.0.21`, for valid UTF-8 text. Every current OpenAI model (GPT-4o, GPT-4.1, GPT-5, o3, o4-mini, and Codex) uses that encoding, so no model name is needed; the count's `model` names the encoding. Older encodings such as `cl100k_base` (GPT-4) and `o200k_harmony` (`gpt-oss`) are not shipped. These counts are Codex's own totals in `providerMeasurements`, `providerTokenCounts`, and `providerTokenTotals`, as with `--precise`; they never replace the estimate.

What the local count means:

- It is exact for `o200k_base`. It excludes message framing, special-token handling, actual loaded context, and billing.
- Text that spells a special token, such as `<|endoftext|>` in a file about language models, is counted as ordinary text rather than rejected.
- Text is counted one pattern piece at a time, with a cache of distinct pieces. This gives the same total as encoding the whole text (see [the benchmark notes](benchmark.md)).
- It is taken from the shared content pass, so it rarely reads a file version a second time; see [History extraction](#history-extraction).
- It does not claim accuracy for Claude or Gemini.

Without `--precise`, Strata makes no network request and transfers no content. Structured configuration and supporting resources are measured in source bytes only. See [the tokenizer study](tokenizers.md) for evidence.

### Precise per-provider counts

`strata analyze --precise` is the explicit opt-in for Claude's and Gemini's own counts. It needs no other flag. Each provider is counted with the most precise method available, tried in the order below. The report and the run output say which method was used and why each earlier one was skipped.

| Provider | 1. Signed-in account | 2. API key | 3. Local exact | 4. Estimate |
| --- | --- | --- | --- | --- |
| Claude (default `claude-opus-5-5`, `--claude-model`) | `ant auth login` profile, through `ant auth print-credentials --access-token`; Anthropic count endpoint. With neither that nor `ANTHROPIC_API_KEY`, a ready `gcloud` account; Vertex AI `count-tokens:rawPredict` | `ANTHROPIC_API_KEY`; Anthropic count endpoint | none exists | byte estimate |
| Gemini (default `gemini-3.8-flash`, `--gemini-model`) | `gcloud` account with a project (`GOOGLE_CLOUD_PROJECT` or `gcloud config`), through `gcloud auth print-access-token`; Vertex AI `countTokens` in `GOOGLE_CLOUD_LOCATION` (default `global`) | `GEMINI_API_KEY` or `GOOGLE_API_KEY`; Gemini API `countTokens` | none exists | byte estimate |
| Codex (with or without `--precise`) | not used | not used | `js-tiktoken` `o200k_base` | byte estimate |

`strata diff --precise` uses the same methods and reports each provider's totals at the base and head commits. PR delta schema version 5 added `providerMeasurements` and `providerTotals` for this; since version 13, `strata diff` reports Codex's totals without `--precise` too.

#### Which providers and credentials are used

- A provider with no recognized instructions anywhere in the analyzed history is skipped entirely. Its CLI is not run, no credential is looked up, and the report has no count column or metadata for it.
- For Claude, `gcloud` is consulted only when neither an `ant` account nor `ANTHROPIC_API_KEY` is available. So Claude text never goes to Google Cloud when an Anthropic credential exists.
- Strata uses a signed-in account only through the provider's own CLI, which prints a short-lived access token. It never reads credential files.
- Two sign-ins are deliberately not used:
  - A Claude Code subscription login is for Claude Code and Claude.ai only, and Anthropic does not permit other tools to use its OAuth tokens. An `ant auth login` profile, by contrast, is an API credential that Anthropic's SDKs and CLI share.
  - Gemini CLI's Google sign-in reaches the Code Assist service, whose terms forbid third-party tools from using it, and Gemini CLI has no count command. A `gcloud` account calling Vertex AI is the supported route.
- Codex is counted locally because OpenAI's encodings are published and exact for stored text. A signed-in ChatGPT account or `OPENAI_API_KEY` would only add a transfer.

#### What is sent, and when

- Every instruction version is read once before anything is sent:
  - A blank file counts as zero without a request.
  - A provider whose files are all blank sends nothing, not even the wrapper probe described below, and names no recipient.
  - A version that is not valid UTF-8 has no text count, so its providers use the byte estimate for every file and send nothing.
- Before sending, the CLI prints which host will receive how many instruction file versions. This notice is shown even with `--quiet`.
- A method that fails during the run, such as one whose token is rejected, is discarded whole and the next method is tried. So one provider's counts never mix methods.
- `--dry-run` resolves credentials and reports each provider's method and what would be sent, without sending anything or counting remotely. The local Codex count, taken with the shared read, still runs.
- Access tokens and keys are held in memory for the run only. They are never written to reports or output.

Each provider's metadata in the report records:

- `accuracy`: `api-counted`, `encoding-exact`, or `estimate`.
- `credential`: the source of the credential, never the credential itself.
- `recipient`: the host that received text, when text left the machine.
- `fallbacks`: the methods that were skipped or failed, and why.

#### Request wrapper, retries, and cache

A count endpoint counts a request, not a file, so each count includes the tokens of a one-message wrapper. On 2026-10-15 the wrapper was 8 tokens for `claude-opus-5-5` and 1 for `gemini-3.8-flash` through the Gemini API. Strata measures the wrapper once per model by counting the one-letter text `a`, which is one token in any byte-level tokenizer (a tokenizer that can split any text down to single bytes). It then subtracts that count minus one from every file's count, never going below zero. This assumes the wrapper does not merge with the file's first or last characters. The value is recorded as `wrapperTokens`, so a reader can add it back.

Requests that fail with a rate limit (429), overload (529), timeout (408), or server error, and requests that fail to connect, are retried with backoff, up to six attempts in all, honoring `retry-after` up to 60 seconds. Only a method that still fails falls back to the next one.

Remote counts are cached between runs:

- File counts are cached per endpoint family, model, and Git blob, and the wrapper count per endpoint family and model. A rerun therefore sends only new file versions.
- A model name ending in `-latest` is an alias that moves to new models, so its counts are not cached.
- The cache file is readable by its owner only and holds no paths or text.


## History extraction

Analysis reads the whole first-parent history from one streamed `git log --first-parent --diff-merges=first-parent --raw -M` process, which needs Git 2.31 or newer. Each commit's raw diff against its first parent updates an in-memory inventory of recognized regular files:

- Symlinks and submodules are never tracked as files.
- The same diff shows each submodule entry being added or removed. So the submodules present at the last commit, and the commit each one records, are collected without another Git command. `--ignore-submodules=none` keeps settings such as `diff.ignoreSubmodules` from hiding them.
- Renames are the ones Git reports in that diff. Only a rename between two recognized paths is labeled as a rename.

Blob sizes come from `git cat-file --batch-check`. Blob content is read in bounded batches, and only for:

- every instructional file version, because [instruction age](#instruction-age) matches their lines;
- the root Gemini settings, to resolve `context.fileName`;
- skill manifests, to measure their listing;
- Claude instruction files and the Markdown their imports reach, to resolve `@path` imports.

Settings, MCP, and other source-only files are otherwise read only where a section below says so.

One shared pass reads each of these blobs once and gives its content to every step that needs it: line counts, Gemini settings, skill listings, rule loading, MCP server names, and the provider-count check for blank or non-UTF-8 text, which also takes the local Codex count. Claude import parsing runs first, because it decides which files join the analysis; the blobs it reads are handed to the shared pass, which does not read them again. The local Codex count is taken in the pass, from the content it reads for the provider-count text check. Two cases read text again: `--precise` counting with a provider API reads each file version when it sends it, so instruction text is never kept in memory waiting for a request, and a Codex file version whose blob the pass first read for a file Codex does not read (such as `CLAUDE.md` text moved unchanged to `AGENTS.md`) is read again to count it.

Each instructional version is reduced to counts of its lines as soon as it is read, and each distinct line's text is kept once. Memory therefore grows with the number of distinct lines, plus a few bytes for each line of each distinct version, not with the history's text.

Some paths named by imports match no path rule. For those, one more `git log --first-parent` limited to those paths gives their history, and the history is replayed to decide, commit by commit, which of them the imports reach; see [Claude imports](#claude-imports). Imports nest at most four hops, so there are at most four such rounds, and none when no instruction file has an import.

`strata diff` lists the two commit trees directly and shares the same classification and measurement code.

Analysis keeps one running inventory and records, for each revision, only what that commit changed. It never builds a file list for each revision. So memory and report size grow with the number of distinct file versions plus the number of revisions, not with revisions multiplied by tracked files.

## Report contract and privacy

### Report layout

Since schema version 9, a report stores each distinct file version once and each revision as a set of changes:

- A top-level `components` table holds one entry per distinct path-and-blob pair across the whole history, ordered by path.
- A revision carries its `componentCount`, `categoryTotals`, `estimatedTokens`, and `changes`. It does not repeat its inventory, and `skillGroups` is no longer stored.
- Every change has a `component` field: the index in `components` of the file version now at `path`, or `null` for a removal.

On one local repository with 181 revisions, this cut the HTML report from 57.5 MB to 1.5 MB.

`categoryTotals` has an entry for every category. A skill component has a `skill` object with its directory root and a `manifest` or `resource` role. The HTML report's skill-bundle table summarizes those same files, keeping manifest token estimates apart from resource byte sizes. These summaries are not additional measurements.

To rebuild the inventory at a revision, start empty and apply every revision's changes in order up to it. For each change:

1. Drop `previousPath` when it is present.
2. If `component` is `null`, drop `path`; otherwise set `path` to that component.

`src/expand.ts` implements this rule, and the HTML report embeds the same function. A fixture test checks the replayed inventory of every revision against a direct listing of that commit's tree. Skill bundles are derived from the rebuilt inventory by grouping components on `skill.root`. The stored totals let a consumer chart the history without replaying anything.

A shortened, illustrative JSON shape:

```json
{
  "schemaVersion": 20,
  "repository": "example",
  "branch": "main",
  "shallow": false,
  "privacy": { "mode": "local" },
  "measurement": {
    "label": "Estimated stored-text tokens",
    "method": "utf8-bytes-divided-by-four-v1: UTF-8 bytes / 4, rounded up per instructional file",
    "limitations": "Comparison estimate only.",
    "family": "generic",
    "accuracy": "estimate",
    "encoding": null,
    "model": null,
    "implementation": "strata-v1"
  },
  "lineAgeMethod": "exact-trimmed-line-multiset-stored-bytes-v1",
  "components": [{
    "path": "AGENTS.md", "provider": "shared", "readers": ["claude", "codex", "cursor"], "category": "instructions",
    "blob": "<Git blob ID>", "bytes": 8, "estimatedTokens": 2
  }],
  "revisions": [{
    "id": "<full Git commit ID>",
    "date": "<author ISO timestamp>",
    "firstParent": null,
    "componentCount": 1,
    "categoryTotals": {
      "instructions": { "count": 1, "bytes": 8, "estimatedTokens": 2, "sourceOnlyCount": 0 }
    },
    "estimatedTokens": 2,
    "changes": [{
      "kind": "added", "path": "AGENTS.md", "previousTokens": null,
      "estimatedTokens": 2, "deltaTokens": 2, "component": 0
    }],
    "lineAge": { "added": 7 }
  }]
}
```

### Privacy

- Default HTML and JSON reports contain commit IDs, dates, paths, provider and category labels, blob IDs, byte sizes, and estimates. They contain no source text. Paths and blob IDs can still disclose the repository's structure.
- HTML and JSON reports are local artifacts. The CLI writes them with mode `0600`.
- The HTML report carries a Content-Security-Policy that allows only its own inline style and script, so a browser will not load anything from the network on its behalf.
- Without `--precise`, Strata makes no network request and uploads no content.
- Explicit `--precise` sends recognized Claude and Gemini instructional text to the provider APIs it finds credentials for. Reports store counts and measurement metadata, never the submitted text, the credentials, or the Google Cloud project.

### Shareable reports

`--shareable` produces schema version 20 with `privacy.mode: "shareable"`. It replaces these values with deterministic aliases local to that report, and does not embed the alias maps:

- repository and branch names;
- commit and first-parent IDs;
- component and change paths;
- import targets, with the same aliases as paths, including targets no file has;
- skill roots, MCP server names, and submodule paths;
- blob IDs.

These stay visible: dates; category and provider labels; `readers`, `contextFile`, `legacy`, `imported`, `importRoot`, and `upFront` labels; an MCP server's `transport` and `disabled`; `lineAge`; counts, byte sizes, and estimates; change kinds; and the timeline's shape.

Some labels narrow an alias down to a well-known path:

- `legacy` is set only on the root `.cursorrules` and on a Copilot `.chatmode.md` in `.github/agents`.
- Claude `tools` is only the root `.mcp.json`.
- `upFront` is set only on a few root file names and on rules in the root `.claude/rules` and `.cursor/rules`.

The default local report is unchanged. Shareable means reduced identifier exposure, not guaranteed anonymity; inspect a report before publishing it.

### Schema versions

| Version | Adds |
| --- | --- |
| 8 | Gemini CLI as a provider; `providerTokenCounts` and `providerTokenTotals` |
| 9 | the `components` table and per-revision `changes` ([Report layout](#report-layout)) |
| 10 | `readers`, `contextFile`, and `geminiContextFiles`; `.agents/skills` becomes `shared` |
| 11 | `estimate` provider counts and the `--precise` metadata fields |
| 12 | `submodules` |
| 13 | skill `listing`, `skillListingTokens`, and `skillListingUnresolved` |
| 14 | the `cursor` provider and `legacy` |
| 15 | the `copilot` provider and `REVIEW.md` |
| 16 | Claude `@path` imports: `imports`, `importRoot`, and `imported` |
| 17 | `upFront` |
| 18 | `mcp` |
| 19 | `lineAgeMethod` and `lineAge`; a narrower `shallow` |
| 20 | Codex provider counts on every run; `measurement` always the byte estimate |

#### Version 8: provider counts

Version 8 added Gemini CLI to the provider labels, optional `providerTokenCounts` on instruction components, and separate `providerTokenTotals` on revisions. Later versions keep both. Each provider count carries its provider, explicit model, method, implementation or API version, and an `api-counted` or `encoding-exact` accuracy label.

Provider labels identify recognized path conventions, not exclusive runtime support. A shared file is stored once and receives a separate count for each selected provider that reads it.

#### Version 10: readers and Gemini context files

Version 10 adds `readers` to shared components: the providers documented as reading that path. It is `["claude", "codex"]` for `AGENTS.md` and `["codex", "gemini"]` for `.agents/skills`. Claude Code's reading of `AGENTS.md` remains an unresolved condition, as before. Files under `.agents/skills/<name>/`, labeled `codex` in version 9, are now `shared`.

Gemini CLI reads `AGENTS.md` and `GEMINI.md` according to the `context.fileName` setting. That setting can change between revisions while the files do not, so the condition is split between the file and the revision:

- Those components carry `contextFile: "agents-md"` or `"gemini-md"`.
- A revision whose repository-root `.gemini/settings.json` sets `context.fileName` carries `geminiContextFiles`, the labels the setting names. Other revisions omit it, which means `GEMINI.md` only.
- The labels are deliberately not file names, so they cannot match an aliased path in a shareable report. Configured names Strata does not recognize are not stored.

`providerReads` in `src/provider-view.ts` is the one rule for whether a provider reads a component at a revision. Analysis totals, provider views, and the report's provider columns all use it. With `--precise`, a context-file version is sent to Gemini only if it is present at some revision where Gemini reads it.

#### Version 11: `--precise` metadata

Version 11 adds what `--precise` needs to label its choices:

- A provider count's `accuracy` may be `estimate`, with a `null` model, when no account, key, or local tokenizer was available.
- Each `providerMeasurements` entry may carry `credential`, `recipient`, `alsoSentTo` (hosts that received text from a method that then failed), `wrapperTokens`, and `fallbacks`.
- A fallback for a failed count gives the provider's short error code, such as `BILLING_DISABLED`, and a hint for that endpoint. It never gives the provider's error message, which can name the Google Cloud project.

#### Version 12: submodules

A submodule entry in Git stores only a commit ID from another repository. Agent configuration is sometimes kept in a submodule and copied into an ignored directory by a script, so a report could look complete when it is not. Version 12 adds `submodules`: one entry per submodule present at the last revision, sorted by `path`, and omitted when there are none.

Each entry's `configFiles` counts the regular files in the submodule, at the commit the parent records, whose path is recognized either:

- inside the submodule, such as a template with its own `.claude/`; or
- where it is mounted in the parent, such as a skill kept as a submodule at `.claude/skills/<name>`.

Strata finds them by listing that commit's tree in the submodule's own checkout. `configFiles` is `null` when the submodule is not checked out or lacks that commit.

Safeguards:

- The checkout must resolve inside the parent, and its top level must be the submodule directory itself, so an empty directory is not mistaken for the parent repository.
- These Git commands run without the parent's `GIT_DIR`-style variables and with `GIT_NO_LAZY_FETCH=1`, so with Git 2.44 or newer a partial clone is never fetched from. Older Git ignores that variable.

The count says only that the submodule holds files matching the path rules. Strata does not analyze them; the user can run Strata on the submodule instead. The result depends on which submodules are checked out, so the same commit can give different counts on different machines.

The HTML report shows a warning above the timeline, and the command line prints a note. Both name at most five submodules with recognized files, and give only a count for those that could not be checked. Submodules without recognized files are left out, so vendored libraries add no noise. The command line escapes control characters in submodule paths. The static SVG image carries no submodule note.

#### Version 13: skill listings

Version 13 adds a `listing` to the `skill` object of each skill manifest, and `skillListingTokens` and `skillListingUnresolved` totals to each revision; see [Skill listings](#skill-listings). Revisions from earlier versions have neither.

#### Version 14: Cursor

Version 14 adds the `cursor` provider for:

- `.cursor/rules/**/*.mdc` and the root `.cursorrules`;
- `.cursor/commands/*.md`;
- `.cursor/mcp.json`;
- `.cursor/skills/<name>/`;
- the root `.cursorignore`;
- other candidate files in Cursor's folders under `.cursor/`.

Only those folders and top-level JSON are inventoried as `other`, because projects keep unrelated notes under `.cursor/`.

Cursor also reads files that belong to other tools: `AGENTS.md`, `.agents/skills`, and `.claude/skills`. Cursor needs no file in the repository, so Strata treats it as reading them only at a revision that tracks Cursor configuration, meaning a revision with at least one component labeled `cursor`. The rule is in `providerReads` and is derived from each revision's components, so it needs no stored field and survives `--shareable`.

Where some revision has Cursor configuration, Cursor joins these `readers`:

| Path | `readers` |
| --- | --- |
| `AGENTS.md` | `["claude", "codex", "cursor"]` |
| `.agents/skills` | `["codex", "cursor", "gemini"]` |
| `.claude/skills` (provider stays `claude`) | `["claude", "cursor"]` |

Where no revision has Cursor configuration, `readers` is exactly as in version 13, so a Claude-only report has no Cursor label anywhere. `cursor` in `readers` therefore means Cursor can read the path, not that it read that file version: a version present only before Cursor configuration appeared still lists it. Cursor's condition is resolved per revision, like Gemini CLI's `context.fileName`, which is carried by `contextFile` rather than `readers`.

Other Cursor rules:

- Cursor also loads `.codex/skills`, which current Codex documentation does not list, so that path stays Codex `other`.
- A component may carry `legacy: true`, set only on the root `.cursorrules`. Cursor still reads it but documents `.cursor/rules` as its replacement, so the report keeps it in `rules` and labels it instead of hiding the difference. The label is not a path, so it survives `--shareable`, and it identifies the root `.cursorrules` behind its alias.
- Rule frontmatter (`alwaysApply`, `globs`, `description`) is stored text like any other and is not interpreted here, so the report does not claim which rules were active.
- Cursor has no `--precise` count; its files keep the report's measurement.

Reports from version 13 and earlier recognize no Cursor files. [The adapter study](next-adapter.md) records the evidence for each pattern.

#### Version 15: Copilot

Version 15 adds the `copilot` provider for GitHub Copilot:

| Path | Category |
| --- | --- |
| `.github/copilot-instructions.md` | instructions |
| `.github/instructions/**/*.instructions.md` | rules |
| `.github/prompts/*.prompt.md` | commands |
| `.github/agents/**/*.md`, except `README.md` | agents |
| `.github/skills/<name>/` | skills |
| `.github/mcp.json`, root `.vscode/mcp.json` | tools (source-only) |
| root `.github/hooks/*.json`, `.github/copilot/settings*.json`, and the `copilot-setup-steps.yml` and `copilot-code-review.yml` workflows | settings (source-only) |

Nothing else under `.github/` is inventoried, so ordinary workflows, issue templates, and `CODEOWNERS` stay out of the report.

- A `.chatmode.md` inside `.github/agents` carries `legacy: true`, because chat modes are the format custom agents replaced.
- A file in `.github/chatmodes`, which current VS Code reads only when a user setting adds that folder, is source-only `other`.
- `applyTo`, `excludeAgent`, and `target` frontmatter is stored text and is not interpreted.

Like Cursor, Copilot needs no repository file and reads other tools' files, so the same rule applies to it separately. At a revision with at least one component labeled `copilot`, Copilot reads `AGENTS.md`, `.agents/skills`, and the Claude and Gemini files it documents reading. Those files keep their own provider and gain `readers`:

| Path | `readers` |
| --- | --- |
| `AGENTS.md` | gains `copilot`: `["claude", "codex", "copilot", "cursor"]` where Cursor also applies |
| `.agents/skills` | gains `copilot` |
| `CLAUDE.md`, `.claude/CLAUDE.md`, `REVIEW.md` (at any depth), `.claude/agents` and `.claude/rules` (except a `README.md`), the root `.mcp.json` | `["claude", "copilot"]` |
| `.claude/skills` | `["claude", "copilot"]`, with `cursor` where Cursor is configured |
| `GEMINI.md` | `["copilot", "gemini"]` |

Notes on this table:

- `REVIEW.md` is newly recognized as Claude instructions because [Claude Code's Code Review](https://code.claude.com/docs/en/code-review-customize) reads it.
- Gemini CLI's `context.fileName` still decides only Gemini's reading of `GEMINI.md`.
- Where no revision has Copilot configuration, `readers` is exactly as in version 14.
- A file keeps its owner's label rather than becoming `shared`, so adopting Copilot does not move tokens out of the Claude or Gemini CLI totals.
- `CLAUDE.local.md` and `.claude/settings.json`, from which Copilot reads only hooks, gain no reader.

The `copilot` label means at least one Copilot client (GitHub.com chat, the cloud agent, code review, Copilot CLI, or an IDE) is documented as reading the path; the report does not say which. Copilot has no `--precise` count: its files keep the report's measurement and their text is never sent. Reports from version 14 and earlier recognize no Copilot files and no `REVIEW.md`. [The Copilot adapter study](copilot-adapter.md) records the evidence for each pattern.

#### Version 16: Claude imports

Version 16 adds Claude `@path` imports; see [Claude imports](#claude-imports):

- `imports` on each version of an instruction file or reached Markdown file that has any;
- `importRoot` on a `CLAUDE.md`, `CLAUDE.local.md`, or `AGENTS.md` that has imports, since Claude Code starts expanding there (`REVIEW.md` is not a root);
- components with `imported: true` for files that are in an inventory only because an import reaches them.

Earlier versions neither resolve imports nor include such files, so their totals can be lower for the same history.

#### Version 17: up-front context

Version 17 adds `upFront` to components that may be read from the start of a session at the repository root; see [Up-front context](#up-front-context). Earlier versions do not separate up-front text from the rest.

#### Version 18: MCP servers

Version 18 adds `mcp` to MCP configuration files, and to Gemini CLI and Codex settings files that mention MCP servers; see [MCP servers](#mcp-servers). Earlier versions record those files by size alone.

#### Version 19: instruction age and `shallow`

Version 19 adds the top-level `lineAgeMethod` and a `lineAge` on each revision that added or removed instruction lines; see [Instruction age](#instruction-age). Earlier versions have no instruction age. Analysis of the same history now reads every instructional file version.

It also narrows `shallow`. It is true only when the first revision is a shallow boundary that has a parent, meaning the commit where a shallow fetch cut the history. Two cases are no longer flagged: a full history in a repository that fetched some other branch shallowly, and a depth-limited clone that reached the root commit anyway.

#### Version 20: Codex counted on every run

Version 20 removes `--tokenizer`, `--model`, `--codex-model`, and `--provider-api`; see [The estimate and Codex's local count](#the-estimate-and-codexs-local-count). The shape is unchanged, but:

- `measurement` is always the byte estimate, so its `encoding` and `model` are always `null`.
- `providerMeasurements`, `providerTokenCounts`, and `providerTokenTotals` are present without `--precise` whenever Codex reads an instructional file, holding Codex's `o200k_base` counts. They are absent, rather than empty, when no counted provider reads one, with or without `--precise`; the PR delta's `providerMeasurements` and `providerTotals` follow the same rule.
- Codex's `model` is `o200k_base`, the encoding, instead of a model name such as `gpt-5`.

Version 19 and earlier have Codex counts only with `--precise`, and their `measurement` may be an OpenAI encoding.

## MCP servers

An MCP file's JSON is configuration, not prompt text. Its size says nothing about the tool definitions a server sends once it starts, and Strata never starts a server, so it does not measure those. What the file does state is which servers the project defines.

Each version of an MCP file carries `mcp`, with a `status` of:

- `listed`, with its `servers`; or
- `unresolved`, when the file does not parse the way its tool reads it.

A server has:

| Field | Value |
| --- | --- |
| `name` | the server's name |
| `transport` | `local` when the tool starts a process: a `command`, or a `type` of `stdio` or `local`; `remote` when it connects to a URL: `url` or `httpUrl`, or a `type` of `http`, `streamable-http`, `sse`, or `ws`; `unknown` otherwise, including an entry without a `type` that has both a command and a URL, since tools disagree on which wins |
| `disabled` | `true` when the file turns the server off: Codex `enabled = false`, or a name that Gemini CLI's `mcp.excluded` lists or its `mcp.allowed` leaves out (`excludeMCPServers` and `allowMCPServers` in older settings) |

Commands, arguments, URLs, headers, and environment values are never read into the report, because committed MCP files often hold credentials.

| File | Servers read from | Syntax accepted |
| --- | --- | --- |
| Root `.mcp.json` (Claude, also Copilot) | `mcpServers` | strict JSON |
| `.cursor/mcp.json` | `mcpServers` | JSON with comments and trailing commas |
| `.github/mcp.json` | `mcpServers`, or, when it is absent, the top-level entries that have a `command`, `url`, or `type`, as Copilot CLI accepts | strict JSON |
| `.vscode/mcp.json` | `servers` | JSON with comments and trailing commas |
| Root `.gemini/settings.json` | `mcpServers`, only when the file has it; nested settings are not read, as for context files | JSON with comments |
| `.codex/config.toml` | `[mcp_servers.<name>]` tables and dotted `mcp_servers.<name>.<key>` keys, only when the file has them; `enabled = false` disables | a TOML subset; inline `mcp_servers` tables are unresolved |

Parsing rules:

- Where a tool does not document its syntax, Strata accepts the stricter one. A file that only a lenient parser reads is unresolved rather than listed.
- Only syntax is checked. A server whose values its tool would reject, such as one with neither a command nor a URL, is still listed.
- An unresolved file's servers are counted apart, never as none.

A defined server is not a loaded one:

- Claude Code asks before starting project servers unless settings approve them (`enableAllProjectMcpServers`, `enabledMcpjsonServers`, and `disabledMcpjsonServers` in `.claude/settings.json`, which Strata does not resolve).
- Copilot CLI, Codex, and Gemini CLI start project servers once the folder is trusted, without asking for each one.
- User and global configuration is outside Git.

The HTML report lists the servers in a collapsed panel that follows the provider tab. The comparison counts servers by file and name, so a server moved to another file is a removal and an addition, and one server defined for two tools counts twice.

## Skill listings

Claude Code, Codex, Copilot, Cursor, and Gemini CLI keep a skill's name and description in context, and read the rest of its `SKILL.md` only when the skill is used. The manifest's `estimatedTokens` measures the whole stored file, so a skill's stored size says little about what it costs before it runs.

A manifest's `skill.listing` measures the listed part: the frontmatter `name` and `description` values joined by a newline, counted with the report's measurement. The text boundary follows [Claude Code's skill reference](https://code.claude.com/docs/en/skills), [Codex skills](https://learn.chatgpt.com/docs/build-skills), [Gemini CLI skills](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/skills.md), [Cursor skills](https://cursor.com/docs/context/skills), and [Copilot skills](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/add-skills):

- A Claude skill without `name` is listed by its directory name, and one without `description` by the first non-empty line of its body, taken as stored (a Markdown heading keeps its `#`), as the reference describes. `when_to_use` is appended to the description, and the two are cut together at 1,536 characters (Unicode code points). `disable-model-invocation: true` leaves the skill out of the listing: its `status` is `hidden` and `tokens` is 0.
- Codex, Copilot, Cursor, and Gemini CLI skills, including shared `.agents/skills`, must set both `name` and `description`; Claude-only fields are ignored. Cursor also leaves out a skill with `disable-model-invocation: true` until it is invoked by name, so a `.cursor/skills` manifest that sets it is `hidden`.
- A manifest keeps one listing, by the rules of the tool that owns its folder: Claude Code's for `.claude/skills`, and Codex and Gemini CLI's for `.agents/skills`, which ignore `disable-model-invocation`. Cursor's and Copilot's own listings of those skills are not measured separately and can differ; the HTML Cursor and Copilot views say so beside their skill tables.
- Frontmatter counts only when the file's first line is `---` and a later `---` line closes it. Strata reads a subset of YAML: top-level keys whose values are plain scalars over one or more lines, single-line quoted scalars, or literal and folded block scalars.
- The listing is `unresolved`, with `tokens: null`, when a field Strata needs is in another form (such as a flow sequence or a plain value containing `: `), or for a duplicate key, an unclosed block, a missing required field, or a manifest that is not valid UTF-8. Strata does not guess what an agent would do with frontmatter it cannot read. Claude Code, for instance, loads a skill whose YAML does not parse with no fields set.

### Listing totals

A listing has `status` `listed`, `hidden`, or `unresolved`. It is measured separately from the manifest's stored text and never added to it or to any total:

- `skillListingTokens` on a revision sums the listings of the manifests present.
- `skillListingUnresolved` counts the unresolved ones it leaves out.
- Provider views recompute both from the files they show.

A listing mostly repeats text already in the manifest's count, but not always. A Claude skill without `name` is listed by its directory name, which is not in the file, so a short manifest's listing can exceed its stored tokens. Because the default name comes from the directory, renaming a Claude skill directory can change its listing without changing the file.

Totals always state how many unresolved manifests they leave out, so fixing a broken frontmatter is not mistaken for a new cost. Claude Code still lists such a skill, with fields Strata cannot know.

### What a listing does not measure

- the agent's own wrapper around each entry;
- the path Codex lists beside each skill;
- Codex shortening descriptions to fit `skills.max_context_tokens`;
- Claude Code dropping descriptions of its least-used skills when the whole listing exceeds its budget (1% of the context window by default, changed with `skillListingBudgetFraction` or `SLASH_COMMAND_TOOL_CHAR_BUDGET`);
- Claude Code's per-entry cap, changed with `skillListingMaxDescChars`;
- `skillOverrides` set to `name-only`;
- skills disabled outside the repository or by `agents/openai.yaml`;
- precedence between skills of the same name;
- user or plugin skills.

`--precise` does not send listing text anywhere. Listings use the report's measurement, the byte estimate by default. In an HTML view that shows a provider's own counts, manifest tokens change but listings do not, so the view names the listings' measurement and says the two are not comparable. No listing text is stored in the report.

### Where listings appear

The HTML report and `strata diff` show listings wherever they show a manifest's stored tokens:

- the skill-bundle table and its heading;
- the treemap detail line and the inventory token cell of each manifest;
- the comparison, which gives the listed-token change between two revisions and, for each changed manifest, its listing change.

A manifest's listing change is a signed token difference when both sides are listed. Otherwise it shows the state at each side, such as `none → 12` for an added manifest or `unresolved → 3`, so a status change is never shown as a token difference. The history chart, SVG image, and badge keep to stored-text totals.

## Up-front context

A repository's stored total mixes text an agent keeps for the whole session with text it reads only for some work. For each provider, Strata splits what that provider reads at a revision (by `providerReads`) into two stored-text figures, for a session started at the repository root:

- **Up front**: the root instruction files it reads, its own root rules that load at launch, and, for Claude Code, every file that `@path` imports reach from those (by the [import rules](#claude-imports), up to four hops). Add to that the [listings](#skill-listings) of the skill manifests it reads. The figure is the files' stored-text tokens plus the listed tokens.
- **On demand**: the stored-text tokens of every other file it reads, for later in the session, for a session started in a subdirectory, or for other work. This covers nested instruction files, path-scoped rules, skill manifests (whose listings are already up front), commands, agents, memory, `REVIEW.md`, and `.gemini/system.md`.

A root `AGENTS.md` that a default skips, as described below, is in neither figure and is counted apart as skipped. Up-front, on-demand, and skipped files add up to the provider view's stored total, with one exception: Claude Code loads whatever its imports reach. So a file another tool owns that a Claude import reaches, such as `GEMINI.md`, is up front for Claude although the Claude view does not list it. Listings are extra, because they mostly repeat text the manifests count.

Both figures are stored text under the report's measurement, never provider counts. They are not loaded context, which also holds the tool's own prompt, user and organization files, and the conversation. They are not billing tokens either.

### What each tool reads up front

The boundary follows each tool's documentation:

| Tool | Up front at the repository root | Read later or conditionally |
| --- | --- | --- |
| Claude Code ([memory](https://code.claude.com/docs/en/memory)) | `CLAUDE.md`, `.claude/CLAUDE.md`, and `CLAUDE.local.md` in the starting directory and above, with their imports; rules in `.claude/rules` without `paths` frontmatter. By default, a root `AGENTS.md` only when none of those three files exists at the root, or when an import reaches it. | files in subdirectories, path-scoped rules, and rules in nested `.claude/rules` folders, when it works there |
| Codex ([AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)) | the root `AGENTS.md`, or a non-empty `AGENTS.override.md` in its place | none: nested files below the starting directory are not read |
| Gemini CLI ([context files](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/gemini-md.md)) | context files in the workspace directory and its parents at startup, so only the root `GEMINI.md` and, when `context.fileName` names it, `AGENTS.md` | context files in subdirectories, when a tool touches them |
| Cursor ([rules](https://cursor.com/docs/rules)) | the root `AGENTS.md` and rules with `alwaysApply: true`, applied to every chat | other rules, by glob, by agent request, or by mention |
| Copilot ([repository instructions](https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions)) | `.github/copilot-instructions.md`, applied to every request in the repository; the root `AGENTS.md`, `CLAUDE.md` (and `.claude/CLAUDE.md`, as Strata's Copilot readers do), and `GEMINI.md` | `.instructions.md` files, only for files their `applyTo` matches; the nearest nested `AGENTS.md` wins for work in its folder |

`REVIEW.md` is read only by code review, and `.gemini/system.md` only with `GEMINI_SYSTEM_MD` set.

### How the split is stored

The split is derived from labels, so it needs no per-revision field and survives `--shareable`. A component carries `upFront: "listed"` when its readers may keep it from the start of a session:

- the root `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `AGENTS.override.md`, `GEMINI.md`, and `.github/copilot-instructions.md`;
- a rule under the root `.claude/rules` (at any depth inside it) without `paths`;
- a root `.cursor/rules` rule with `alwaysApply: true`.

`upFrontContext` in `src/up-front.ts`, which the HTML report embeds, applies `providerReads`, the `AGENTS.md` and override defaults, and the imports.

A rule's frontmatter decides only for the tool that owns it. Copilot reads `.claude/rules` along with its own rules, so those files are on demand in the Copilot figure. Rule frontmatter is read with the [skill-listing YAML subset](#skill-listings). For Claude, a `paths` string, flow list, or block list scopes the rule. Rule content is read for this even when the measurement needs only sizes.

`upFront: "unresolved"` marks a file that may be read up front but is counted on demand. The report counts these beside the figures. They are:

- a root rule whose frontmatter Strata cannot read, or whose `paths` or `alwaysApply` value it cannot interpret. Claude Code loads a rule whose YAML does not parse as if it had no `paths`, but Strata cannot tell a YAML error from YAML outside its subset.
- the root `.cursorrules`, whose loading Cursor's current documentation no longer describes.

A skill manifest that a Claude import reaches is counted both as an up-front file and by its listing.

### What the split does not resolve

- sessions started in a subdirectory, which load that directory's files and its parents';
- settings outside the repository, such as Claude Code's **Project instructions** setting that reads `AGENTS.md` beside `CLAUDE.md`, `claudeMdExcludes`, Codex's `project_doc_fallback_filenames`, and user, organization, or managed instructions;
- Codex's 32 KiB `project_doc_max_bytes` cap on instruction files;
- which Copilot client is in use;
- Copilot's `.claude/rules` and `.instructions.md` files whose `applyTo` matches every file;
- the names and descriptions some tools list up front for commands and agents, which Strata does not measure;
- imports in files Copilot or another tool reads, which only Claude Code expands.

### In the report and the command line

The HTML report's **At session start** panel shows, for the selected revision, each provider's up-front files, their tokens, the listed skill tokens, the up-front total, and the on-demand total, with the unresolved counts. It also names skipped files. In a provider view it shows that provider alone and lists the files it keeps up front. It always uses the report's measurement and the whole inventory, whatever the view counts with.

`strata analyze` prints each provider's figures at the last revision, and `strata diff` compares them between two commits. The history chart, SVG image, and badge keep to stored-text totals.

## Claude imports

Claude Code loads the files a `CLAUDE.md` imports with `@path` at launch, alongside it. So an instruction file's own size understates what it brings into context, and a configuration split across imported files would otherwise be invisible to Strata.

[The analysis scope](analysis-scope.md#claude-imports) lists the parsing and resolution rules. They follow [Claude Code's memory documentation](https://code.claude.com/docs/en/memory#import-additional-files) as read on 2026-10-18, which gives the four-hop limit, resolution against the importing file's directory, escaped spaces, quoted paths, and the code exclusions. The rest is Strata's reading of Claude Code's behavior, not documented: what counts as an import (an `@` at a line start or after whitespace), removing a `#` fragment, and which first characters make a path. The Markdown structure Strata recognizes is a documented subset.

The decisions that shape the data:

- **Resolved against Git, per revision.** A target resolves only to a tracked regular file at the same revision. Strata does not know where a repository is checked out, so absolute and home-directory imports are `external` rather than looked up on this machine, and none of their text is stored.
- **Measured where no path rule recognizes the file.** Imported text is loaded at launch like the importing file, so imported Markdown is measured as Claude instructions, in its own component rather than added to the importer. Other files Claude imports, such as `package.json`, are inventoried by bytes: they are loaded as text too, but structured files stay source-only until a text boundary is defined for them.
- **Recognized files keep their labels.** A file a path rule recognizes is counted once, as that rule says, even when imported. So an imported skill resource or other source-only Markdown file stays source-only. Relabeling a file by revision would let one file version carry two measurements.
- **Membership follows the imports.** An imported file is in the inventory exactly while an import reaches it. Adding or dropping an import therefore adds or removes the file at that revision, and the comparison shows the same, without the file having changed.
  - Imported files are found by a history read limited to their paths, without rename detection. `log.follow` is turned off, since it would turn rename following back on for a single path. So a moved imported file is a removal and an addition.
  - A Git pathspec (the path filter given to `git log`) also matches files under a directory of that name; only the requested paths are kept.
- **Edges are derived, not stored per revision.** What a file imports depends only on its content, so it is stored once per file version as `imports`: a 1-based line number, as evidence, and the resolved target path, never the import text.
  - A target is kept only when some regular file in the analyzed history has that path. An `@` followed by a word that is not a path, such as a person's handle in prose, is still an import to Claude Code, which finds no file. Storing it would put file text into a report that promises paths only, so such an import stays in the list as `missing` with a null target.
  - Whether an import resolves depends on the revision. `importLinks` derives each revision's `links to` edges from the rebuilt inventory alone, with their hop count, status, and an `external` flag that survives the depth limit. So analysis, the HTML report, and a JSON consumer agree, and a shareable report gives the same edges.
  - Roots are chosen by labels, not paths: first the Claude instructions that are not themselves imported, then each `agents-md` context file those chains did not reach. So an `AGENTS.md` that a `CLAUDE.md` imports counts its own imports from the second hop, as Claude Code does.
- **Unresolved imports are listed, not drawn.** `missing`, `external`, and `depth-limit` imports stay in the derived list with their status, and the report lists them first, so a broken import is visible instead of silently absent.

What this does not establish is which files a session loaded. Claude Code asks before loading external imports, skips files it cannot read as text, reads `AGENTS.md` only under conditions Strata does not resolve, and loads nested `CLAUDE.md` files only when it works in their directory. Imports in rules and other files are followed only when an import reaches them.

`strata diff` resolves imports in each of its two trees the same way and includes the imported files in its totals. The comparison marks them `imported`. A change that only adds or drops an import lists the file as added or removed, so the summary's file table adds "(imported)" to the change.

## Instruction age

Instruction age answers two questions: how much of a revision's instruction text dates from each earlier period, and how much of an older revision's text is still there. It follows the idea of git-of-theseus cohorts, where a cohort is the text first added in one period. It covers every component with stored text (`estimatedTokens` not null), across all files, whatever the provider view. Settings, MCP schemas, and other source-only files never take part.

### How lines are matched

Text is compared as lines:

- Each line is trimmed, so CRLF line endings and indentation do not matter. Blank lines are skipped.
- The rest are matched by exact text across all instructional files, ignoring paths and order. A line moved from a root instruction file into a skill therefore keeps its age, and so does a renamed file.
- Each copy of a line is followed separately and remembers the revision it first appeared at. When a revision has more copies of a line than before, the extra copies are new. When it has fewer, the newest copies go first, whichever file they left, so the text said to survive is the oldest.
- A reworded, rewrapped, or split line is a removal and an addition.
- A line that disappears and later comes back, as in a revert, is new again. Survival means continuous presence, like `git blame`.
- This follows the inventory. A file that is in it only because a Claude import reaches it loses its text's age when the import is dropped, even for one revision, although the file itself never changed.
- Matching is not semantic, so a short line such as `---` or a code fence can match a copy in another file by coincidence.

### Weighing and baseline

Lines are weighed by their trimmed stored bytes, the UTF-8 bytes for ordinary text. A long instruction counts more than a short one, and the result is the same whichever token measurement the report uses. Lines are split at the newline byte and matched by their bytes, so a file that is not valid UTF-8 keeps its distinct lines distinct. A UTF-16 file is still split at each newline byte, so its lines match only other UTF-16 copies. Bytes are not tokens: the figures are shares and byte counts, never added to `estimatedTokens`.

The baseline is the first analyzed revision, so in a shallow clone the oldest cohort holds everything before the clone starts. When `shallow` is true:

- if the first revision added instruction text, the HTML report labels the period holding it "or earlier";
- if the median (the date by which half of the text was in place) is that first revision, the HTML and the command line both give its date as "or earlier";
- if the first revision with instruction text is the first revision, both say the clone starts there.

### Stored data

A revision that added or removed lines carries `lineAge`:

- `added`: the bytes of copies new at that revision;
- `removed`: the bytes it removed, grouped by `from`, the index in `revisions` of the revision they had appeared at, oldest first.

Bytes only ever leave a cohort after the revision that added them. Replaying `lineAge` in order therefore gives each revision's text by origin; `instructionAges` in `src/instruction-age.ts` does this, and the HTML report embeds it. At a target revision, the bytes whose origin is at or before a baseline revision are exactly the baseline's text that stayed present the whole time. That gives survival between any two revisions without storing it.

A revision without `lineAge` moved no line, even if it changed, renamed, or added files. No line text or hash is stored, and `lineAgeMethod` (`exact-trimmed-line-multiset-stored-bytes-v1`) names the method. The byte counts can still tell a reader the length of an edited line, and that text was moved or copied between files rather than written anew, including in a shareable report.

### In the report

The HTML report draws the age of the text in a collapsed **Instruction age** panel, as a stacked bar for each charted revision:

- There is one layer per period, oldest at the bottom and darkest in light mode (lightest in dark mode).
- The period is the finest of week (from Monday), month, quarter, or year that gives at most eight layers. A history spanning more than eight years keeps one layer per year.
- Periods follow the author date as written, the date the report shows. After a rebase, an older-looking layer can hold text added at a later revision.
- The chart's first and last dates sit under it, as under the history chart. The matching rules sit behind a disclosure, as the token counting method does.
- Every layer keeps at least 3:1 contrast with the panel, so the selected bar is marked only under the axis, without the tint the history chart uses. The ends of the color ramp are about as far apart in lightness in both modes.
- Each layer's tooltip gives its period and share. On a narrow screen, a panel's summary drops below its heading.
- The legend gives the share of each period present at the selected revision.
- The heading gives the date by which half of the text was in place, and the share of the first instructional revision's text still there, naming that revision's date. In a provider tab it adds "all files".
- "Compare revisions" adds the share of the baseline's instruction text still present at the target, labeled "(all files)" in a provider tab.

The command line prints the same two figures for the last revision. Shares are whole percentages that never round a part to 0% or 100%. `instructionAges` keeps one replay position and the HTML asks for revisions in order, so drawing the panel takes one pass over the history whatever its length. `strata diff` compares two trees without their history, so it has no instruction age, and the static SVG image does not draw it.

## Revision comparison

The offline HTML report compares any two revisions present in the report. Schema versions 9 and 10 left comparison semantics unchanged; version 13 adds listed skill tokens beside the stored-text change.

### Choosing the revisions

- The timeline and the target selector refer to the same revision.
- The baseline selector starts on "Previous revision", which follows the target, so the comparison lists what the selected revision changed. Once a specific revision is chosen, the baseline stays fixed.
- Before the first revision, the baseline is empty.
- There is no separate list of changes at the selected revision. Like any comparison, this one shows a rename as a removal plus an addition and says so; the treemap's detail line still names a rename.

### History chart and slider

- The chart is capped at 100 bars. When needed it groups adjacent revisions and displays the last revision in each group. Each bar's tooltip and accessible name give the revision numbers it covers.
- The chart starts at the first revision that has a tracked file in the current view, and the date under its left edge is that revision's. Otherwise a repository that adopted agent configuration late would spend most of its bars on nothing.
- The slider covers the charted revisions, so it stays aligned with the bars. The baseline and target selectors still address every revision.
- While the slider is dragged, the summary, chart selection, legend, and treemap follow it immediately. The file inventory, comparison tables, imports table, and configuration map, which can hold thousands of rows, are redrawn once the slider settles or is released.
- Panels are not redrawn when moving between revisions that share the same inventory.
- The timeline legend gives each category's stored-text tokens at the selected revision, or its file count when the category is source-only. A source-only category's swatch is hollow, since nothing is drawn in its color. Selecting the entry opens the file list filtered to that category. There is no separate composition table.

### What the comparison shows

- Signed differences in estimated stored-text tokens and tracked file counts, grouped by provider and category. Groups with no difference are left out.
- No token percentage: it can be derived from the two totals and is meaningless against a zero-token baseline.
- Since version 19, one share, "Instruction text kept": the share of the baseline's instruction bytes still present at the target, always over all files (see [Instruction age](#instruction-age)). It is hidden when the baseline has no instruction text or is not before the target. A fixed baseline is marked on the instruction age chart as on the history chart.
- The per-component change table omits file-count deltas, because a single matched path can only be added (+1), removed (-1), or edited (0). Aggregate file deltas remain in the provider/category and summary comparisons.

### Provider views

The HTML view defaults to all tracked files, counted once. A provider view includes that provider's files and the shared files it reads, by `readers`:

- The Gemini view includes `AGENTS.md` and `GEMINI.md` only as each revision's `geminiContextFiles` (or its default) allows.
- The Cursor and Copilot views each include other tools' files only at revisions that track that tool's configuration.
- A shared-only view displays every shared file by itself.
- A provider that only appears as a reader, such as Codex in a repository whose only Codex files are under `.agents/skills`, still gets a view.

Shared files can occur in several provider views, so provider totals cannot be summed to recover the all-files total.

A view's membership can change without any file changing: when a settings change brings a context file into or out of the Gemini view, or when the first Cursor or Copilot file is added or the last one removed, bringing the other tools' files that tool reads into or out of its view. The view then lists those files as added or removed at that revision, and its comparisons do the same.

Switching views projects every report panel from the same stored JSON data and resets inventory filters. A move between providers appears as a removal in one view and an addition in the other. This is a display choice, not a claim about an agent's active or loaded context.

### Matching components

Components are matched by provider, category, and path. A changed blob at the same identity is shown as edited, even if its token estimate is unchanged. A renamed or reorganized file may appear as a removal and an addition; the comparison does not assert that instructions survived or that a refactor occurred. Source-only files affect file counts but contribute zero to estimated-token deltas.

## Composition treemap

The HTML report draws a treemap of the selected revision from the component measurements, grouped by category. A treemap divides a rectangle into smaller rectangles whose areas are proportional to their values. It is a view of stored configuration, not a map of runtime dependencies or loaded context.

### Layout

- Each instructional component with a positive token count gets a rectangle with an area proportional to its estimated stored-text tokens. Categories are contiguous and color-coded.
- Each category is a block in a darker shade of its color, separated from its neighbors by a gap. A block large enough to spare a band names its category and stored-text tokens there; smaller blocks rely on the timeline legend above, which uses the same colors. Thin seams of that shade separate the files inside a block.
- A category's block, band included, has an area proportional to its tokens, apart from the gaps. The files inside share what is left in proportion to each other.
- The treemap is laid out at its drawn size in pixels, so gaps and bands keep their size on any screen, and it is laid out again when resized.
- Layout aims for rectangles about twice as wide as tall, so a file name fits on one line where a square would break it.
- Source-only and zero-token components have no area and remain in the inventory. Their counts, with the categories of the source-only files, are on the line under the treemap, which gives way to a rectangle's details while it is hovered or focused.

### Labels

Interior labels use the skill directory name or the file name. They are checked against their rendered space, and again on resize. Names break only at hyphens, never mid-word. When a label does not fit:

1. When both lines do not fit, the token count is removed.
2. Then the name is reduced.
3. Then it is cut to one small line ending in an ellipsis.
4. It is removed only when even that cannot fit.

A tall, narrow rectangle sets its name top to bottom rather than breaking it mid-word.

### Changes and motion

- A rectangle whose file the selected revision added is outlined with a solid line, and one it edited or renamed with a dashed line. The detail line and accessible name say the same in words.
- The outline describes that one commit against its first parent, like the list of changes at this revision. Files a commit removed have no rectangle to mark.
- When the selected revision changes, each rectangle moves from its old place to its new one, and a file new to the view fades in. This is skipped when the system asks for reduced motion.

### Accessibility and the skill-bundle list

- Every rectangle has a hover/focus detail line and an accessible name with the full path and token count. There is no separate browser tooltip repeating it.
- Rectangles are keyboard-accessible and locate the matching inventory row. The table remains the text alternative.
- The skill-bundle list is collapsed under its heading, which gives the bundle count, and is left out when the revision has no skill bundles. When opened, it begins with eight rows and offers an explicit control to reveal the rest.

### Library

Rectangle layout uses the squarified treemap of `d3-hierarchy@3.1.2`. The generated report embeds the minified library and its ISC license, and calculates the selected revision's layout in the browser. It requires no network access or separate assets.

## Configuration map

The HTML report draws a configuration map of the selected revision: its files as a folder tree, with a line for each resolved Claude `@path` import between two of them. It answers where configuration sits and what links to what, which the category-grouped treemap does not. It is drawn from the rebuilt inventory and `importLinks`, so it needs no schema change and reads no file content. `configMap` in `src/config-map.ts`, which the report embeds, lays it out.

The map has two relationships and labels them as such:

- **Contains.** A folder holds the files under its path at that revision. Membership says nothing about loading, so the map never draws containment as a line. Folders come first, then files, each sorted by name with the same collation as the rest of the report. A folder that holds only one folder shares its row with it (`.claude/skills/review`). A folder row totals the files under it, its bar is split by category, and it counts its source-only files.
- **Links to.** A line runs from an importing file's row to the imported file's row, with the arrow at the imported file, for each `resolved` import from `importLinks`.
  - Imports are found from the whole inventory, as for the imports table and the up-front figures, but a line is drawn only when both files are in the selected view.
  - `missing`, `external`, and `depth-limit` imports are listed in the imports table and counted under the map, and on the importing row when that file is in the view, but never drawn. The first two have no tracked file to point at, and Claude Code does not follow the third.
  - A file that imports itself gets no line.
  - In another agent's tab, the note under the map says the lines are Claude's and do not show that agent following them.
  - Ordinary Markdown links, mentions of skills or agents by name, and rule globs are not drawn; [the architecture-view evaluation](architecture-view.md) explains why.

### Rows and folders

- Each row's bar is its share of the view's stored-text tokens at that revision, under the view's measurement. A source-only file, or a folder holding only source-only files, gets a hollow mark instead of a bar, and a zero-token file an empty one.
- The map opens folders one level at a time, as deep as it can while it keeps to 80 rows, and always opens the folders at the repository root.
- A reader can open or close any folder, and that choice holds across revisions and views. This also holds where folders share a row at one revision and not at another: opening a shared row opens each folder it stands for, closing it closes only the deepest, and the row is closed when any of them was closed.
- Two files that import each other get two lines, the upward one drawn wider.
- A closed folder takes the lines of the files it holds, drawn dashed. An import between two files of one closed folder has no line and is counted under the map.
- Files the selected revision added, edited, or renamed are tagged, and a closed folder counts its changed files.

### Keyboard and small screens

- The map is a tree (`role="tree"`) and one Tab stop. Arrow keys move between rows and open or close folders. Enter or Space toggles a folder or locates a file in the inventory.
- Hovering or focusing a row lights its lines and names, on the line under the map, what the file imports and what imports it, marking files outside the current view. Each row's accessible name carries the same detail.
- Rows are a fixed height, so lines are placed without measuring the page.
- On a narrow screen the line gutter narrows and row tags are hidden; the detail line and accessible name still give them.

A shareable report replaces paths with aliases that have no folders, so its map is a flat list with the same lines. The map is not an execution architecture: it does not show which files a session loaded, and it does not show configuration outside the repository.

## Report masthead

The HTML report's masthead names the analyzed repository and holds the figures for the selected revision. Its lower edge repeats the timeline as stepped category layers, following the same view, grouping, and scale as the chart beneath it. The layers use the chart's category colors and are decoration, hidden from assistive technology.

- The headline face, Archivo under the SIL Open Font License, and the page icon are inlined as `data:` URLs. The Content-Security-Policy therefore allows fonts and images from `data:` only; the report still loads nothing from the network.
- The Strata name in the masthead and footer links to the package's npm page. It is the report's only outbound link, is followed only on click, opens without a referrer, and is the same in every report, so it carries nothing about the analyzed repository.

[docs/brand](brand/README.md) describes the logo, colors, and type.

### Colors

- Category colors are shared by the HTML report and the SVG image. Instructions and skills take the brand's verdigris and clay hues, and the other categories are spaced around them.
- The set is checked so that categories adjacent in the stack stay distinguishable under protanopia and deuteranopia (the two common forms of red-green color blindness), and keep at least 3:1 contrast on both the light and the dark page background.
- Treemap labels are white or near-black, whichever contrasts more with the category color, or with its shade for a category band.
- Token and file changes are colored by direction only: ochre for growth and verdigris for reduction, in darker steps on the light background. Stored configuration growing is not a failure, so the report does not use red and green, and the sign always carries the direction.
- The report follows the system's light or dark setting; the masthead is the same in both.

### Tables and the measurement disclosure

- The tracked-components table is collapsed under its heading, which gives the file count. Selecting a treemap rectangle opens it. It starts open when Claude or Gemini was counted with `--precise`, because those per-provider counts appear only there. A Codex-only count, present on every run with Codex files, leaves it closed, so the default report looks as it did before Codex was counted by default.
- That table and the changed-components list show their first 25 rows, each with a control to show the rest. This limits what is drawn, not what is counted: totals, filters, and comparisons always cover every file.
- The measurement method and its limits sit behind a disclosure. Its visible label states that the figures describe what Git stores, not loaded session context.
- With provider counts, that label also names each provider's method in one word: `API count` for `api-counted` (Anthropic documents its count endpoint as an estimate, so the report does not call it exact), `exact (local)` for `encoding-exact`, or `estimate`.
- Opened, the disclosure shows one row per provider with the model, where the text was counted, and the credential source, or why the estimate was used. The full method is in the row's tooltip, and the selected view's provider is bold.
- A shallow-clone warning, a warning naming submodules that were not analyzed, and the notice that a shareable report replaced names and paths stay visible outside the disclosure.

## SVG image

`strata analyze --format svg` writes a static image of the history for a README or similar page. It draws the all-files view from the stored revision totals, so it needs no inventory replay.

What it draws:

- Each category with stored-text tokens is a stepped layer stacked on the previous ones in category order, using the HTML report's colors. The layers carry no outline: the top edge of the stack is the total.
- It follows the HTML timeline's rules: it starts at the first revision with a tracked file, holds at most 100 steps, and each step shows the last revision in its group.
- As in the HTML timeline, the vertical scale and legend cover every charted revision, so a peak or category inside a group is not dropped from them.
- Notes state when revisions were grouped and how many leading revisions without tracked configuration were left out. Axis steps are whole numbers.
- A header gives the latest token total, tracked-file count, revision count, and the token change since the first charted revision.
- The measurement label, a statement that this is stored configuration and not loaded session context or billing, and a shallow-clone warning when it applies are part of the image.

What it contains:

- The repository and branch names, the first and last charted dates, category labels, and totals.
- No paths, commit IDs, blob IDs, source text, script, links, or external resources, so it displays wherever SVG images are allowed, including GitHub READMEs.
- `--shareable` replaces the repository and branch names.
- Repository-derived text is XML-escaped, and characters XML cannot carry are removed.
- Text width is not measured, so the repository label is truncated to 60 characters and legend entries are placed by an estimated width.
- The output is deterministic for a given report: it contains no generation time.

Because the image is meant for publication, the CLI does not restrict it to mode `0600` as it does HTML and JSON reports. A new image gets the permissions the user's umask allows, and an existing file keeps its mode.

### Minimal image

`--minimal` reduces the image to the layers alone, for a banner or decorative use:

- It is 800 by 200 with a transparent background, and the layers fill it edge to edge. The tallest charted revision touches the top, so heights are relative and there is no axis to read a value from.
- It has no visible text, grid, legend, or notes. So it shows neither the measurement label nor the stored-configuration statement, nor the grouping, late-start, and shallow-clone notes. Use the full image where a reader needs to interpret the numbers.
- The bucketing, chart start, category order, and colors match the full image.
- Its accessible description names the measurement kind and the latest totals.
- It contains no repository or branch name and no dates, so `--shareable` does not change it.
- `--minimal` with another format is a usage error.

## Badge

`strata analyze --format badge` writes a small JSON file in the [shields.io endpoint schema](https://shields.io/badges/endpoint-badge) (`schemaVersion: 1`). A README can then show the latest stored-text total as a badge through `https://img.shields.io/endpoint?url=<published file>`.

- The label is `agent context`. The message is the latest revision's token total, prefixed with `≈` unless the measurement is encoding-exact, so an estimate is never shown as an exact count.
- The colors are the Strata palette. Shields' own query parameters can override the label, colors, and style without a Strata option.
- The file holds the number and its kind only: no repository or branch name, path, commit ID, date, or source text. So `--shareable` does not change it.
- Like the image, it is meant for publication and is written with ordinary file permissions.

The badge is a stored-configuration figure like every other Strata total, not loaded context or billing; the surrounding README should say so where it matters.

## Pull-request comparison

`strata diff` compares two supplied full commit IDs by reading their tracked Git trees directly. It does not check out revisions or write into the target repository. It uses the same path classification, instructional-text boundary, and measurement as the history report.

Its JSON has its own schema version, currently 13. Compared components carry the report's provider labels (so `.agents/skills` files are `shared`), and there are no provider views.

| Version | Adds |
| --- | --- |
| 5 | With `--precise`, `providerMeasurements` and `providerTotals` (see [Measurement](#measurement)). |
| 6 | The comparison's `skillListing` totals, with the manifests at each side and the unresolved ones the totals leave out, and a `listing` on each changed skill manifest, measured as in [Skill listings](#skill-listings). The Markdown adds a listed-token line when either commit has a skill manifest, and a `Δ listed` column when a manifest changed. |
| 7 | Cursor files, so compared components and `byProvider` can carry `cursor`, and a changed `.cursorrules` carries `legacy: true`. The same two commits can give larger totals than under version 6. |
| 8 | Copilot files in the same way, with `copilot`, and `legacy: true` on a changed `.chatmode.md`. |
| 9 | Claude `@path` imports resolved in each tree, so files they reach are compared too and carry `imported: true`; the Markdown file table adds "(imported)" to their change. Totals can be larger than under version 8. |
| 10 | `upFront`: for each provider that reads stored text at either commit, its [up-front and on-demand totals](#up-front-context) at both, with the file count and unresolved counts. The Markdown adds a table of the providers whose figures changed, or a line saying none did. |
| 11 | `mcp` when either commit has a component with an [MCP server list](#mcp-servers): the servers at both, the files whose servers could not be read, and the servers `added` and `removed`, each with its name, path, and provider. The Markdown adds a line naming up to ten of each. |
| 12 | `limits` when a [limit](#limits) is set. |
| 13 | `providerMeasurements` and `providerTotals` for Codex without `--precise`, counted locally with `o200k_base`; the Markdown adds the provider table on every comparison that has Codex files. `--tokenizer` and `--model` are removed, so `measurement` is always the byte estimate. |

`strata diff` resolves each commit's Gemini settings to decide which context files Gemini reads, for its up-front totals and, with `--precise`, its provider totals.

The Markdown output is intended for a local file or an opt-in GitHub Actions job summary. Paths and commit IDs are visible, but source text is not. The composite Action does not post comments; it fails or warns only on a limit set in its inputs.

## Limits

Limits are opt-in. Nothing is checked unless a limit is given, and none is set by default, because a growing configuration is not a worse one: a limit only compares a figure with a number the user chose. The Markdown table and the messages say "over" and "within", not "failed" or "regression", and the Markdown states that being over a limit does not mean the configuration got worse.

| Option | `strata diff` | `strata analyze` |
| --- | --- | --- |
| `--limit-tokens` | yes | yes, at the last revision |
| `--limit-increase` | yes | no |
| `--limit-up-front-tokens` | yes | yes, at the last revision |
| `--limit-up-front-increase` | yes | no |

- **Tokens only.** Every limit is a whole number of tokens. Percentage limits were considered and left out: a percentage cannot be taken from a zero base, needs exact decimal comparison, and needs rounding that never contradicts its result, while a token limit has none of these cases. The percentage change is still shown beside each increase.
- **Figures.** `--limit-tokens` and `--limit-increase` use the stored instructional text total, the same `comparison` or revision total the run reports. The session-start limits use each agent's `tokens` from [up-front context](#up-front-context): listed files plus skill listings, for a session at the repository root. All limits use the byte estimate. Provider counts (Codex's, and those from `--precise`) are not used, so a limit means the same with or without network access. A source-only file adds nothing to any limit.
- **Agents.** A session-start limit without an agent applies to every agent that keeps text at session start (up-front tokens or files) at either commit, or, in `analyze`, at the last revision. An agent that only reads on demand has nothing to limit. `agent=n` sets one agent's limit and replaces the general one for that agent; it is checked even when that agent keeps nothing at session start, as zero tokens. When the general limit applies to no agent, it gives one entry that says why: `no-agent` when no agent keeps text at session start, `replaced` when each agent that does has its own limit. A limit that was set is never silently dropped.
- **Comparisons.** A figure is over its limit when it is strictly greater. An absolute limit compares the head value. An increase limit compares head minus base, so a decrease is always within.

### Exit status and output

- A run with a limit passed exits with status 3 after writing its full output. This is distinct from 1 (failure) and 2 (invalid command line).
- `analyze` reports limits before `--open` opens the report. A failure after a limit was reported as passed, such as a viewer that fails to open, keeps status 3, so it cannot hide a passed limit.
- `--on-limit warn` reports the same and exits with 0.
- Each passed limit prints an `Over limit:` line on standard error, and each limit not applied a `Limit not applied:` line, also under `--quiet`.
- `--limit-annotations` adds a GitHub Actions workflow command for each `Over limit:` line (`error`, or `warning` under `--on-limit warn`) and a `warning` for each `Limit not applied:` line. They are built from the checks rather than from the text, with `%`, CR, and LF escaped.
- A `--precise --dry-run` still takes the local measurement, so it checks limits and exits as a full run would.
- `strata analyze` adds nothing to its report, whose schema is unchanged.
- `strata diff` puts a table of every limit at the top of its Markdown.

`strata diff` also adds the `limits` array to its JSON (since schema version 12). Each entry has:

| Field | Value |
| --- | --- |
| `name` | the option without its dashes, such as `limit-tokens` |
| `agent` | the agent, or `null` for the total and when not applied |
| `limit` | the number set |
| `before` | the base value, or `null` for `analyze` and when not applied |
| `after` | the head value, or `null` when not applied |
| `result` | `within`, `over`, `no-agent`, or `replaced` |

### In the composite Action

Inputs and limits:

- The composite Action takes `limit-tokens`, `limit-increase`, `limit-up-front-tokens`, `limit-up-front-increase` (several `agent=n` entries separated by spaces or commas), and `on-limit`.
- With a limit set, it passes them on with `--on-limit` and `--limit-annotations`, so Strata validates `on-limit` and writes the annotations. Without one, `on-limit` is ignored.
- Strata's output streams to the log as the run goes. The Action writes the job summary, then fails the step only on a passed limit under `fail`. It writes no summary when Strata itself fails.

Which commits it compares, when `base` and `head` are empty:

| Event | Commits compared |
| --- | --- |
| `pull_request`, its review events, and `pull_request_target` | GitHub's merge commit and its first parent, the base branch's tip. Changes the base branch made after the pull request branched are therefore not counted, reversed, as the pull request's. Without a merge commit whose second parent is the pull request's head, it compares the two tips and warns. |
| `merge_group` | the queued commit and its base |
| `push` | the commits before and after; a push that creates or deletes a branch or tag is skipped with a notice |

Fetching and outputs:

- It fetches any commit the checkout lacks from `origin`, at depth 1 in a shallow checkout. That fetch is the Action's, not Strata's. It adds Git objects and shallow-list entries to the job's `.git` and updates `FETCH_HEAD`, with automatic garbage collection off. It changes no working-tree file, branch, or tag, so Strata itself still only reads.
- It runs one comparison with `--json-output` and sets its outputs (`tokens`, `delta-tokens`, `limit-result`, `summary-file`, `json-file`) from the JSON, in a directory of its own per run. `limit-result` counts a limit that applied to no agent as not checked.
- It builds Strata from its own source with the lockfile rather than installing the npm package. The build takes a few seconds, and the npm package's dependencies would be resolved afresh on each run.
