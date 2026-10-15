import { spawnSync } from "node:child_process";
import type { CountMethod, ProviderCountPlan } from "./provider-count.js";

/** Models counted with when `--precise` is given no model flag. */
export const defaultModels = { claude: "claude-opus-5-5", gemini: "gemini-3.8-flash", codex: "gpt-5" } as const;

export interface PreciseOptions {
  claudeModel?: string;
  geminiModel?: string;
  codexModel?: string;
  env?: NodeJS.ProcessEnv;
  /** Run a provider CLI and return its trimmed standard output, or null when it is missing or fails. */
  run?: (command: string, args: string[]) => string | null;
  fetchImpl?: typeof fetch;
}

const unavailable = (reason: string): CountMethod => ({ kind: "unavailable", reason });

function runCommand(command: string, args: string[]): string | null {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 20_000,
    stdio: ["ignore", "pipe", "ignore"],
    shell: process.platform === "win32",
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim() || null;
}

/** A printed access token is one line without spaces or JSON; anything else is not trusted as one. */
function token(output: string | null): string | null {
  return output && /^[\x21-\x7e]+$/.test(output) && !output.startsWith("{") ? output : null;
}

/**
 * Choose, per provider, the methods `--precise` will try in order: a signed-in account, then an
 * API key from the environment, then a local exact tokenizer, then the byte estimate. A signed-in
 * account is used only through the provider's own CLI, which prints a short-lived access token;
 * Strata never reads credential files. Codex is always counted locally, because OpenAI's encodings
 * are available offline and exact for stored text.
 */
export function resolvePrecisePlan(options: PreciseOptions = {}): ProviderCountPlan {
  const env = options.env ?? process.env;
  const run = options.run ?? runCommand;
  const claudeModel = options.claudeModel ?? defaultModels.claude;
  const geminiModel = options.geminiModel ?? defaultModels.gemini;
  const codexModel = options.codexModel ?? defaultModels.codex;

  const claude: CountMethod[] = [];
  const antToken = token(run("ant", ["auth", "print-credentials", "--access-token"]));
  if (antToken) {
    claude.push({
      kind: "anthropic",
      model: claudeModel,
      auth: "bearer",
      secret: antToken,
      credential: "signed-in Anthropic account (ant auth login)",
    });
  } else {
    claude.push(unavailable("no signed-in Anthropic account: `ant auth print-credentials` gave no token"));
  }
  if (env.ANTHROPIC_API_KEY) {
    claude.push({
      kind: "anthropic",
      model: claudeModel,
      auth: "x-api-key",
      secret: env.ANTHROPIC_API_KEY,
      credential: "ANTHROPIC_API_KEY",
    });
  } else {
    claude.push(unavailable("ANTHROPIC_API_KEY is not set"));
  }
  claude.push(unavailable("no local exact Claude tokenizer exists"));
  claude.push({ kind: "estimate" });

  const gemini: CountMethod[] = [];
  const location = env.GOOGLE_CLOUD_LOCATION || "global";
  const project = env.GOOGLE_CLOUD_PROJECT || run("gcloud", ["config", "get-value", "project"]);
  const gcloudToken = project ? token(run("gcloud", ["auth", "print-access-token"])) : null;
  if (!/^[a-z0-9-]+$/.test(location)) {
    gemini.push(unavailable("GOOGLE_CLOUD_LOCATION is not a Google Cloud location name"));
  } else if (!project || !/^[a-z][a-z0-9.:-]*$/.test(project)) {
    gemini.push(unavailable("no Google Cloud project: set GOOGLE_CLOUD_PROJECT or `gcloud config set project`"));
  } else if (!gcloudToken) {
    gemini.push(unavailable("no signed-in Google Cloud account: `gcloud auth print-access-token` gave no token"));
  } else {
    gemini.push({
      kind: "vertex",
      model: geminiModel,
      secret: gcloudToken,
      project,
      location,
      credential: "signed-in Google Cloud account (gcloud, Vertex AI)",
    });
  }
  const geminiKeyVariable = env.GEMINI_API_KEY ? "GEMINI_API_KEY" : env.GOOGLE_API_KEY ? "GOOGLE_API_KEY" : null;
  if (geminiKeyVariable) {
    gemini.push({
      kind: "gemini-api",
      model: geminiModel,
      secret: env[geminiKeyVariable]!,
      credential: geminiKeyVariable,
    });
  } else {
    gemini.push(unavailable("GEMINI_API_KEY and GOOGLE_API_KEY are not set"));
  }
  gemini.push(unavailable("no local exact Gemini tokenizer exists"));
  gemini.push({ kind: "estimate" });

  return {
    methods: { claude, gemini, codex: [{ kind: "local", model: codexModel }, { kind: "estimate" }] },
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  };
}
