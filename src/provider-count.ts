import { tiktokenImplementation } from "./measurement.js";

export type RemoteProvider = "claude" | "gemini";
export type CountedProvider = RemoteProvider | "codex";

export interface ProviderTextCount {
  tokens: number;
  provider: CountedProvider;
  /** Null for the byte estimate, which does not depend on a model. */
  model: string | null;
  method: string;
  version: string;
  accuracy: "api-counted" | "encoding-exact" | "estimate";
}

export interface ProviderMeasurementMetadata {
  provider: CountedProvider;
  model: string | null;
  method: string;
  version: string;
  accuracy: ProviderTextCount["accuracy"];
  /** Where the credential came from, such as `ANTHROPIC_API_KEY`; never the credential itself. */
  credential?: string;
  /** The host that received instruction text. Absent when counting stayed on this machine. */
  recipient?: string;
  /** Why each more precise method was not used, in the order they were considered. */
  fallbacks?: string[];
}

/** One way to count a provider's instruction text. A plan tries a provider's methods in order. */
export type CountMethod =
  | { kind: "anthropic"; model: string; auth: "x-api-key" | "bearer"; secret: string; credential: string }
  | { kind: "gemini-api"; model: string; secret: string; credential: string }
  | { kind: "vertex"; model: string; secret: string; project: string; location: string; credential: string }
  | { kind: "local"; model: string }
  | { kind: "estimate" }
  /** A more precise method that was ruled out before the run, reported as a fallback. */
  | { kind: "unavailable"; reason: string };

export interface ProviderCountPlan {
  methods: Partial<Record<CountedProvider, CountMethod[]>>;
  fetchImpl?: typeof fetch;
}

/** The `--provider-api` options: explicit models and API keys, with no fallback. */
export interface ProviderCountOptions {
  claudeModel: string;
  geminiModel: string;
  codexModel?: string;
  anthropicApiKey?: string;
  geminiApiKey?: string;
  fetchImpl?: typeof fetch;
}

export function providerApiPlan(options: ProviderCountOptions): ProviderCountPlan {
  if (!options.anthropicApiKey) throw new Error("Provider API counting for claude requires ANTHROPIC_API_KEY");
  if (!options.geminiApiKey)
    throw new Error("Provider API counting for gemini requires GEMINI_API_KEY (or GOOGLE_API_KEY)");
  const methods: ProviderCountPlan["methods"] = {
    claude: [
      {
        kind: "anthropic",
        model: options.claudeModel,
        auth: "x-api-key",
        secret: options.anthropicApiKey,
        credential: "ANTHROPIC_API_KEY",
      },
    ],
    gemini: [
      {
        kind: "gemini-api",
        model: options.geminiModel,
        secret: options.geminiApiKey,
        credential: "GEMINI_API_KEY or GOOGLE_API_KEY",
      },
    ],
  };
  if (options.codexModel) methods.codex = [{ kind: "local", model: options.codexModel }];
  return { methods, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) };
}

export const estimateMethod = "utf8-bytes-divided-by-four-v1: UTF-8 bytes / 4, rounded up per instructional file";

/** The labels a method's counts carry, without the credential. */
export function describeMethod(
  method: Exclude<CountMethod, { kind: "unavailable" }>,
  encoding?: string,
): Omit<ProviderMeasurementMetadata, "provider" | "fallbacks"> {
  switch (method.kind) {
    case "anthropic":
      return {
        model: method.model,
        method: "POST /v1/messages/count_tokens with one user text message",
        version: "Anthropic API 2023-06-01",
        accuracy: "api-counted",
        credential: method.credential,
        recipient: "api.anthropic.com",
      };
    case "gemini-api":
      return {
        model: method.model,
        method: "POST models.countTokens with one user text content",
        version: "Gemini API v1beta",
        accuracy: "api-counted",
        credential: method.credential,
        recipient: "generativelanguage.googleapis.com",
      };
    case "vertex":
      return {
        model: method.model,
        method: "POST publishers/google/models.countTokens on Vertex AI with one user text content",
        version: "Vertex AI API v1",
        accuracy: "api-counted",
        credential: method.credential,
        recipient: vertexHost(method.location),
      };
    case "local":
      return {
        model: method.model,
        method: `${tiktokenImplementation}: ${method.model} → ${encoding}, counted per instructional file`,
        version: tiktokenImplementation,
        accuracy: "encoding-exact",
      };
    case "estimate":
      return { model: null, method: estimateMethod, version: "strata-v1", accuracy: "estimate" };
  }
}

function vertexHost(location: string): string {
  return location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
}

export type RemoteMethod = Extract<CountMethod, { secret: string }>;

/** Count one text with a provider's count endpoint. Error messages never include the credential. */
export async function countRemoteText(
  provider: RemoteProvider,
  method: RemoteMethod,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  let url: string;
  let body: unknown;
  if (method.kind === "anthropic") {
    url = "https://api.anthropic.com/v1/messages/count_tokens";
    headers["anthropic-version"] = "2023-06-01";
    if (method.auth === "bearer") {
      headers.authorization = `Bearer ${method.secret}`;
      headers["anthropic-beta"] = "oauth-2025-04-20";
    } else {
      headers["x-api-key"] = method.secret;
    }
    body = { model: method.model, messages: [{ role: "user", content: text }] };
  } else {
    const model = encodeURIComponent(method.model.startsWith("models/") ? method.model.slice(7) : method.model);
    if (method.kind === "vertex") {
      url = `https://${vertexHost(method.location)}/v1/projects/${encodeURIComponent(method.project)}/locations/${encodeURIComponent(method.location)}/publishers/google/models/${model}:countTokens`;
      headers.authorization = `Bearer ${method.secret}`;
    } else {
      url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:countTokens`;
      headers["x-goog-api-key"] = method.secret;
    }
    body = { contents: [{ role: "user", parts: [{ text }] }] };
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
  const tokens = (result as Record<string, unknown>)[method.kind === "anthropic" ? "input_tokens" : "totalTokens"];
  if (typeof tokens !== "number" || !Number.isSafeInteger(tokens) || tokens < 0) {
    throw new Error(`${provider} token count response did not contain a valid token count`);
  }
  return tokens;
}
