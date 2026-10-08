# Local token-counting study

Recorded 2026-10-08 for the optional measurement mode. Strata measures **stored instruction text** in Git blobs. Even an exact text encoding count does not establish which files an agent loaded or the tokens billed for a session.

| Family | Local option | Current evidence and decision |
| --- | --- | --- |
| OpenAI / Codex | [OpenAI `tiktoken`](https://github.com/openai/tiktoken) provides model-to-encoding mappings. [The `js-tiktoken` port](https://github.com/dqbd/tiktoken/blob/main/js/README.md) runs locally in Node without WASM. | Offer an explicit encoding-based mode, pinned to a library version. Label the result as a text count under that encoding; do not claim it is a full request or session count. |
| Claude | [Anthropic's archived TypeScript tokenizer](https://github.com/anthropics/anthropic-tokenizer-typescript) says it is inaccurate for Claude 3 onward. [Anthropic's current count-tokens endpoint](https://platform.claude.com/docs/en/build-with-claude/token-counting) is free but requires API access and sends content. | Keep a clearly labeled local estimate by default. Do not silently call the API or label the archived tokenizer as accurate for current Claude models. |
| Gemini | [Google documents `countTokens`](https://ai.google.dev/gemini-api/docs/tokens) as a model-specific API request. The third-party [`token-count` CLI](https://github.com/shaunburdick/token-count) claims exact offline Gemini counts using a Gemma 3 tokenizer, but the cited Google documentation does not establish equivalence with Gemini's tokenizer. | Keep a clearly labeled local estimate until an offline tokenizer is validated against Google's endpoint for named model versions. Do not present Gemma counts as exact Gemini counts. |

`js-tiktoken@1.0.21` is MIT-licensed and was 22.4 MB unpacked in the npm registry on the study date. Its local `cl100k_base` and `o200k_base` counts were compared with the current UTF-8-byte estimate on four short synthetic snippets:

| Sample | bytes/4 estimate | cl100k_base | o200k_base |
| --- | ---: | ---: | ---: |
| Short instruction | 8 | 5 | 5 |
| Skill manifest | 19 | 17 | 17 |
| Multilingual instruction | 15 | 18 | 15 |
| Code snippet | 14 | 14 | 14 |

These samples establish that the methods differ, not that one predicts another provider's counts. The first implementation should keep `utf8-bytes-divided-by-four-v1` as the default for reproducible offline history, add an opt-in OpenAI text-encoding mode, record encoding and implementation version in the report, and cache counts by blob within a run. Structured configuration and skill resources remain source-only. A remote count mode would require explicit user choice, credentials, content-transfer disclosure, and separate testing before implementation.
