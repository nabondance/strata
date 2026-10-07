#!/usr/bin/env node

import { readFileSync } from "node:fs";

const help = `Strata — see how your agent context evolved.

Usage:
  strata --help       Show this help
  strata --version    Show the package version

History analysis is not implemented yet.
`;

const args = process.argv.slice(2);

if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  process.stdout.write(help);
} else if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  process.stdout.write(`${packageJson.version}\n`);
} else {
  process.stderr.write(`Unknown arguments: ${args.join(" ")}\nRun strata --help for usage.\n`);
  process.exitCode = 2;
}
