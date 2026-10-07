#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { analyzeRepository } from "./analyze.js";
import { renderHtml } from "./report.js";

const help = `Strata — see how your agent context evolved.

Usage:
  strata analyze <repository> [--output <file>] [--format html|json] [--open]
  strata skill [--output <file>]
  strata --help
  strata --version

Analyzes Git-tracked Claude and Codex configuration across first-parent history.
The default output is an offline HTML report in a private temporary directory.
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
  } else if (args[0] === "analyze") {
    let repository: string | undefined;
    let output: string | undefined;
    let format: "html" | "json" = "html";
    let open = false;
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
    let lastDecile = 0;
    const report = analyzeRepository(repository, ({ completed, total }) => {
      if (completed === 0) {
        process.stderr.write(`Analyzing ${total} revisions...\n`);
      } else {
        const decile = Math.floor(completed * 10 / total);
        if (decile > lastDecile || completed === total) {
          process.stderr.write(`Processed ${completed}/${total} revisions.\n`);
          lastDecile = decile;
        }
      }
    });
    const destination = output
      ? resolve(output)
      : join(mkdtempSync(join(tmpdir(), "strata-report-")), format === "json" ? "report.json" : "report.html");
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, format === "json" ? `${JSON.stringify(report, null, 2)}\n` : renderHtml(report));
    chmodSync(destination, 0o600);
    const latest = report.revisions.at(-1);
    process.stdout.write(`Analyzed ${report.revisions.length} revisions of ${report.repository}.\n`);
    process.stdout.write(`Latest: ${latest?.components.length ?? 0} tracked components, ${latest?.estimatedTokens ?? 0} estimated stored-text tokens.\n`);
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
