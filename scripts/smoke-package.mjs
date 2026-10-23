// Packs Strata, installs the tarball in a clean directory, and runs the installed
// `strata` command against this repository's own history, so CI checks the
// package users get rather than the build output in dist/.
//
// Usage: node scripts/smoke-package.mjs [--pack-destination <dir>]
// Prints the tarball path on the last line. Needs a full clone (fetch-depth: 0).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repository = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
let packDestination;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--pack-destination" && args[index + 1]) packDestination = resolve(args[++index]);
  else throw new Error(`Unknown option: ${args[index]}`);
}

const work = mkdtempSync(join(tmpdir(), "strata-smoke-"));
packDestination ??= join(work, "pack");
const install = join(work, "install");
const out = join(work, "out");

function run(command, commandArgs, options = {}) {
  return execFileSync(command, commandArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...options });
}
function check(condition, message) {
  if (!condition) throw new Error(`Smoke test failed: ${message}`);
  console.log(`ok: ${message}`);
}

const { name, version } = JSON.parse(readFileSync(join(repository, "package.json"), "utf8"));
run("pnpm", ["pack", "--pack-destination", packDestination], { cwd: repository });
const tarball = join(packDestination, `${name}-${version}.tgz`);
check(statSync(tarball).size > 0, `packed ${name}-${version}.tgz`);

run("npm", ["install", "--prefix", install, "--no-audit", "--no-fund", tarball]);
const strata = (...commandArgs) => run(join(install, "node_modules", ".bin", "strata"), commandArgs, { cwd: out });
mkdirSync(out, { recursive: true });

check(strata("--version").trim() === version, `strata --version prints ${version}`);
check(/^ {2}analyze /m.test(strata("--help")), "strata --help lists analyze");
strata("skill", "--output", "skill.md");
check(readFileSync(join(out, "skill.md"), "utf8").startsWith("---\n"), "strata skill writes the skill file");

strata("analyze", repository, "--quiet", "--format", "json", "--output", "report.json");
const report = JSON.parse(readFileSync(join(out, "report.json"), "utf8"));
check(Number.isInteger(report.schemaVersion), `JSON report has schema version ${report.schemaVersion}`);
check(report.revisions.length > 1 && !report.shallow, `JSON report covers ${report.revisions.length} revisions`);
check(report.components.length > 0, `JSON report lists ${report.components.length} components`);

strata("analyze", repository, "--quiet", "--output", "report.html");
const html = readFileSync(join(out, "report.html"), "utf8");
check(html.startsWith("<!doctype html>") && html.trimEnd().endsWith("</html>"), "HTML report is a complete page");
check(!/<(script|link|img)[^>]+(src|href)="https?:/i.test(html), "HTML report loads nothing from the network");

strata("analyze", repository, "--quiet", "--format", "svg", "--output", "report.svg");
const svg = readFileSync(join(out, "report.svg"), "utf8");
check(svg.startsWith("<svg") && svg.trimEnd().endsWith("</svg>"), "SVG image is complete");

strata("analyze", repository, "--quiet", "--format", "badge", "--output", "badge.json");
const badge = JSON.parse(readFileSync(join(out, "badge.json"), "utf8"));
check(badge.schemaVersion === 1 && /tokens/.test(badge.message), `badge reads "${badge.message}"`);

const head = run("git", ["-C", repository, "rev-parse", "HEAD"]).trim();
const base = run("git", ["-C", repository, "rev-parse", "HEAD~1"]).trim();
check(
  strata("diff", repository, "--base", base, "--head", head).length > 0,
  "strata diff compares the last two commits",
);

console.log(tarball);
