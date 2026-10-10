#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type ParseArgsConfig, parseArgs } from "node:util";
import { type AnalysisProgress, analyzeRepository } from "./analyze.js";
import { type MeasurementMode, modeForModel, modelEncodings } from "./measurement.js";
import { compareGitCommits, renderPullRequestDelta } from "./pr-delta.js";
import { redactReport } from "./privacy.js";
import type { ProviderCountOptions } from "./provider-count.js";
import { renderHtml } from "./report.js";

/** A mistake in how the command was invoked. Exits with status 2; other failures exit with 1. */
class UsageError extends Error {}

const tokenizers = [
  "estimate",
  "openai-cl100k_base",
  "openai-o200k_base",
] as const satisfies readonly MeasurementMode[];
const models = Object.keys(modelEncodings).join(", ");

const measurementHelp = `Measurement (offline; choose at most one):
      --tokenizer <mode>     ${tokenizers.join(", ")} (default: estimate)
      --model <name>         Count with a documented OpenAI model encoding: ${models}`;

const help = {
  main: `Strata — see how your agent context evolved across Git history.

Usage:
  strata <command> [options]

Commands:
  analyze [repository]   Write an offline report of tracked agent configuration over time
  diff [repository]      Compare tracked agent configuration at two commits
  skill                  Print the bundled skill for interpreting JSON reports
  help [command]         Show help for a command

Options:
  -h, --help             Show help
  -V, --version          Show the version

Strata reads Git-tracked Claude, Codex, and Gemini CLI configuration from first-parent history.
It never modifies the repository and sends nothing over the network unless --provider-api is set.
`,
  analyze: `Usage:
  strata analyze [repository] [options]

Analyze the first-parent history of the checked-out branch. The repository defaults to the
current directory. Without --output, the report goes to a private temporary directory.

Output:
  -o, --output <file>        Write the report to a file, or - for standard output
  -f, --format <format>      html or json (default: html)
      --open                 Open the HTML report in a browser
      --shareable            Replace repository names, paths, commit IDs, and blob IDs with aliases
  -q, --quiet                Print only the report path

${measurementHelp}

Provider API counts (opt-in content transfer):
      --provider-api         Send recognized Claude and Gemini instruction text to their
                             token-count APIs. Requires --claude-model, --gemini-model,
                             ANTHROPIC_API_KEY, and GEMINI_API_KEY (or GOOGLE_API_KEY).
      --claude-model <name>  Claude model to count with
      --gemini-model <name>  Gemini model to count with
      --codex-model <name>   Add a local OpenAI encoding count for Codex instructions

  -h, --help                 Show this help

Examples:
  strata analyze --open
  strata analyze ~/src/project --format json --output report.json
  strata analyze --format json --output - | jq '.revisions[-1].estimatedTokens'
`,
  diff: `Usage:
  strata diff [repository] --base <commit> --head <commit> [options]

Compare two commits, such as a pull request's base and head, without checking them out.
Both must be full commit IDs. The repository defaults to the current directory.

Options:
      --base <commit>        Full commit ID to compare from
      --head <commit>        Full commit ID to compare to
  -o, --output <file>        Write to a file instead of standard output
  -f, --format <format>      markdown or json (default: markdown)
  -h, --help                 Show this help

${measurementHelp}

Example:
  strata diff --base "$(git rev-parse main)" --head "$(git rev-parse HEAD)"
`,
  skill: `Usage:
  strata skill [--output <file>]

Print the bundled skill that teaches a coding agent to interpret Strata JSON reports.

Options:
  -o, --output <file>        Save the skill to a file; an existing file is never overwritten
  -h, --help                 Show this help
`,
} as const;

type Command = Exclude<keyof typeof help, "main">;

function isCommand(value: string | undefined): value is Command {
  return value !== undefined && value !== "main" && Object.hasOwn(help, value);
}

function parse<T extends NonNullable<ParseArgsConfig["options"]>>(args: string[], options: T) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

function choice<const T extends string>(
  option: string,
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  if (value === undefined) return fallback;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new UsageError(`${option} must be ${new Intl.ListFormat("en", { type: "disjunction" }).format(allowed)}`);
  }
  return value as T;
}

