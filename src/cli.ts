#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { analyzeRepository } from "./analyze.js";
import { renderHtml } from "./report.js";
import { redactReport } from "./privacy.js";
import { modeForModel, type MeasurementMode } from "./measurement.js";
import { compareGitCommits, renderPullRequestDelta } from "./pr-delta.js";
import type { ProviderCountOptions } from "./provider-count.js";

const help = `Strata — see how your agent context evolved.

Usage:
  strata analyze <repository> [--output <file>] [--format html|json] [--open] [--shareable] [--tokenizer estimate|openai-cl100k_base|openai-o200k_base | --model <name> | --provider-api --claude-model <name> --gemini-model <name> [--codex-model <name>]]
  strata diff <repository> --base <commit> --head <commit> [--output <file>] [--format markdown|json] [--tokenizer estimate|openai-cl100k_base|openai-o200k_base | --model <name>]
  strata skill [--output <file>]
  strata --help
  strata --version

Analyzes Git-tracked Claude, Codex, and Gemini CLI configuration across first-parent history.
The default output is an offline HTML report in a private temporary directory.
Use --shareable to replace repository names, paths, commit IDs, and blob IDs with aliases.
Use --tokenizer to select an offline stored-text measurement; the default is estimate.
Use --model for a documented OpenAI model mapping (gpt-4, gpt-4o, gpt-4.1, gpt-5, o3, o4-mini).
Use --provider-api to explicitly send recognized Claude and Gemini instruction text to their token-count APIs. This is opt-in content transfer. Set ANTHROPIC_API_KEY and GEMINI_API_KEY (or GOOGLE_API_KEY); name both API models. Add --codex-model to include a local OpenAI encoding count for Codex files.
Use diff for a read-only comparison of two full Git commit IDs, such as a PR base and head.
Use --open to open an HTML report in your browser.
Use skill to print the bundled JSON interpretation skill, or --output to save it.
`;

function openReport(path: string): void {
  const url = pathToFileURL(path).href;
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32.exe" : "xdg-open";
  const arguments_ = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  const result = spawnSync(command, arguments_, { stdio: "ignore" });
  if (result.error || result.status !== 0) {
    throw new Error(`Could not open the report in a browser. Open this file manually: ${path}`);
  }
}

const args = process.argv.slice(2);

