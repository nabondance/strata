// Packs Strata, installs the tarball in a clean directory, and runs the installed
// `strata` command against this repository's own history, so CI checks the
// package users get rather than the build output in dist/.
//
// Usage: node scripts/smoke-package.mjs [--pack-destination <dir>]
// With --pack-destination, the tarball is kept there and its path is printed on
// the last line. Everything else is removed afterwards. Needs a full clone
// (fetch-depth: 0).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repository = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
let packDestination;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] !== "--pack-destination") throw new Error(`Unknown option: ${args[index]}`);
  const value = args[++index];
  if (!value) throw new Error("--pack-destination requires a directory");
  packDestination = resolve(value);
}

function run(command, commandArgs, options = {}) {
  return execFileSync(command, commandArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...options });
}
function check(condition, message) {
  if (!condition) throw new Error(`Smoke test failed: ${message}`);
  console.log(`ok: ${message}`);
}

// The report must work offline. Its only absolute URLs may be links the reader
// clicks, XML namespaces, and code comments; anything else (a script, style,
// image, font, frame, or fetch) would load from the network when opened.
function networkReferences(html) {
  const found = [];
  for (const match of html.matchAll(/https?:\/\/[^\s"'<>)]*/gi)) {
    const before = html.slice(Math.max(0, match.index - 300), match.index);
    const line = before.slice(before.lastIndexOf("\n") + 1);
    const link = /<a\b[^<>]*\bhref=["']?$/i.test(before);
    const namespace = /\bxmlns(?::\w+)?=["']?$/i.test(before);
    const comment = /(?:^|\s)\/\/\s/.test(line);
    if (!link && !namespace && !comment) found.push(match[0]);
  }
  return found;
}

const work = mkdtempSync(join(tmpdir(), "strata-smoke-"));
try {
  const pack = packDestination ?? join(work, "pack");
  const install = join(work, "install");
  const out = join(work, "out");
  mkdirSync(out, { recursive: true });

  const { name, version } = JSON.parse(readFileSync(join(repository, "package.json"), "utf8"));
  run("pnpm", ["pack", "--pack-destination", pack], { cwd: repository });
  const tarball = join(pack, `${name}-${version}.tgz`);
  check(statSync(tarball).size > 0, `packed ${name}-${version}.tgz`);

  run("npm", ["install", "--prefix", install, "--no-audit", "--no-fund", tarball]);
  const strata = (...commandArgs) => run(join(install, "node_modules", ".bin", "strata"), commandArgs, { cwd: out });

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
  const remote = networkReferences(html);
  check(
    remote.length === 0,
    `HTML report loads nothing from the network${remote.length ? `: ${remote.join(", ")}` : ""}`,
  );

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

  if (packDestination) console.log(tarball);
} finally {
  rmSync(work, { recursive: true, force: true });
}
