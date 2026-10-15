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
  /** The host that counted instruction text, in this run or one whose counts were cached. Absent when counting stayed on this machine. */
  recipient?: string;
  /** Hosts that received instruction text from a method that then failed, before this one was used. */
  alsoSentTo?: string[];
  /**
   * Tokens a count endpoint adds for wrapping text in a one-message request, measured once per run and
   * subtracted from every file's count so counts describe the stored text alone.
   */
  wrapperTokens?: number;
  /** Why each more precise method was not used, in the order they were considered. */
  fallbacks?: string[];
}

/** One way to count a provider's instruction text. A plan tries a provider's methods in order. */
export type CountMethod =
  | { kind: "anthropic"; model: string; auth: "x-api-key" | "bearer"; secret: string; credential: string }
  | { kind: "gemini-api"; model: string; secret: string; credential: string }
  | { kind: "vertex"; model: string; secret: string; project: string; location: string; credential: string }
  | {
      kind: "vertex-claude";
      model: string;
      secret: string;
      project: string;
      location: string;
      credential: string;
    }
  | { kind: "local"; model: string }
  | { kind: "estimate" }
  /** A more precise method that was ruled out before the run, reported as a fallback. */
  | { kind: "unavailable"; reason: string };

export interface ProviderCountPlan {
  /**
   * Each counted provider's methods, most precise first. A function is called only when the history
   * has instructions for that provider, so credentials are looked up only where they are useful.
   */
  methods: Partial<Record<CountedProvider, CountMethod[] | (() => CountMethod[])>>;
  fetchImpl?: typeof fetch;
  /** Subtract each count endpoint's one-message wrapper, measured by counting a one-letter text. */
  subtractWrapper?: boolean;
  /** Counts kept between runs, so unchanged file versions are not sent again. */
  cache?: CountCache;
  /** Report what each provider would use and send, without counting or sending anything. */
  dryRun?: boolean;
  /** Waits between retries; tests replace it. */
  sleep?: (milliseconds: number) => Promise<void>;
}

/** Remote counts kept between runs, keyed by endpoint family, model, and Git blob. */
export interface CountCache {
  get(key: string): number | undefined;
  set(key: string, tokens: number): void;
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

/** Every host that received this provider's instruction text, including from a method that then failed. */
export function textRecipients(measured: ProviderMeasurementMetadata): string[] {
  return [...new Set([...(measured.recipient ? [measured.recipient] : []), ...(measured.alsoSentTo ?? [])])];
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
    case "vertex-claude":
      return {
        model: method.model,
        method: "POST publishers/anthropic/models/count-tokens:rawPredict on Vertex AI with one user text message",
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

/** Vertex AI's global endpoint has no region prefix; the `us` and `eu` multi-regions use regional endpoints. */
function vertexHost(location: string): string {
  if (location === "global") return "aiplatform.googleapis.com";
  if (location === "us" || location === "eu") return `aiplatform.${location}.rep.googleapis.com`;
  return `${location}-aiplatform.googleapis.com`;
}

export type RemoteMethod = Extract<CountMethod, { secret: string }>;

/** The cache key family for a method: endpoints that count the same model the same way share counts. */
export function cacheFamily(method: RemoteMethod): string {
  return method.kind === "anthropic" ? "anthropic" : method.kind;
}

export interface RemoteCountOptions {
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Called before each wait for a retry. */
  onRetry?: (status: number | "connection", waitMilliseconds: number) => void;
}

const retryStatuses = new Set([408, 429, 500, 502, 503, 504, 529]);
const maxAttempts = 6;
const maxWaitMilliseconds = 60_000;
const defaultSleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/** The server's `retry-after` in milliseconds when it gives one, otherwise exponential backoff with jitter. */
function retryWait(response: Response | undefined, attempt: number): number {
  const header = response?.headers.get("retry-after");
  const seconds = header === null || header === undefined ? Number.NaN : Number(header);
  const wait =
    Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 1000 * 2 ** attempt * (0.5 + Math.random() / 2);
  return Math.min(wait, maxWaitMilliseconds);
}

/**
 * Count one text with a provider's count endpoint. Rate limits, overload, and server errors are
 * retried with backoff, honoring `retry-after`; other failures throw. Error messages never include
 * the credential.
 */
export async function countRemoteText(
  provider: RemoteProvider,
  method: RemoteMethod,
  text: string,
  options: RemoteCountOptions = {},
): Promise<number> {
  const { fetchImpl = fetch, sleep = defaultSleep } = options;
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
  } else if (method.kind === "vertex-claude") {
    url = `https://${vertexHost(method.location)}/v1/projects/${encodeURIComponent(method.project)}/locations/${encodeURIComponent(method.location)}/publishers/anthropic/models/count-tokens:rawPredict`;
    headers.authorization = `Bearer ${method.secret}`;
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
  let response: Response | undefined;
  for (let attempt = 0; ; attempt += 1) {
    let failure: number | "connection";
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) break;
      failure = response.status;
    } catch {
      response = undefined;
      failure = "connection";
    }
    const retryable = failure === "connection" || retryStatuses.has(failure);
    if (!retryable || attempt + 1 >= maxAttempts) {
      const attempts = attempt + 1 > 1 ? ` after ${attempt + 1} attempts` : "";
      throw new Error(
        failure === "connection"
          ? `${provider} token count request failed to connect${attempts}`
          : `${provider} token count request failed with HTTP ${failure}${attempts}`,
      );
    }
    // Drain the body so the connection can be reused while waiting.
    await response?.arrayBuffer().catch(() => undefined);
    const wait = retryWait(response, attempt);
    options.onRetry?.(failure, wait);
    await sleep(wait);
  }
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new Error(`${provider} token count request returned invalid JSON`);
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error(`${provider} token count request returned an invalid response`);
  }
  const field = method.kind === "anthropic" || method.kind === "vertex-claude" ? "input_tokens" : "totalTokens";
  const tokens = (result as Record<string, unknown>)[field];
  if (typeof tokens !== "number" || !Number.isSafeInteger(tokens) || tokens < 0) {
    throw new Error(`${provider} token count response did not contain a valid token count`);
  }
  return tokens;
}
