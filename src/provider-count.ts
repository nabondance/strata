import { tiktokenImplementation } from "./measurement.js";

export type RemoteProvider = "claude" | "gemini";

export interface ProviderTextCount {
  tokens: number;
  provider: RemoteProvider | "codex";
  model: string;
  method: string;
  version: string;
  accuracy: "api-counted" | "encoding-exact";
}

export interface ProviderMeasurementMetadata {
  provider: ProviderTextCount["provider"];
  model: string;
  method: string;
  version: string;
  accuracy: ProviderTextCount["accuracy"];
}

export function providerMeasurementMetadata(options: ProviderCountOptions): ProviderMeasurementMetadata[] {
  const result: ProviderMeasurementMetadata[] = [
    {
      provider: "claude",
      model: options.claudeModel,
      method: "POST /v1/messages/count_tokens with one user text message",
      version: "Anthropic API 2023-06-01",
      accuracy: "api-counted",
    },
    {
      provider: "gemini",
      model: options.geminiModel,
      method: "POST models.countTokens with one user text content",
      version: "Gemini API v1beta",
      accuracy: "api-counted",
    },
  ];
  if (options.codexModel) {
    result.push({
      provider: "codex",
      model: options.codexModel,
      method: `${tiktokenImplementation} model encoding, counted per instructional file`,
      version: tiktokenImplementation,
      accuracy: "encoding-exact",
    });
  }
  return result;
}

export interface ProviderCountOptions {
  claudeModel: string;
  geminiModel: string;
  codexModel?: string;
  anthropicApiKey?: string;
  geminiApiKey?: string;
  fetchImpl?: typeof fetch;
}

async function postCount(
  provider: RemoteProvider,
  model: string,
  apiKey: string,
  body: unknown,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const isClaude = provider === "claude";
  const geminiModel = model.startsWith("models/") ? model.slice("models/".length) : model;
  const url = isClaude
    ? "https://api.anthropic.com/v1/messages/count_tokens"
    : `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:countTokens`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (isClaude) {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers["x-goog-api-key"] = apiKey;
  }
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error(`${provider} token count request failed to connect`);
  }
  if (!response.ok) throw new Error(`${provider} token count request failed with HTTP ${response.status}`);
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new Error(`${provider} token count request returned invalid JSON`);
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error(`${provider} token count request returned an invalid response`);
  }
  return result as Record<string, unknown>;
}

export async function countProviderText(
  provider: RemoteProvider,
  model: string,
  text: string,
  options: ProviderCountOptions,
): Promise<ProviderTextCount> {
  const apiKey = provider === "claude" ? options.anthropicApiKey : options.geminiApiKey;
  if (!apiKey) {
    const variable = provider === "claude" ? "ANTHROPIC_API_KEY" : "GEMINI_API_KEY (or GOOGLE_API_KEY)";
    throw new Error(`Provider API counting for ${provider} requires ${variable}`);
  }
  const isClaude = provider === "claude";
  const body = isClaude
    ? { model, messages: [{ role: "user", content: text }] }
    : { contents: [{ role: "user", parts: [{ text }] }] };
  const result = await postCount(provider, model, apiKey, body, options.fetchImpl ?? fetch);
  const tokens = isClaude ? result.input_tokens : result.totalTokens;
  if (typeof tokens !== "number" || !Number.isSafeInteger(tokens) || tokens < 0) {
    throw new Error(`${provider} token count response did not contain a valid token count`);
  }
  return {
    tokens,
    provider,
    model,
    method: isClaude
      ? "POST /v1/messages/count_tokens with one user text message"
      : "POST models.countTokens with one user text content",
    version: isClaude ? "Anthropic API 2023-06-01" : "Gemini API v1beta",
    accuracy: "api-counted",
  };
}
