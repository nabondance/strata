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
import { importLinks } from "./import-links.js";
import { sharePercent, summarizeInstructionAge } from "./instruction-age.js";
import {
  checkLimits,
  keepsUpFront,
  type Limit,
  type LimitCheck,
  type LimitName,
  limitAnnotations,
  limitMessages,
  limitSummary,
  parseLimits,
} from "./limits.js";
import { type MeasurementMode, modeForModel, modelEncodings, modelPrefixEncodings } from "./measurement.js";
import type { Component, Report, Submodule } from "./model.js";
import {
  compareGitCommits,
  compareGitCommitsPrecise,
  limitFigures,
  type PullRequestDelta,
  renderPullRequestDelta,
} from "./pr-delta.js";
import { defaultModels, resolvePrecisePlan } from "./precise.js";
import { redactReport } from "./privacy.js";
import type { CountedProvider, ProviderCountOptions, ProviderCountPlan } from "./provider-count.js";
import { renderHtml } from "./report.js";
import { renderSvg } from "./svg.js";
import {
  hasUpFront,
  sessionProviderNames,
  sessionProviders,
  type UpFrontContext,
  upFrontContext,
  upFrontTotals,
} from "./up-front.js";

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

/** Exit status when a limit set with --limit-* is passed and --on-limit is fail. */
const overLimitStatus = 3;

const agentPrefix = `${sessionProviders.join("=, ")}=`;

const limitsHelp = {
  analyze: `Limits (in tokens; off unless set; checked at the latest revision):
      --limit-tokens <n>                   Stored instructional text
      --limit-up-front-tokens [agent=]<n>  What each agent keeps at session start; repeat
                                           with ${agentPrefix}
                                           for one agent
      --on-limit <fail|warn>               fail (default) exits with status ${overLimitStatus} once the
                                           report is written; warn only reports
      --limit-annotations                  Also print each limit passed or not applied as a
                                           GitHub Actions annotation`,
  diff: `Limits (in tokens; off unless set; checked at the head, never with --precise counts):
      --limit-tokens <n>                   Stored instructional text
      --limit-increase <n>                 Growth of stored instructional text from base to head
      --limit-up-front-tokens [agent=]<n>  What each agent keeps at session start; repeat
                                           with ${agentPrefix}
                                           for one agent
      --limit-up-front-increase [agent=]<n>
                                           Growth of what each agent keeps at session start
      --on-limit <fail|warn>               fail (default) exits with status ${overLimitStatus} once the
                                           delta is written; warn only reports
      --limit-annotations                  Also print each limit passed or not applied as a
                                           GitHub Actions annotation`,
};

const help = {
  main: `Strata — see how your agent context evolved across Git history.

Usage:
  strata <command> [options]

Commands:
  analyze [repository]   Write an offline report of tracked agent configuration over time
                         (analyse is an alias)
  diff [repository]      Compare tracked agent configuration at two commits
  skill                  Print the bundled skill for interpreting Strata output
  help [command]         Show help for a command

Options:
  -h, --help             Show help
  -V, --version          Show the version

Limits:
  analyze and diff can fail, or warn, when a token figure passes a limit you set, such as
  --limit-tokens 50000 or --limit-up-front-tokens claude=8000. A passed limit exits with
  status 3, or only warns with --on-limit warn. Run strata help diff for every limit flag.

Strata reads Git-tracked Claude, Codex, Gemini CLI, Cursor, and GitHub Copilot configuration from
first-parent history. It never modifies the repository and sends nothing over the network unless
--precise is set.
`,
  analyze: `Usage:
  strata analyze [repository] [options]

Analyze the first-parent history of the checked-out branch. The repository defaults to the
current directory. Without --output, the report goes to a private temporary directory.
strata analyse is an alias for strata analyze.

Output:
  -o, --output <file>        Write the report to a file, or - for standard output
  -f, --format <format>      html, json, svg, or badge (default: html)
      --minimal              With --format svg, draw only the layers: no text, axes, or legend
      --open                 Open the HTML report or SVG image with the default application
      --shareable            Replace repository names, paths, commit IDs, blob IDs, and MCP server names with aliases
  -q, --quiet                Print only the report path

${measurementHelp}

${limitsHelp.analyze}

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
  strata analyze --limit-up-front-tokens 8000 --format json --output report.json
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
      --json-output <file>   Also write the JSON delta to a file, from the same comparison
  -h, --help                 Show this help

${measurementHelp}

${limitsHelp.diff}

${preciseHelp}

Examples:
  strata diff --base "$(git rev-parse main)" --head "$(git rev-parse HEAD)"
  strata diff --base "$(git rev-parse main)" --head "$(git rev-parse HEAD)" \\
    --limit-increase 500 --limit-up-front-tokens claude=8000
`,
  skill: `Usage:
  strata skill [--output <file>]

Print the bundled skill that teaches a coding agent to interpret Strata reports, comparisons, images, and badges.

Options:
  -o, --output <file>        Save the skill to a file; an existing file is never overwritten
  -h, --help                 Show this help
`,
} as const;

