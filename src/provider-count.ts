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
  /** OpenAI's o200k_base encoding, run on this machine. */
  | { kind: "local" }
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

/** Every host that received this provider's instruction text, including from a method that then failed. */
export function textRecipients(measured: ProviderMeasurementMetadata): string[] {
  return [...new Set([...(measured.recipient ? [measured.recipient] : []), ...(measured.alsoSentTo ?? [])])];
}

/** The encoding Codex instructions are counted with on this machine, with or without `--precise`. */
export const localEncoding = "o200k_base";

export const estimateMethod = "utf8-bytes-divided-by-four-v1: UTF-8 bytes / 4, rounded up per instructional file";

/** The labels a method's counts carry, without the credential. */
export function describeMethod(
  method: Exclude<CountMethod, { kind: "unavailable" }>,
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
        // A local count depends only on the encoding, which every current OpenAI model shares, so it names that.
        model: localEncoding,
        method: `${tiktokenImplementation}: ${localEncoding}, counted per instructional file`,
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

/** A `-latest` alias moves to new models, so its counts are not kept between runs. */
export const cacheableModel = (model: string) => !/(?:^|-)latest$/.test(model);

export interface RemoteCountOptions {
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Called before each wait for a retry; for rate limits, once per shared pause. */
  onRetry?: (status: number | "connection", waitMilliseconds: number) => void;
  /** Shared by the requests of one method, so a rate limit slows them all down, retries included. */
  pacer?: RequestPacer;
}

const retryStatuses = new Set([408, 429, 500, 502, 503, 504, 529]);
const maxAttempts = 6;
const maxWaitMilliseconds = 60_000;
/** How long rate limits are waited out while no count comes back, before the method fails. */
export const rateLimitPatienceMilliseconds = 180_000;
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
 * Paces the requests of one counting method. A rate limit (HTTP 429) pauses every request for one
 * wait and halves how many may run at once; each count that comes back lets a little more run again,
 * up to the maximum. Rate limits fail the method only after `rateLimitPatienceMilliseconds` of
 * waiting with no count returned, so a slow but steady endpoint is waited out rather than abandoned.
 */
export class RequestPacer {
  readonly #maximum: number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  #window: number;
  #pause: Promise<void> | undefined;
  #active = 0;
  #queued: (() => void)[] = [];
  /** Pauses and time waited since the last count came back. */
  #pauses = 0;
  #waited = 0;

  constructor(maximum: number, sleep: (milliseconds: number) => Promise<void> = defaultSleep) {
    this.#maximum = maximum;
    this.#window = maximum;
    this.#sleep = sleep;
  }

  /** How many requests may be in flight now. */
  get concurrency(): number {
    return Math.max(1, Math.floor(this.#window));
  }

  /** Seconds waited on rate limits since the last count came back. */
  get waitedSeconds(): number {
    return Math.round(this.#waited / 1000);
  }

  /** Resolves when no pause is in progress. */
  async ready(): Promise<void> {
    while (this.#pause) await this.#pause;
  }

  /** Waits for any pause to end and for a free slot, then takes the slot. */
  async acquire(): Promise<void> {
    await this.ready();
    while (this.#active >= this.concurrency) {
      await new Promise<void>((resolve) => this.#queued.push(resolve));
      await this.ready();
    }
    this.#active += 1;
  }

  /** Frees a slot. Every queued request checks again, since the window may have grown. */
  release(): void {
    this.#active -= 1;
    for (const resolve of this.#queued.splice(0)) resolve();
  }

  succeeded(): void {
    this.#pauses = 0;
    this.#waited = 0;
    this.#window = Math.min(this.#maximum, this.#window + 1 / this.#window);
  }

  /**
   * Waits out a rate limit: starts a pause, or joins the one in progress. Resolves to false when
   * patience has run out and the request should fail.
   */
  async rateLimited(response: Response | undefined, onPause?: (waitMilliseconds: number) => void): Promise<boolean> {
    if (!this.#pause) {
      if (this.#waited >= rateLimitPatienceMilliseconds) return false;
      const wait = retryWait(response, this.#pauses);
      this.#pauses += 1;
      this.#waited += wait;
      this.#window = Math.max(1, this.#window / 2);
      onPause?.(wait);
      this.#pause = this.#sleep(wait).finally(() => {
        this.#pause = undefined;
      });
    }
    await this.ready();
    return true;
  }
}

/** What to do about the error reasons people can fix themselves, per kind of endpoint. */
const reasonHints: Record<string, string> = {
  BILLING_DISABLED: "enable billing on the Google Cloud project",
  API_KEY_INVALID: "the API key is not valid",
  not_found_error: "the model was not found; check the model name",
  authentication_error: "the credential was rejected",
  permission_error: "the credential is not allowed to use this model",
  rate_limit_error: "the account's rate limit for this endpoint",
  RESOURCE_EXHAUSTED: "the project's quota or rate limit for this endpoint",
};
const vertexHints: Record<string, string> = {
  BILLING_DISABLED: "enable billing on the Google Cloud project; Vertex AI requires it even for token counts",
  SERVICE_DISABLED: "enable the Vertex AI API (aiplatform.googleapis.com) on the Google Cloud project",
};
const geminiApiHints: Record<string, string> = {
  SERVICE_DISABLED: "enable the Gemini API (generativelanguage.googleapis.com) on the key's Google Cloud project",
};

/**
 * The provider's error code from a failed response: Google's `error.details[].reason` or
 * `error.status`, or Anthropic's `error.type`. Only a short identifier is kept, never the message,
 * so project names and other details do not reach reports or logs.
 */
async function errorReason(response: Response, kind: RemoteMethod["kind"]): Promise<string | null> {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return null;
  }
  const error = (parsed as { error?: unknown } | null)?.error;
  if (!error || typeof error !== "object") return null;
  const { details, status, type } = error as { details?: unknown; status?: unknown; type?: unknown };
  const reasons = Array.isArray(details)
    ? details.map((detail) => (detail as { reason?: unknown } | null)?.reason)
    : [];
  const code = [...reasons, status, type].find(
    (candidate): candidate is string => typeof candidate === "string" && /^[A-Za-z_]{1,64}$/.test(candidate),
  );
  if (!code) return null;
  const hints =
    kind === "vertex" || kind === "vertex-claude" ? vertexHints : kind === "gemini-api" ? geminiApiHints : {};
  const hint = Object.hasOwn(hints, code) ? hints[code] : Object.hasOwn(reasonHints, code) ? reasonHints[code] : null;
  return hint ? `${code}: ${hint}` : code;
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
  const pacer = options.pacer ?? new RequestPacer(1, sleep);
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
  // Rate limits are paced by `pacer` and do not use up attempts.
  for (let attempt = 0; ; ) {
    await pacer.acquire();
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
    } finally {
      pacer.release();
    }
    if (failure === 429) {
      const waited = pacer.waitedSeconds;
      if (response && (await pacer.rateLimited(response, (wait) => options.onRetry?.(429, wait)))) {
        // Drain the body so the connection can be reused.
        await response.arrayBuffer().catch(() => undefined);
        continue;
      }
      const reason = response ? await errorReason(response, method.kind) : null;
      throw Object.assign(
        new Error(
          `${provider} token count requests were rate limited (HTTP 429${reason ? `, ${reason}` : ""}) for ${waited} s with no count returned`,
        ),
        { rateLimited: true },
      );
    }
    attempt += 1;
    const retryable = failure === "connection" || retryStatuses.has(failure);
    if (!retryable || attempt >= maxAttempts) {
      const attempts = attempt > 1 ? ` after ${attempt} attempts` : "";
      if (failure === "connection") throw new Error(`${provider} token count request failed to connect${attempts}`);
      const reason = response ? await errorReason(response, method.kind) : null;
      throw new Error(
        `${provider} token count request failed with HTTP ${failure}${attempts}${reason ? ` (${reason})` : ""}`,
      );
    }
    // Drain the body so the connection can be reused while waiting.
    await response?.arrayBuffer().catch(() => undefined);
    const wait = retryWait(response, attempt - 1);
    options.onRetry?.(failure, wait);
    await sleep(wait);
  }
  pacer.succeeded();
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
