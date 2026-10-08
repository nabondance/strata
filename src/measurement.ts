import { getEncoding } from "js-tiktoken";

export type MeasurementMode = "estimate" | "openai-cl100k_base" | "openai-o200k_base";

export interface Measurement {
  label: string;
  method: string;
  limitations: string;
  family: "generic" | "openai";
  accuracy: "estimate" | "encoding-exact";
  encoding: string | null;
  implementation: string;
}

export function createMeasurer(mode: MeasurementMode): { measurement: Measurement; count: (blob: Buffer) => number } {
  if (mode === "estimate") {
    return {
      measurement: {
        label: "Estimated stored-text tokens",
        method: "utf8-bytes-divided-by-four-v1: UTF-8 bytes / 4, rounded up per instructional file",
        limitations: "Comparison estimate only. This is not a provider tokenizer or measured session context. Structured configuration and supporting files are counted in bytes, not prompt tokens.",
        family: "generic", accuracy: "estimate", encoding: null, implementation: "strata-v1",
      },
      count: (blob) => Math.ceil(blob.length / 4),
    };
  }
  if (mode !== "openai-cl100k_base" && mode !== "openai-o200k_base") {
    throw new Error(`Unsupported tokenizer mode: ${mode}`);
  }
  const encoding = mode === "openai-cl100k_base" ? "cl100k_base" : "o200k_base";
  const tokenizer = getEncoding(encoding);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return {
    measurement: {
      label: `Stored-text tokens under OpenAI ${encoding}`,
      method: `js-tiktoken@1.0.21: ${encoding}, counted per instructional file`,
      limitations: "Exact for this text encoding, not a complete model request, loaded context, or billed tokens. Special-token and message framing are excluded. Structured configuration and supporting files remain source-only.",
      family: "openai", accuracy: "encoding-exact", encoding, implementation: "js-tiktoken@1.0.21",
    },
    count: (blob) => tokenizer.encode(decoder.decode(blob)).length,
  };
}