try {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    process.stdout.write(help);
  } else if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    process.stdout.write(`${packageJson.version}\n`);
  } else if (args[0] === "skill") {
    if (args.length !== 1 && (args.length !== 3 || args[1] !== "--output" || !args[2])) {
      throw new Error("Usage: strata skill [--output <file>]");
    }
    const skill = readFileSync(new URL("../skills/strata-interpret/SKILL.md", import.meta.url), "utf8");
    if (args.length === 1) {
      process.stdout.write(skill);
    } else {
      const destination = resolve(args[2]!);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, skill, { flag: "wx", mode: 0o600 });
      process.stdout.write(`Skill: ${destination}\n`);
    }
  } else if (args[0] === "diff") {
    let repository: string | undefined;
    let base: string | undefined;
    let head: string | undefined;
    let output: string | undefined;
    let format: "markdown" | "json" = "markdown";
    let tokenizer: MeasurementMode = "estimate";
    let tokenizerSelected = false;
    let model: string | null = null;
    for (let index = 1; index < args.length; index += 1) {
      const argument = args[index];
      if (argument === "--base") {
        base = args[++index];
      } else if (argument === "--head") {
        head = args[++index];
      } else if (argument === "--output") {
        output = args[++index];
        if (!output) throw new Error("--output requires a file path");
      } else if (argument === "--format") {
        const value = args[++index];
        if (value !== "markdown" && value !== "json") throw new Error("--format must be markdown or json");
        format = value;
      } else if (argument === "--tokenizer") {
        const value = args[++index];
        if (value !== "estimate" && value !== "openai-cl100k_base" && value !== "openai-o200k_base") {
          throw new Error("--tokenizer must be estimate, openai-cl100k_base, or openai-o200k_base");
        }
        tokenizer = value;
        tokenizerSelected = true;
      } else if (argument === "--model") {
        model = args[++index] ?? null;
        if (!model) throw new Error("--model requires a model name");
      } else if (argument?.startsWith("-")) {
        throw new Error(`Unknown option: ${argument}`);
      } else if (!repository && argument) {
        repository = argument;
      } else {
        throw new Error(`Unexpected argument: ${argument}`);
      }
    }
    if (!repository || !base || !head) throw new Error("Usage: strata diff <repository> --base <commit> --head <commit>");
    if (model && tokenizerSelected) throw new Error("Choose either --model or --tokenizer");
    const delta = compareGitCommits(repository, base, head, model ? modeForModel(model) : tokenizer, model);
    const content = format === "json" ? `${JSON.stringify(delta, null, 2)}\n` : renderPullRequestDelta(delta);
    if (output) {
      const destination = resolve(output);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, content);
      chmodSync(destination, 0o600);
      process.stdout.write(`Delta: ${destination}\n`);
    } else {
      process.stdout.write(content);
    }
  } else if (args[0] === "analyze") {
    let repository: string | undefined;
    let output: string | undefined;
    let format: "html" | "json" = "html";
    let open = false;
    let shareable = false;
    let tokenizer: MeasurementMode = "estimate";
    let tokenizerSelected = false;
    let model: string | null = null;
    let providerApi = false;
    let claudeModel: string | undefined;
    let geminiModel: string | undefined;
    let codexModel: string | undefined;
    for (let index = 1; index < args.length; index += 1) {
      const argument = args[index];
      if (argument === "--output") {
        output = args[++index];
        if (!output) throw new Error("--output requires a file path");
      } else if (argument === "--format") {
        const value = args[++index];
        if (value !== "html" && value !== "json") throw new Error("--format must be html or json");
        format = value;
      } else if (argument === "--open") {
        open = true;
      } else if (argument === "--shareable") {
        shareable = true;
      } else if (argument === "--tokenizer") {
        const value = args[++index];
        if (value !== "estimate" && value !== "openai-cl100k_base" && value !== "openai-o200k_base") {
          throw new Error("--tokenizer must be estimate, openai-cl100k_base, or openai-o200k_base");
        }
        tokenizer = value;
        tokenizerSelected = true;
      } else if (argument === "--model") {
        model = args[++index] ?? null;
        if (!model) throw new Error("--model requires a model name");
      } else if (argument === "--provider-api") {
        providerApi = true;
      } else if (argument === "--claude-model") {
        claudeModel = args[++index];
        if (!claudeModel) throw new Error("--claude-model requires a model name");
      } else if (argument === "--gemini-model") {
        geminiModel = args[++index];
        if (!geminiModel) throw new Error("--gemini-model requires a model name");
      } else if (argument === "--codex-model") {
        codexModel = args[++index];
        if (!codexModel) throw new Error("--codex-model requires a model name");
      } else if (argument?.startsWith("-")) {
        throw new Error(`Unknown option: ${argument}`);
      } else if (!repository && argument) {
        repository = argument;
      } else {
        throw new Error(`Unexpected argument: ${argument}`);
      }
    }
    if (!repository) throw new Error("A repository path is required");
    if (open && format !== "html") throw new Error("--open requires HTML output");
    if (model && tokenizerSelected) throw new Error("Choose either --model or --tokenizer");
    if (providerApi && (model || tokenizerSelected)) throw new Error("Choose either --provider-api or --model/--tokenizer");
    if (providerApi && (!claudeModel || !geminiModel)) throw new Error("--provider-api requires explicit --claude-model and --gemini-model values");
    if (!providerApi && (claudeModel || geminiModel || codexModel)) throw new Error("--claude-model, --gemini-model, and --codex-model require --provider-api");
    let providerCounts: ProviderCountOptions | undefined;
    if (providerApi) {
      const geminiApiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
      providerCounts = {
        claudeModel: claudeModel!, geminiModel: geminiModel!,
        ...(codexModel ? { codexModel } : {}),
        ...(process.env.ANTHROPIC_API_KEY ? { anthropicApiKey: process.env.ANTHROPIC_API_KEY } : {}),
        ...(geminiApiKey ? { geminiApiKey } : {}),
      };
    }
    let lastDecile = 0;
    const analyzed = await analyzeRepository(repository, ({ completed, total }) => {
      if (completed === 0) {
        process.stderr.write(`Analyzing ${total} revisions...\n`);
      } else {
        const decile = Math.floor(completed * 10 / total);
        if (decile > lastDecile || completed === total) {
          process.stderr.write(`Processed ${completed}/${total} revisions.\n`);
          lastDecile = decile;
        }
      }
    }, model ? modeForModel(model) : tokenizer, model, providerCounts);
    const report = shareable ? redactReport(analyzed) : analyzed;
    const destination = output
      ? resolve(output)
      : join(mkdtempSync(join(tmpdir(), "strata-report-")), format === "json" ? "report.json" : "report.html");
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, format === "json" ? `${JSON.stringify(report, null, 2)}\n` : renderHtml(report));
    chmodSync(destination, 0o600);
    const latest = report.revisions.at(-1);
    process.stdout.write(`Analyzed ${report.revisions.length} revisions of ${report.repository}.\n`);
    process.stdout.write(`Latest: ${latest?.components.length ?? 0} tracked components, ${latest?.estimatedTokens ?? 0} stored-text tokens (${report.measurement.method}).\n`);
    process.stdout.write(`Report: ${destination}\n`);
    if (report.shallow) process.stderr.write("Warning: shallow clone; earlier history is unavailable.\n");
    if (open) openReport(destination);
  } else {
    throw new Error(`Unknown command: ${args[0]}`);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\nRun strata --help for usage.\n`);
  process.exitCode = 2;
}
