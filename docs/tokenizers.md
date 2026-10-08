# Token-counting methods

Strata counts stored instructional text from Git blobs. No method establishes which files an agent loaded or the tokens billed for a session.

## Default and local methods

The default is `utf8-bytes-divided-by-four-v1`: `ceil(UTF-8 bytes / 4)` per instructional file, summed across files and revisions. It is a comparison estimate, not a provider tokenizer.

OpenAI/Codex local counts use `js-tiktoken@1.0.21`. `--tokenizer openai-cl100k_base` and `openai-o200k_base` select an encoding. `--model` maps the supported model names (`gpt-4`, `gpt-4o`, `gpt-4.1`, `gpt-5`, `o3`, `o4-mini`) to the encoding documented by [OpenAI's tiktoken model map](https://github.com/openai/tiktoken/blob/main/tiktoken/model.py). These counts are encoding-exact for valid UTF-8 stored text, but exclude message framing and special-token handling. They are not complete request, loaded-context, or billing counts.

All default and local methods run offline. They do not send Git content to a service.

## Explicit provider API mode

`strata analyze --provider-api --claude-model <model> --gemini-model <model>` opts into sending recognized Claude and Gemini instructional text to provider endpoints. Set `ANTHROPIC_API_KEY` and `GEMINI_API_KEY` (or `GOOGLE_API_KEY`). `--codex-model <openai-model>` optionally adds a local OpenAI encoding count for Codex instructions. The provider models must be named explicitly; Strata does not infer a model from file paths.

Claude text is sent in one user message to [Anthropic's Messages count endpoint](https://platform.claude.com/docs/en/api/messages/count_tokens). Gemini text is sent as one user content to [Gemini's `models.countTokens` endpoint](https://ai.google.dev/api/tokens). The report labels every count with its provider, model, request shape/method, API or library version, and accuracy (`api-counted` or `encoding-exact`). API counts reflect those submitted text wrappers, not actual agent context or billing.

Shared instruction candidates are counted separately for each selected provider. Per-provider counts and revision totals remain separate; Strata does not add heterogeneous token counts. The legacy `estimatedTokens` value and timeline remain the default comparison estimate in this mode. The HTML inventory displays separate provider columns, and JSON stores a count object for each provider on each recognized instructional component.

Counts are cached by provider, model, and Git blob within one run. Structured settings and source-only skill resources are never submitted. Source text is not embedded in HTML or JSON. `strata diff` remains local-only. `--shareable` reduces identifiers in the report but does not prevent transfer when provider API mode is selected.

## Evidence and limits

| Family | Method | Evidence / interpretation |
| --- | --- | --- |
| OpenAI / Codex | Local `js-tiktoken@1.0.21` encodings | [OpenAI's tiktoken](https://github.com/openai/tiktoken) documents model-to-encoding mappings. The [JavaScript port](https://github.com/dqbd/tiktoken/blob/main/js/README.md) runs locally in Node. |
| Claude | Explicit API mode | Anthropic's [count endpoint](https://platform.claude.com/docs/en/api/messages/count_tokens) counts tokens for a supplied Message request. Older local tokenizer packages state that they are inaccurate for Claude 3 and later, so Strata does not label them exact. |
| Gemini | Explicit API mode | Google's [`models.countTokens`](https://ai.google.dev/api/tokens) runs the selected model's tokenizer on supplied Content. Third-party offline Gemma tokenizers are not treated as exact Gemini counts. |

Local OpenAI encodings and the default byte estimate were compared on short synthetic strings. The samples show that methods differ; they do not establish that one predicts another provider's tokenizer.

| Sample | bytes/4 estimate | cl100k_base | o200k_base |
| --- | ---: | ---: | ---: |
| Short instruction | 8 | 5 | 5 |
| Skill manifest | 19 | 17 | 17 |
| Multilingual instruction | 15 | 18 | 15 |
| Code snippet | 14 | 14 | 14 |