function repositoryArgument(positionals: string[]): string {
  if (positionals.length > 1) throw new UsageError(`Unexpected argument: ${positionals[1]}`);
  return positionals[0] ?? ".";
}

function measurementArguments(values: { tokenizer?: string | undefined; model?: string | undefined }): {
  mode: MeasurementMode;
  model: string | null;
} {
  if (values.model !== undefined && values.tokenizer !== undefined)
    throw new UsageError("Choose either --model or --tokenizer");
  const tokenizer = choice("--tokenizer", values.tokenizer, tokenizers, "estimate");
  if (values.model === undefined) return { mode: tokenizer, model: null };
  try {
    return { mode: modeForModel(values.model), model: values.model };
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

/** Reports can reveal repository structure, so files are created readable by the owner only. */
function writePrivate(destination: string, content: string, flag: "w" | "wx" = "w"): void {
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content, { flag, mode: 0o600 });
  chmodSync(destination, 0o600);
}

function openReport(path: string): void {
  const url = pathToFileURL(path).href;
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32.exe" : "xdg-open";
  const arguments_ = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  const result = spawnSync(command, arguments_, { stdio: "ignore" });
  if (result.error || result.status !== 0) {
    throw new Error(`Could not open the report in a browser. Open this file manually: ${path}`);
  }
}

/** Progress goes to stderr: one updating line on a terminal, a line per tenth of history otherwise. */
function progressReporter(): (progress: AnalysisProgress) => void {
  const interactive = process.stderr.isTTY;
  let lastStep = -1;
  return ({ completed, total }) => {
    if (completed === 0) {
      if (!interactive) process.stderr.write(`Analyzing ${total} revisions...\n`);
      return;
    }
    const done = completed >= total;
    const step = Math.floor((completed * (interactive ? 100 : 10)) / total);
    if (step === lastStep && !done) return;
    lastStep = step;
    if (interactive) {
      process.stderr.write(`\r\x1b[KAnalyzing revisions ${completed}/${total}${done ? "\r\x1b[K" : ""}`);
    } else if (step > 0) {
      process.stderr.write(`Processed ${completed}/${total} revisions.\n`);
    }
  };
}

async function analyze(args: string[]): Promise<void> {
  const { values, positionals } = parse(args, {
    output: { type: "string", short: "o" },
    format: { type: "string", short: "f" },
    open: { type: "boolean" },
    shareable: { type: "boolean" },
    quiet: { type: "boolean", short: "q" },
    tokenizer: { type: "string" },
    model: { type: "string" },
    "provider-api": { type: "boolean" },
    "claude-model": { type: "string" },
    "gemini-model": { type: "string" },
    "codex-model": { type: "string" },
  });
  const repository = repositoryArgument(positionals);
  const format = choice("--format", values.format, ["html", "json"], "html");
  const toStdout = values.output === "-";
  if (values.open && format !== "html") throw new UsageError("--open requires HTML output");
  if (values.open && toStdout) throw new UsageError("--open requires a report file, not standard output");
  const measurement = measurementArguments(values);

  let providerCounts: ProviderCountOptions | undefined;
  if (values["provider-api"]) {
    if (values.model !== undefined || values.tokenizer !== undefined)
      throw new UsageError("Choose either --provider-api or --model/--tokenizer");
    const claudeModel = values["claude-model"];
    const geminiModel = values["gemini-model"];
    if (!claudeModel || !geminiModel)
      throw new UsageError("--provider-api requires explicit --claude-model and --gemini-model values");
    const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
    const geminiApiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!anthropicApiKey) throw new UsageError("--provider-api requires ANTHROPIC_API_KEY");
    if (!geminiApiKey) throw new UsageError("--provider-api requires GEMINI_API_KEY (or GOOGLE_API_KEY)");
    const codexModel = values["codex-model"];
    if (codexModel) measurementArguments({ model: codexModel });
    providerCounts = { claudeModel, geminiModel, anthropicApiKey, geminiApiKey, ...(codexModel ? { codexModel } : {}) };
  } else if (values["claude-model"] || values["gemini-model"] || values["codex-model"]) {
    throw new UsageError("--claude-model, --gemini-model, and --codex-model require --provider-api");
  }

  const analyzed = await analyzeRepository(repository, {
    ...measurement,
    ...(values.quiet ? {} : { onProgress: progressReporter() }),
    ...(providerCounts ? { providerCounts } : {}),
  });
  const report = values.shareable ? redactReport(analyzed) : analyzed;
  const content = format === "json" ? `${JSON.stringify(report, null, 2)}\n` : renderHtml(report);
  // With the report on stdout, everything meant for a person moves to stderr.
  const say = (line: string) => {
    if (!values.quiet) (toStdout ? process.stderr : process.stdout).write(`${line}\n`);
  };
  const latest = report.revisions.at(-1);
  say(`Analyzed ${report.revisions.length} revisions of ${report.repository}.`);
  say(
    `Latest: ${latest?.componentCount ?? 0} tracked components, ${latest?.estimatedTokens ?? 0} stored-text tokens (${report.measurement.method}).`,
  );
  if (toStdout) {
    process.stdout.write(content);
  } else {
    const destination = values.output
      ? resolve(values.output)
      : join(mkdtempSync(join(tmpdir(), "strata-report-")), `report.${format}`);
    writePrivate(destination, content);
    process.stdout.write(values.quiet ? `${destination}\n` : `Report: ${destination}\n`);
    if (values.open) openReport(destination);
  }
  if (report.shallow) process.stderr.write("Warning: shallow clone; earlier history is unavailable.\n");
}

