#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type ParseArgsConfig, parseArgs } from "node:util";
import { type AnalysisProgress, analyzeRepository } from "./analyze.js";
import { renderBadge } from "./badge.js";
import { defaultCachePath, type FileCountCache, fileCountCache } from "./count-cache.js";
import { type MeasurementMode, modeForModel, modelEncodings, modelPrefixEncodings } from "./measurement.js";
import type { Report, Submodule } from "./model.js";
import {
  compareGitCommits,
  compareGitCommitsPrecise,
  type PullRequestDelta,
  renderPullRequestDelta,
} from "./pr-delta.js";
import { defaultModels, resolvePrecisePlan } from "./precise.js";
import { redactReport } from "./privacy.js";
import type { CountedProvider, ProviderCountOptions, ProviderCountPlan } from "./provider-count.js";
import { renderHtml } from "./report.js";
import { renderSvg } from "./svg.js";

const providerLabel: Record<CountedProvider, string> = { claude: "Claude", gemini: "Gemini", codex: "Codex" };

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
      --model <name>         Count with a documented OpenAI model encoding: ${models},
                             or a name starting with ${Object.keys(modelPrefixEncodings).join(", ")}`;

const preciseHelp = `Precise counts (opt-in content transfer):
      --precise              Count each provider's instructions with the most precise method
                             available: a signed-in account (ant auth login for Claude; gcloud
                             on Vertex AI for Gemini, and for Claude without ant), then an API
                             key (ANTHROPIC_API_KEY; GEMINI_API_KEY or GOOGLE_API_KEY), then the
                             estimate. Claude and Gemini instruction text is sent to that
                             provider's token-count API when an account or key is found; the
                             run says what went where. Codex is counted locally, never sent.
                             Only providers with instructions in the history are looked up.
                             Strata installs neither CLI: get ant with
                             brew install anthropics/tap/ant, and gcloud from
                             https://cloud.google.com/sdk/docs/install.
      --dry-run              With --precise, print what would be used and sent, then stop
      --no-cache             With --precise, ignore and do not update the local count cache
      --claude-model <name>  Claude model to count with (default: ${defaultModels.claude})
      --gemini-model <name>  Gemini model to count with (default: ${defaultModels.gemini})
      --codex-model <name>   OpenAI model whose encoding counts Codex (default: ${defaultModels.codex})`;

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

Strata reads Git-tracked Claude, Codex, Gemini CLI, Cursor, and GitHub Copilot configuration from
first-parent history. It never modifies the repository and sends nothing over the network unless
--precise is set.
`,
  analyze: `Usage:
  strata analyze [repository] [options]

Analyze the first-parent history of the checked-out branch. The repository defaults to the
current directory. Without --output, the report goes to a private temporary directory.

Output:
  -o, --output <file>        Write the report to a file, or - for standard output
  -f, --format <format>      html, json, svg, or badge (default: html)
      --minimal              With --format svg, draw only the layers: no text, axes, or legend
      --open                 Open the HTML report or SVG image with the default application
      --shareable            Replace repository names, paths, commit IDs, and blob IDs with aliases
  -q, --quiet                Print only the report path

${measurementHelp}

${preciseHelp}
      --provider-api         Deprecated: use --precise. Requires both model flags and API keys,
                             and fails instead of falling back.

  -h, --help                 Show this help

Examples:
  strata analyze --open
  strata analyze ~/src/project --format json --output report.json
  strata analyze --format svg --output docs/strata.svg
  strata analyze --format svg --minimal --output docs/strata-minimal.svg
  strata analyze --format badge --output strata-badge.json
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

${preciseHelp}

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

/** The SVG image is meant to be published, so it keeps the permissions the user's umask gives it. */
function writePublic(destination: string, content: string): void {
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}

function openReport(path: string): void {
  const url = pathToFileURL(path).href;
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32.exe" : "xdg-open";
  const arguments_ = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  const result = spawnSync(command, arguments_, { stdio: "ignore" });
  if (result.error || result.status !== 0) {
    throw new Error(`Could not open the report with the default application. Open this file manually: ${path}`);
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

/** The cache only saves requests, so failing to write it never fails the run. */
function saveCache(cache: FileCountCache | undefined): void {
  try {
    cache?.save();
  } catch (error) {
    process.stderr.write(
      `Warning: could not save the count cache (${error instanceof Error ? error.message : String(error)}); the next run will count again.\n`,
    );
  }
}

/** Notices about content leaving the machine go to stderr and are shown even with --quiet. */
const noticeToStderr = (line: string) => process.stderr.write(`${line}\n`);

const preciseOptions = {
  precise: { type: "boolean" },
  "dry-run": { type: "boolean" },
  "no-cache": { type: "boolean" },
  "claude-model": { type: "string" },
  "gemini-model": { type: "string" },
  "codex-model": { type: "string" },
} as const satisfies NonNullable<ParseArgsConfig["options"]>;

/** Validate the precise-count flags and resolve each provider's methods; undefined without --precise. */
function preciseArguments(values: {
  precise?: boolean | undefined;
  "dry-run"?: boolean | undefined;
  "no-cache"?: boolean | undefined;
  "claude-model"?: string | undefined;
  "gemini-model"?: string | undefined;
  "codex-model"?: string | undefined;
  model?: string | undefined;
  tokenizer?: string | undefined;
}): { plan: ProviderCountPlan; cache: FileCountCache | undefined; onNotice: (line: string) => void } | undefined {
  if (!values.precise) {
    if (values["claude-model"] || values["gemini-model"] || values["codex-model"])
      throw new UsageError("--claude-model, --gemini-model, and --codex-model require --precise");
    if (values["dry-run"] || values["no-cache"]) throw new UsageError("--dry-run and --no-cache require --precise");
    return undefined;
  }
  if (values.model !== undefined || values.tokenizer !== undefined)
    throw new UsageError("Choose either --precise or --model/--tokenizer");
  for (const flag of ["claude-model", "gemini-model", "codex-model"] as const) {
    if (values[flag] === "") throw new UsageError(`--${flag} needs a model name`);
  }
  const codexModel = values["codex-model"];
  if (codexModel) measurementArguments({ model: codexModel });
  const cache = values["no-cache"] ? undefined : fileCountCache(defaultCachePath());
  const dryRun = values["dry-run"] ?? false;
  return {
    plan: resolvePrecisePlan({
      ...(values["claude-model"] ? { claudeModel: values["claude-model"] } : {}),
      ...(values["gemini-model"] ? { geminiModel: values["gemini-model"] } : {}),
      ...(codexModel ? { codexModel } : {}),
      ...(cache ? { cache } : {}),
      dryRun,
    }),
    cache,
    // A dry run's preview is its output.
    onNotice: dryRun ? (line) => process.stdout.write(`${line}\n`) : noticeToStderr,
  };
}

async function analyze(args: string[]): Promise<void> {
  const { values, positionals } = parse(args, {
    output: { type: "string", short: "o" },
    format: { type: "string", short: "f" },
    minimal: { type: "boolean" },
    open: { type: "boolean" },
    shareable: { type: "boolean" },
    quiet: { type: "boolean", short: "q" },
    tokenizer: { type: "string" },
    model: { type: "string" },
    ...preciseOptions,
    "provider-api": { type: "boolean" },
  });
  const repository = repositoryArgument(positionals);
  const format = choice("--format", values.format, ["html", "json", "svg", "badge"], "html");
  const toStdout = values.output === "-";
  if (values.minimal && format !== "svg") throw new UsageError("--minimal requires --format svg");
  if (values.open && (format === "json" || format === "badge"))
    throw new UsageError("--open requires HTML or SVG output");
  if (values.open && toStdout) throw new UsageError("--open requires a report file, not standard output");
  const measurement = measurementArguments(values);

  let providerCounts: ProviderCountOptions | undefined;
  if (values.precise && values["provider-api"]) throw new UsageError("Choose either --precise or --provider-api");
  if (values["provider-api"] && (values.model !== undefined || values.tokenizer !== undefined))
    throw new UsageError("Choose either --provider-api or --model/--tokenizer");
  const codexModel = values["codex-model"];
  if (values["provider-api"] && (values["dry-run"] || values["no-cache"]))
    throw new UsageError("--dry-run and --no-cache require --precise, not --provider-api");
  const precise = values["provider-api"] ? undefined : preciseArguments(values);
  if (values["provider-api"]) {
    process.stderr.write("Warning: --provider-api is deprecated; use --precise.\n");
    const claudeModel = values["claude-model"];
    const geminiModel = values["gemini-model"];
    if (!claudeModel || !geminiModel)
      throw new UsageError("--provider-api requires explicit --claude-model and --gemini-model values");
    const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
    const geminiApiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!anthropicApiKey) throw new UsageError("--provider-api requires ANTHROPIC_API_KEY");
    if (!geminiApiKey) throw new UsageError("--provider-api requires GEMINI_API_KEY (or GOOGLE_API_KEY)");
    if (codexModel) measurementArguments({ model: codexModel });
    providerCounts = { claudeModel, geminiModel, anthropicApiKey, geminiApiKey, ...(codexModel ? { codexModel } : {}) };
  }

  let analyzed: Report;
  try {
    analyzed = await analyzeRepository(repository, {
      ...measurement,
      ...(values.quiet ? {} : { onProgress: progressReporter() }),
      ...(providerCounts ? { providerCounts } : {}),
      ...(precise ? { providerPlan: precise.plan } : {}),
      onNotice: precise?.onNotice ?? noticeToStderr,
    });
  } finally {
    saveCache(precise?.cache);
  }
  if (precise?.plan.dryRun) {
    process.stdout.write("Dry run: nothing was sent and no report was written.\n");
    return;
  }
  const report = values.shareable ? redactReport(analyzed) : analyzed;
  const content =
    format === "json"
      ? `${JSON.stringify(report, null, 2)}\n`
      : format === "svg"
        ? renderSvg(report, { minimal: values.minimal ?? false })
        : format === "badge"
          ? renderBadge(report)
          : renderHtml(report);
  // With the report on stdout, everything meant for a person moves to stderr.
  const say = (line: string) => {
    if (!values.quiet) (toStdout ? process.stderr : process.stdout).write(`${line}\n`);
  };
  const latest = report.revisions.at(-1);
  say(`Analyzed ${report.revisions.length} revisions of ${report.repository}.`);
  say(
    `Latest: ${latest?.componentCount ?? 0} tracked components, ${latest?.estimatedTokens ?? 0} stored-text tokens (${report.measurement.method}).`,
  );
  const skills = latest?.categoryTotals.skills;
  if (skills && skills.count > skills.sourceOnlyCount) {
    const unresolved = latest.skillListingUnresolved;
    say(
      `Skills: ${latest.skillListingTokens} listed tokens, the names and descriptions kept in context before a skill is used; the skill files store ${skills.estimatedTokens}.` +
        (unresolved
          ? ` ${unresolved} manifest${unresolved === 1 ? " has" : "s have"} frontmatter Strata could not read and ${unresolved === 1 ? "is" : "are"} not counted.`
          : ""),
    );
  }
  for (const measured of report.providerMeasurements ?? []) {
    const total = latest?.providerTokenTotals?.[measured.provider] ?? 0;
    const how =
      measured.accuracy === "estimate"
        ? "byte estimate"
        : `${measured.accuracy} with ${measured.model}${measured.credential ? ` via ${measured.credential}` : ""}${measured.wrapperTokens ? `, minus the ${measured.wrapperTokens}-token message wrapper per file` : ""}`;
    say(`${providerLabel[measured.provider]}: ${total} tokens latest, ${how}.`);
    for (const reason of measured.fallbacks ?? []) say(`  Skipped: ${reason}.`);
    for (const host of measured.alsoSentTo ?? [])
      say(`  Instruction text also went to ${host} before that method failed.`);
  }
  if (toStdout) {
    process.stdout.write(content);
  } else {
    const destination = values.output
      ? resolve(values.output)
      : join(
          mkdtempSync(join(tmpdir(), "strata-report-")),
          format === "badge" ? "strata-badge.json" : `report.${format}`,
        );
    // The image and the badge are meant to be published.
    if (format === "svg" || format === "badge") writePublic(destination, content);
    else writePrivate(destination, content);
    process.stdout.write(values.quiet ? `${destination}\n` : `Report: ${destination}\n`);
    if (values.open) openReport(destination);
  }
  if (report.shallow) process.stderr.write("Warning: shallow clone; earlier history is unavailable.\n");
  for (const line of submoduleNotes(report.submodules ?? [])) process.stderr.write(`Note: ${line}\n`);
}

/** Name the submodules that hold agent configuration Strata did not analyze; count those it could not check. */
function submoduleNotes(submodules: Submodule[]): string[] {
  const files = (count: number) => `${count} recognized agent configuration file${count === 1 ? "" : "s"}`;
  // Paths come from the repository, so control characters are escaped before reaching a terminal.
  const printable = (path: string) =>
    path.replace(/\p{Cc}/gu, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const configured = submodules.flatMap(({ path, configFiles }) =>
    configFiles ? [{ path: printable(path), configFiles }] : [],
  );
  const unknown = submodules.filter(({ configFiles }) => configFiles === null).length;
  const notes: string[] = [];
  const [only] = configured;
  if (only && configured.length === 1) {
    notes.push(
      `the Git submodule ${only.path} holds ${files(only.configFiles)} that Strata did not analyze. Run strata analyze on it to see its history.`,
    );
  } else if (configured.length) {
    const listed = configured.slice(0, 5).map(({ path, configFiles }) => `${path} (${configFiles})`);
    if (configured.length > 5) listed.push(`and ${configured.length - 5} more`);
    notes.push(
      `${configured.length} Git submodules hold recognized agent configuration files that Strata did not analyze: ${listed.join(", ")}. Run strata analyze on one to see its history.`,
    );
  }
  if (unknown) {
    notes.push(
      `${unknown} Git submodule${unknown === 1 ? " was" : "s were"} not checked for agent configuration because ${unknown === 1 ? "it is" : "they are"} not checked out at the recorded commit.`,
    );
  }
  return notes;
}

async function diff(args: string[]): Promise<void> {
  const { values, positionals } = parse(args, {
    base: { type: "string" },
    head: { type: "string" },
    output: { type: "string", short: "o" },
    format: { type: "string", short: "f" },
    tokenizer: { type: "string" },
    model: { type: "string" },
    ...preciseOptions,
  });
  const repository = repositoryArgument(positionals);
  if (!values.base || !values.head) throw new UsageError("diff requires --base <commit> and --head <commit>");
  for (const id of [values.base, values.head]) {
    if (!/^[0-9a-f]{40,64}$/i.test(id)) throw new UsageError(`Base and head must be full Git commit IDs, not ${id}`);
  }
  const format = choice("--format", values.format, ["markdown", "json"], "markdown");
  const measurement = measurementArguments(values);
  const precise = preciseArguments(values);
  let delta: PullRequestDelta;
  try {
    delta = precise
      ? await compareGitCommitsPrecise(repository, values.base, values.head, {
          ...measurement,
          providerPlan: precise.plan,
          onNotice: precise.onNotice,
        })
      : compareGitCommits(repository, values.base, values.head, measurement);
  } finally {
    saveCache(precise?.cache);
  }
  if (precise?.plan.dryRun) {
    process.stdout.write("Dry run: nothing was sent and no delta was written.\n");
    return;
  }
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
    await diff(rest);
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
