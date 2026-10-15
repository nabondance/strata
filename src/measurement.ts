import { Tiktoken } from "js-tiktoken/lite";
import cl100kBase from "js-tiktoken/ranks/cl100k_base";
import o200kBase from "js-tiktoken/ranks/o200k_base";

export type MeasurementMode = "estimate" | "openai-cl100k_base" | "openai-o200k_base";

export const modelEncodings = {
  "gpt-4": "openai-cl100k_base",
  "gpt-4o": "openai-o200k_base",
  "gpt-4.1": "openai-o200k_base",
  "gpt-5": "openai-o200k_base",
  o3: "openai-o200k_base",
  "o4-mini": "openai-o200k_base",
} as const satisfies Record<string, MeasurementMode>;

/**
 * Model-name prefixes that share an encoding, following tiktoken's `MODEL_PREFIX_TO_ENCODING`, so
 * dated or variant names such as `gpt-5-codex` or `gpt-4o-mini` resolve. Only families whose
 * encoding Strata ships are listed; `gpt-oss-` uses `o200k_harmony` and stays unsupported.
 */
export const modelPrefixEncodings = {
  "gpt-5": "openai-o200k_base",
  "gpt-4.1-": "openai-o200k_base",
  "gpt-4o-": "openai-o200k_base",
  "o3-": "openai-o200k_base",
  "o4-mini-": "openai-o200k_base",
  "gpt-4-": "openai-cl100k_base",
} as const satisfies Record<string, MeasurementMode>;

export function modeForModel(model: string): MeasurementMode {
  if (Object.hasOwn(modelEncodings, model)) return modelEncodings[model as keyof typeof modelEncodings];
  const prefix = Object.keys(modelPrefixEncodings).find((candidate) => model.startsWith(candidate));
  if (prefix) return modelPrefixEncodings[prefix as keyof typeof modelPrefixEncodings];
  throw new Error(
    `Unsupported model: ${model}. Choose ${Object.keys(modelEncodings).join(", ")}, a name starting with ${Object.keys(modelPrefixEncodings).join(", ")}, or an explicit --tokenizer encoding.`,
  );
}

export interface Measurement {
  label: string;
  method: string;
  limitations: string;
  family: "generic" | "openai";
  accuracy: "estimate" | "encoding-exact";
  encoding: string | null;
  model: string | null;
  implementation: string;
}

/** Recorded in report metadata; a test keeps it equal to the installed dependency version. */
export const tiktokenImplementation = "js-tiktoken@1.0.21";

export interface Measurer {
  measurement: Measurement;
  count: (blob: Buffer) => number;
  /** Present when the count depends only on byte length, so blob content never needs to be read. */
  countFromSize?: (bytes: number) => number;
}

const maxCachedPieces = 500_000;

/**
 * Count tokens exactly as `encode(text, [], [])` would, one regex piece at a time, remembering
 * each distinct piece. An encoding splits text into pieces with its pattern and encodes every
 * piece independently, so the total is the sum over pieces. js-tiktoken's merge loop is far
 * worse than linear in piece length (a 1,000-space run of table padding takes about 60 ms), and
 * successive versions of a file repeat almost all of their pieces, so the cache removes nearly
 * all of that cost. Special-token text such as "<|endoftext|>" is counted as ordinary text.
 */
function pieceCounter(ranks: ConstructorParameters<typeof Tiktoken>[0]): (text: string) => number {
  const tokenizer = new Tiktoken(ranks);
  const pieces = new RegExp(ranks.pat_str, "ug");
  const alone = new RegExp(ranks.pat_str, "uy");
  const counts = new Map<string, number>();
  const whole = (text: string) => tokenizer.encode(text, [], []).length;
  return (text) => {
    let total = 0;
    for (const [piece] of text.matchAll(pieces)) {
      let count = counts.get(piece);
      if (count === undefined) {
        // Encoding a piece by itself is only equivalent if the pattern still sees it as one piece.
        alone.lastIndex = 0;
        if (alone.exec(piece)?.[0] !== piece) return whole(text);
        count = whole(piece);
        if (counts.size >= maxCachedPieces) counts.clear();
        counts.set(piece, count);
      }
      total += count;
    }
    return total;
  };
}

export function createMeasurer(mode: MeasurementMode, model: string | null = null): Measurer {
  if (model && modeForModel(model) !== mode) throw new Error(`Model ${model} does not use ${mode}`);
  if (mode === "estimate") {
    return {
      measurement: {
        label: "Estimated stored-text tokens",
        method: "utf8-bytes-divided-by-four-v1: UTF-8 bytes / 4, rounded up per instructional file",
        limitations:
          "Comparison estimate only. This is not a provider tokenizer or measured session context. Structured configuration and supporting files are counted in bytes, not prompt tokens.",
        family: "generic",
        accuracy: "estimate",
        encoding: null,
        model: null,
        implementation: "strata-v1",
      },
      count: (blob) => Math.ceil(blob.length / 4),
      countFromSize: (bytes) => Math.ceil(bytes / 4),
    };
  }
  if (mode !== "openai-cl100k_base" && mode !== "openai-o200k_base") {
    throw new Error(`Unsupported tokenizer mode: ${mode}`);
  }
  const encoding = mode === "openai-cl100k_base" ? "cl100k_base" : "o200k_base";
  const countText = pieceCounter(encoding === "cl100k_base" ? cl100kBase : o200kBase);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return {
    measurement: {
      label: `Stored-text tokens under ${model ?? `OpenAI ${encoding}`}`,
      method: `${tiktokenImplementation}: ${model ? `${model} → ` : ""}${encoding}, counted per instructional file`,
      limitations:
        "Exact for this text encoding, not a complete model request, loaded context, or billed tokens. Special-token and message framing are excluded. Structured configuration and supporting files remain source-only.",
      family: "openai",
      accuracy: "encoding-exact",
      encoding,
      model,
      implementation: tiktokenImplementation,
    },
    count: (blob) => countText(decoder.decode(blob)),
  };
}