function diff(args: string[]): void {
  const { values, positionals } = parse(args, {
    base: { type: "string" },
    head: { type: "string" },
    output: { type: "string", short: "o" },
    format: { type: "string", short: "f" },
    tokenizer: { type: "string" },
    model: { type: "string" },
  });
  const repository = repositoryArgument(positionals);
  if (!values.base || !values.head) throw new UsageError("diff requires --base <commit> and --head <commit>");
  for (const id of [values.base, values.head]) {
    if (!/^[0-9a-f]{40,64}$/i.test(id)) throw new UsageError(`Base and head must be full Git commit IDs, not ${id}`);
  }
  const format = choice("--format", values.format, ["markdown", "json"], "markdown");
  const delta = compareGitCommits(repository, values.base, values.head, measurementArguments(values));
  const content = format === "json" ? `${JSON.stringify(delta, null, 2)}\n` : renderPullRequestDelta(delta);
  if (values.output === undefined || values.output === "-") {
    process.stdout.write(content);
  } else {
    const destination = resolve(values.output);
    writePrivate(destination, content);
    process.stdout.write(`Delta: ${destination}\n`);
  }
}

function skill(args: string[]): void {
  const { values, positionals } = parse(args, { output: { type: "string", short: "o" } });
  if (positionals.length) throw new UsageError(`Unexpected argument: ${positionals[0]}`);
  const content = readFileSync(new URL("../skills/strata-interpret/SKILL.md", import.meta.url), "utf8");
  if (values.output === undefined || values.output === "-") {
    process.stdout.write(content);
    return;
  }
  const destination = resolve(values.output);
  try {
    writePrivate(destination, content, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(`Refusing to overwrite an existing file: ${destination}`);
    throw error;
  }
  process.stdout.write(`Skill: ${destination}\n`);
}

async function main(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(help.main);
  } else if (command === "help") {
    if (rest.length > 1 || (rest[0] !== undefined && !isCommand(rest[0])))
      throw new UsageError(`Unknown command: ${rest.join(" ")}`);
    process.stdout.write(help[rest[0] ?? "main"]);
  } else if (command === "--version" || command === "-V" || command === "-v") {
    const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    process.stdout.write(`${version}\n`);
  } else if (!isCommand(command)) {
    throw new UsageError(command.startsWith("-") ? `Unknown option: ${command}` : `Unknown command: ${command}`);
  } else if (rest.includes("--help") || rest.includes("-h")) {
    process.stdout.write(help[command]);
  } else if (command === "analyze") {
    await analyze(rest);
  } else if (command === "diff") {
    diff(rest);
  } else {
    skill(rest);
  }
}

// A closed pipe (for example `strata ... | head`) is a normal way for output to end.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

try {
  await main(process.argv.slice(2));
} catch (error) {
  const usage = error instanceof UsageError;
  process.stderr.write(`strata: ${error instanceof Error ? error.message : String(error)}\n`);
  if (usage) process.stderr.write("Run strata --help for usage.\n");
  process.exitCode = usage ? 2 : 1;
}
