#!/usr/bin/env node

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { analyzeRepository } from "./analyze.js";
import { renderHtml } from "./report.js";

const help = `Strata — see how your agent context evolved.

Usage:
  strata analyze <repository> --output <file> [--format html|json]
  strata --help
  strata --version

Analyzes Git-tracked Claude and Codex configuration across first-parent history.
The default output format is an offline HTML report.
`;

const args = process.argv.slice(2);

try {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    process.stdout.write(help);
  } else if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    process.stdout.write(`${packageJson.version}\n`);
  } else if (args[0] === "analyze") {
    let repository: string | undefined;
    let output: string | undefined;
    let format: "html" | "json" = "html";
    for (let index = 1; index < args.length; index += 1) {
      const argument = args[index];
      if (argument === "--output") {
        output = args[++index];
        if (!output) throw new Error("--output requires a file path");
      } else if (argument === "--format") {
        const value = args[++index];
        if (value !== "html" && value !== "json") throw new Error("--format must be html or json");
        format = value;
      } else if (argument?.startsWith("-")) {
        throw new Error(`Unknown option: ${argument}`);
      } else if (!repository && argument) {
        repository = argument;
      } else {
        throw new Error(`Unexpected argument: ${argument}`);
      }
    }
    if (!repository) throw new Error("A repository path is required");
    if (!output) throw new Error("--output is required");
    const report = analyzeRepository(repository);
    const destination = resolve(output);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, format === "json" ? `${JSON.stringify(report, null, 2)}\n` : renderHtml(report));
    chmodSync(destination, 0o600);
    const latest = report.revisions.at(-1);
    process.stdout.write(`Analyzed ${report.revisions.length} revisions of ${report.repository}.\n`);
    process.stdout.write(`Latest: ${latest?.components.length ?? 0} tracked components, ${latest?.estimatedTokens ?? 0} estimated stored-text tokens.\n`);
    process.stdout.write(`Report: ${destination}\n`);
    if (report.shallow) process.stderr.write("Warning: shallow clone; earlier history is unavailable.\n");
  } else {
    throw new Error(`Unknown command: ${args[0]}`);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\nRun strata --help for usage.\n`);
  process.exitCode = 2;
}
