import { spawnSync } from "node:child_process";
import type { CountMethod, ProviderCountPlan } from "./provider-count.js";

/** Models counted with when `--precise` is given no model flag. */
export const defaultModels = { claude: "claude-opus-5-5", gemini: "gemini-3.8-flash", codex: "gpt-5" } as const;

export interface PreciseOptions {
  claudeModel?: string;
  geminiModel?: string;
  codexModel?: string;
  env?: NodeJS.ProcessEnv;
  /** Run a provider CLI. Tests replace it with a stub. */
  run?: (command: string, args: string[]) => CommandResult;
  fetchImpl?: typeof fetch;
}

/** `missing` when the CLI is not installed; otherwise its trimmed standard output, or null when it failed. */
export type CommandResult = "missing" | { output: string | null };

/** How to install each provider CLI, shown when `--precise` cannot find it. */
export const installHints = {
  ant: "the Anthropic CLI (`ant`) is not installed; to count with your Anthropic account, install it with `brew install anthropics/tap/ant` (or see https://github.com/anthropics/anthropic-cli) and run `ant auth login`",
  gcloud:
    "the Google Cloud CLI (`gcloud`) is not installed; to count with your Google Cloud account through Vertex AI, install it (see https://cloud.google.com/sdk/docs/install), run `gcloud auth login`, and set a project",
} as const;

const unavailable = (reason: string): CountMethod => ({ kind: "unavailable", reason });

function runCommand(command: string, args: string[]): CommandResult {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 20_000,
    stdio: ["ignore", "pipe", "ignore"],
    shell: process.platform === "win32",
  });
  // Without a shell, a missing program is ENOENT; through cmd.exe it is exit status 9009.
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return "missing";
  if (process.platform === "win32" && result.status === 9009) return "missing";
  if (result.error || result.status !== 0) return { output: null };
  return { output: result.stdout.trim() || null };
}

/** A printed access token is one line without spaces or JSON; anything else is not trusted as one. */
function token(result: CommandResult): string | null {
  const output = result === "missing" ? null : result.output;
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
  const ant = run("ant", ["auth", "print-credentials", "--access-token"]);
  const antToken = token(ant);
  if (ant === "missing") {
    claude.push(unavailable(installHints.ant));
  } else if (antToken) {
    claude.push({
      kind: "anthropic",
      model: claudeModel,
      auth: "bearer",
      secret: antToken,
      credential: "signed-in Anthropic account (ant auth login)",
    });
  } else {
    claude.push(unavailable("no signed-in Anthropic account: run `ant auth login`"));
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
  const configured = run("gcloud", ["config", "get-value", "project"]);
  const project = env.GOOGLE_CLOUD_PROJECT || (configured === "missing" ? null : configured.output);
  const gcloudToken = configured !== "missing" && project ? token(run("gcloud", ["auth", "print-access-token"])) : null;
  if (configured === "missing") {
    gemini.push(unavailable(installHints.gcloud));
  } else if (!/^[a-z0-9-]+$/.test(location)) {
    gemini.push(unavailable("GOOGLE_CLOUD_LOCATION is not a Google Cloud location name"));
  } else if (!project || !/^[a-z][a-z0-9.:-]*$/.test(project)) {
    gemini.push(unavailable("no Google Cloud project: set GOOGLE_CLOUD_PROJECT or `gcloud config set project`"));
  } else if (!gcloudToken) {
    gemini.push(unavailable("no signed-in Google Cloud account: run `gcloud auth login`"));
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