type Command = Exclude<keyof typeof help, "main">;

/** Alternate spellings accepted on the command line. */
const aliases: Record<string, Command> = { analyse: "analyze" };

function resolveAlias(value: string | undefined): string | undefined {
  return value !== undefined && Object.hasOwn(aliases, value) ? aliases[value] : value;
}

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

const limitOptions = {
  "limit-tokens": { type: "string", multiple: true },
  "limit-up-front-tokens": { type: "string", multiple: true },
  "on-limit": { type: "string" },
  "limit-annotations": { type: "boolean" },
} as const satisfies NonNullable<ParseArgsConfig["options"]>;

const increaseLimitOptions = {
  "limit-increase": { type: "string", multiple: true },
  "limit-up-front-increase": { type: "string", multiple: true },
} as const satisfies NonNullable<ParseArgsConfig["options"]>;

/** The limits set on the command line, whether passing one fails the run, and whether to annotate. */
interface LimitArguments {
  limits: Limit[];
  fail: boolean;
  annotations: boolean;
}

function limitArguments(
  values: Partial<Record<LimitName, string[] | undefined>> & {
    "on-limit"?: string | undefined;
    "limit-annotations"?: boolean | undefined;
  },
): LimitArguments {
  let limits: Limit[];
  try {
    limits = parseLimits(values);
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const onLimit = choice("--on-limit", values["on-limit"], ["fail", "warn"], "fail");
  if (values["on-limit"] !== undefined && !limits.length)
    throw new UsageError("--on-limit requires a limit such as --limit-tokens");
  if (values["limit-annotations"] && !limits.length)
    throw new UsageError("--limit-annotations requires a limit such as --limit-tokens");
  return { limits, fail: onLimit === "fail", annotations: values["limit-annotations"] ?? false };
}

/**
 * Report passed and unchecked limits on stderr, shown even with --quiet, with GitHub Actions
 * annotations when asked (the runner reads workflow commands from either stream), and set the exit status.
 */
function reportLimits(checks: readonly LimitCheck[], options: LimitArguments): void {
  for (const line of limitMessages(checks)) process.stderr.write(`${line}\n`);
  if (options.annotations) {
    for (const line of limitAnnotations(checks, options.fail ? "error" : "warning")) process.stderr.write(`${line}\n`);
  }
  if (options.fail && checks.some((check) => check.result === "over")) process.exitCode = overLimitStatus;
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
    ...limitOptions,
    "provider-api": { type: "boolean" },
  });
  const repository = repositoryArgument(positionals);
  const limits = limitArguments(values);
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
  const dryRunLine = "Dry run: nothing was sent and no report was written.\n";
  // Without limits a dry run needs nothing more, so it skips replaying the history.
  if (precise?.plan.dryRun && !limits.limits.length) {
    process.stdout.write(dryRunLine);
    return;
  }
  const latest = analyzed.revisions.at(-1);
  // The last revision's files and what each agent reads up front, built once for the notes and limits.
  const components = latestComponents(analyzed);
  const upFrontContexts = sessionProviders.flatMap((provider) => {
    const context = upFrontContext(components, provider, latest?.geminiContextFiles);
    return hasUpFront(upFrontTotals(context)) ? [context] : [];
  });
  // Limits use the local measurement, which a dry run has already taken.
  const checks = limits.limits.length
    ? checkLimits(limits.limits, {
        total: { before: null, after: latest?.estimatedTokens ?? 0 },
        upFront: new Map(
          upFrontContexts
            .filter((context) => keepsUpFront(upFrontTotals(context)))
            .map((context) => [context.provider, { before: null, after: context.tokens }]),
        ),
      })
    : null;
  if (precise?.plan.dryRun) {
    process.stdout.write(dryRunLine);
    if (checks) {
      if (!values.quiet) process.stdout.write(`${limitSummary(checks)}\n`);
      reportLimits(checks, limits);
    }
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
  const upFront = upFrontNote(upFrontContexts);
  if (upFront) say(upFront);
  const age = summarizeInstructionAge(report);
  if (age) {
    // In a shallow clone, text dated at its first revision may be older.
    const day = (index: number) =>
      report.revisions[index]!.date.slice(0, 10) + (report.shallow && index === 0 ? " or earlier" : "");
    say(
      `Instruction age: half of the latest instruction text was in place by revision ${age.median + 1} (${day(age.median)}); ${sharePercent(age.kept)} of the text at the first revision with instructions (${report.revisions[age.first]!.date.slice(0, 10)}) is still present.` +
        (report.shallow && age.first === 0
          ? " This shallow clone starts at revision 1, so text dated there may be older."
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
  let toOpen: string | undefined;
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
    if (values.open) toOpen = destination;
  }
  if (checks) {
    say(limitSummary(checks));
    reportLimits(checks, limits);
  }
  if (report.shallow) process.stderr.write("Warning: shallow clone; earlier history is unavailable.\n");
  for (const line of submoduleNotes(report.submodules ?? [])) process.stderr.write(`Note: ${line}\n`);
  const unresolved = unresolvedImportNote(components);
  if (unresolved) process.stderr.write(`Note: ${unresolved}\n`);
  // Last, so a viewer that fails to open cannot hide the limits or notes above.
  if (toOpen) openReport(toOpen);
}

/** The last revision's inventory, replayed as `expandRevisions` does without building every revision's. */
function latestComponents(report: Report): Component[] {
  const inventory = new Map<string, number>();
  for (const revision of report.revisions) {
    for (const change of revision.changes) {
      if (change.previousPath !== undefined) inventory.delete(change.previousPath);
      if (change.component === null) inventory.delete(change.path);
      else inventory.set(change.path, change.component);
    }
  }
  return [...inventory.values()].sort((a, b) => a - b).map((index) => report.components[index]!);
}

/** Each agent's stored text listed up front at the last revision, beside what it reads on demand. */
function upFrontNote(entries: readonly UpFrontContext[]): string | null {
  if (!entries.length) return null;
  const unresolved = entries.reduce((sum, entry) => sum + entry.unresolved, 0);
  return (
    `At session start: ${entries.map((entry) => `${sessionProviderNames[entry.provider]} ${entry.tokens} tokens (${entry.onDemandTokens} more when needed)`).join(", ")}.` +
    (unresolved
      ? ` ${unresolved} rule${unresolved === 1 ? "" : "s"} Strata could not read ${unresolved === 1 ? "is" : "are"} counted as when needed.`
      : "")
  );
}

/** Count the Claude imports the last revision cannot resolve, by reason; paths stay in the report. */
function unresolvedImportNote(components: readonly Component[]): string | null {
  const links = importLinks(components).filter((link) => link.status !== "resolved");
  if (!links.length) return null;
  const reasons = {
    missing: "missing",
    external: "outside the repository",
    "depth-limit": "beyond four hops",
  } as const;
  const counts = (Object.keys(reasons) as Array<keyof typeof reasons>).flatMap((status) => {
    const matching = links.filter((link) => link.status === status);
    if (!matching.length) return [];
    // Claude Code does not expand a file past the limit, but the import still points somewhere.
    const outside = status === "depth-limit" ? matching.filter((link) => link.external).length : 0;
    const where = !outside
      ? ""
      : outside === 1 && matching.length === 1
        ? " (it points outside the repository)"
        : ` (${outside} point${outside === 1 ? "s" : ""} outside the repository)`;
    return [`${matching.length} ${reasons[status]}${where}`];
  });
  return `${links.length} Claude @path import${links.length === 1 ? " is" : "s are"} unresolved at the last revision (${counts.join(", ")}); the report lists them.`;
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
    "json-output": { type: "string" },
    tokenizer: { type: "string" },
    model: { type: "string" },
    ...preciseOptions,
    ...limitOptions,
    ...increaseLimitOptions,
  });
  const repository = repositoryArgument(positionals);
  const limits = limitArguments(values);
  if (!values.base || !values.head) throw new UsageError("diff requires --base <commit> and --head <commit>");
  for (const id of [values.base, values.head]) {
    if (!/^[0-9a-f]{40,64}$/i.test(id)) throw new UsageError(`Base and head must be full Git commit IDs, not ${id}`);
  }
  const format = choice("--format", values.format, ["markdown", "json"], "markdown");
  const jsonOutput = values["json-output"];
  if (jsonOutput === "" || jsonOutput === "-") throw new UsageError("--json-output needs a file path");
  if (jsonOutput !== undefined && values.output !== undefined && resolve(jsonOutput) === resolve(values.output))
    throw new UsageError("--json-output and --output must be different files");
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
  // Limits use the local measurement, which a dry run has already taken.
  if (limits.limits.length) delta = { ...delta, limits: checkLimits(limits.limits, limitFigures(delta)) };
  if (precise?.plan.dryRun) {
    process.stdout.write("Dry run: nothing was sent and no delta was written.\n");
    if (delta.limits) {
      process.stdout.write(`${limitSummary(delta.limits)}\n`);
      reportLimits(delta.limits, limits);
    }
    return;
  }
  const json = `${JSON.stringify(delta, null, 2)}\n`;
  const content = format === "json" ? json : renderPullRequestDelta(delta);
  const toStdout = values.output === undefined || values.output === "-";
  if (values.output === undefined || values.output === "-") {
    process.stdout.write(content);
  } else {
    const destination = resolve(values.output);
    writePrivate(destination, content);
    process.stdout.write(`Delta: ${destination}\n`);
  }
  if (jsonOutput !== undefined) {
    const destination = resolve(jsonOutput);
    writePrivate(destination, json);
    // When standard output holds the delta itself, the path goes to standard error.
    (toStdout ? process.stderr : process.stdout).write(`JSON delta: ${destination}\n`);
  }
  if (delta.limits) reportLimits(delta.limits, limits);
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
  const [given, ...rest] = args;
  const command = resolveAlias(given);
  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(help.main);
  } else if (command === "help") {
    const topic = resolveAlias(rest[0]);
    if (rest.length > 1 || (topic !== undefined && !isCommand(topic)))
      throw new UsageError(`Unknown command: ${rest.join(" ")}`);
    process.stdout.write(help[topic ?? "main"]);
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
  // Keep a status already set, such as 3 for a passed limit.
  if (error.code === "EPIPE") process.exit(process.exitCode ?? 0);
  throw error;
});

try {
  await main(process.argv.slice(2));
} catch (error) {
  const usage = error instanceof UsageError;
  process.stderr.write(`strata: ${error instanceof Error ? error.message : String(error)}\n`);
  if (usage) process.stderr.write("Run strata --help for usage.\n");
  // A limit already reported as passed keeps its status 3 through a later failure, such as --open.
  process.exitCode = usage ? 2 : process.exitCode === overLimitStatus ? overLimitStatus : 1;
}
