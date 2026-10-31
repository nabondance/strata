# Token-counting methods

Strata counts the instructional text stored in Git blobs, Git's stored copy of each file version. No method shows which files an agent loaded, or the tokens billed for a session.

## Default and local methods

The default method is `utf8-bytes-divided-by-four-v1`: `ceil(UTF-8 bytes / 4)` per instructional file, that is, the file's size in bytes divided by four and rounded up, summed across files and revisions. It is a comparison estimate, not a provider tokenizer.

It is the only method for totals, charts, comparisons, and limits, for every provider, and there is no option to change it.

Files Codex reads are also counted on every run with OpenAI's `o200k_base` encoding, through the `js-tiktoken@1.0.21` package. Every current OpenAI model (GPT-4o, GPT-4.1, GPT-5, o3, o4-mini, and Codex) uses that encoding, so Strata does not ask for a model name. These counts are Codex's own totals, shown beside the estimate, never in place of it.

They are encoding-exact for valid UTF-8 stored text: they match what the encoding produces for that text. They leave out message framing and special-token handling, so they are not complete request, loaded-context, or billing counts.

The estimate and the Codex count run offline. They do not send Git content to a service.

## Precise mode

`strata analyze --precise` opts into sending recognized Claude and Gemini instructional text to provider count endpoints, when it finds a credential. This includes Markdown that a Claude `@path` import reaches. For each provider, Strata tries these methods in order:

- **Claude**: a signed-in account (`ant auth login`), then the `ANTHROPIC_API_KEY` API key, then the byte estimate. With neither an `ant` account nor `ANTHROPIC_API_KEY`, a ready `gcloud` account can count Claude through Vertex AI.
- **Gemini**: a signed-in `gcloud` account with a project, through Vertex AI, then the `GEMINI_API_KEY` or `GOOGLE_API_KEY` API key, then the byte estimate.
- **Codex**: counted locally with `o200k_base`, as on every run.

Models default to `claude-opus-5-5` and `gemini-3.8-flash`. Strata does not guess a model from file paths. [The decision record](decisions.md#measurement) gives the full fallback order, the wrapper measurement, retries, and the count cache, and explains why Claude Code, Gemini CLI, and ChatGPT sign-ins are not used.

### What is sent and how counts are labeled

- Claude text is sent in one user message to [Anthropic's Messages count endpoint](https://platform.claude.com/docs/en/api/messages/count_tokens).
- Gemini text is sent as one user content to [Gemini's `models.countTokens` endpoint](https://ai.google.dev/api/tokens) or, with a `gcloud` account, [Vertex AI's `countTokens`](https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/count-tokens).
- The report labels every count with its provider, model, request shape/method, API or library version, and accuracy (`api-counted`, `encoding-exact`, or `estimate`).
- With `--precise`, each count leaves out the endpoint's one-message wrapper: the tokens the request adds around the text. Strata measures it once per model by counting the letter `a`, and records it as `wrapperTokens`.
- Blank files are counted as zero without a request.
- API counts describe stored text, not actual agent context or billing.

### Shared files and totals

- Shared instruction files are counted separately for each selected provider that reads them: `AGENTS.md` for Claude and Codex, and `.agents/skills` manifests for Gemini and Codex.
- Gemini counts for `AGENTS.md` and `GEMINI.md` follow `context.fileName` in `.gemini/settings.json` (default: `GEMINI.md` only). A version is sent to Gemini only if it is in a revision where Gemini reads it. A revision's Gemini total includes it only while Gemini reads it.
- Per-provider counts and revision totals stay separate. Strata does not add counts from different providers together.
- The legacy `estimatedTokens` value and the timeline stay on the default comparison estimate in this mode.
- The HTML inventory shows a separate column for each provider, and JSON stores a count object for each provider on each recognized instructional component.

### Caching and privacy

- Counts are requested once per provider, model, and Git blob in a run. They are kept between runs in a local cache of blob IDs and counts; `--no-cache` opts out.
- Structured settings and source-only skill resources are never sent.
- Source text is not embedded in HTML or JSON.
- `strata diff --precise` uses the same methods.
- `--shareable` replaces identifiers in the report with aliases, but does not prevent the transfer when `--precise` is selected.

## Evidence and limits

| Family         | Method                               | Evidence / interpretation                                                                                                                                                                                                                                            |
| -------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI / Codex | Local `js-tiktoken@1.0.21` encodings | [OpenAI's tiktoken](https://github.com/openai/tiktoken) documents model-to-encoding mappings. The [JavaScript port](https://github.com/dqbd/tiktoken/blob/main/js/README.md) runs locally in Node.                                                                   |
| Claude         | Explicit API mode                    | Anthropic's [count endpoint](https://platform.claude.com/docs/en/api/messages/count_tokens) counts tokens for a supplied Message request. Older local tokenizer packages state that they are inaccurate for Claude 3 and later, so Strata does not label them exact. |
| Gemini         | Explicit API mode                    | Google's [`models.countTokens`](https://ai.google.dev/api/tokens) runs the selected model's tokenizer on supplied Content. Third-party offline Gemma tokenizers are not treated as exact Gemini counts.                                                              |

The local OpenAI encoding and the byte estimate were compared on short synthetic strings. The samples show that methods differ; they do not establish that one predicts another provider's tokenizer.

| Sample                   | bytes/4 estimate | o200k_base |
| ------------------------ | ---------------: | ---------: |
| Short instruction        |                8 |          5 |
| Skill manifest           |               19 |         17 |
| Multilingual instruction |               15 |         15 |
| Code snippet             |               14 |         14 |
