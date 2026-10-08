import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { analyzeRepository } from "../dist/analyze.js";

function positiveInteger(value, option) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${option} must be a positive integer`);
  return number;
}

const args = process.argv.slice(2);
let repository;
let commitCount = 1000;
let fileCount = 32;
for (let index = 0; index < args.length; index += 1) {
  const option = args[index];
  if (option === "--repo") {
    const path = args[++index];
    if (!path) throw new Error("--repo requires a repository path");
    repository = resolve(path);
  }
  else if (option === "--commits") commitCount = positiveInteger(args[++index], option);
  else if (option === "--files") fileCount = positiveInteger(args[++index], option);
  else throw new Error(`Unknown benchmark option: ${option}`);
}

let fixture;
try {
  if (!repository) {
    fixture = mkdtempSync(join(tmpdir(), "strata-benchmark-"));
    const git = (...arguments_) => execFileSync("git", ["-C", fixture, ...arguments_], { stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Strata Benchmark");
    git("config", "user.email", "benchmark@example.invalid");
    for (let index = 0; index < fileCount; index += 1) {
      const path = join(fixture, ".claude", "skills", `skill-${index}`, "SKILL.md");
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, `---\nname: skill-${index}\n---\nInitial instructions.\n`);
    }
    git("add", "-A");
    git("commit", "-qm", "Initial skills");
    for (let revision = 1; revision < commitCount; revision += 1) {
      const index = revision % fileCount;
      const path = join(fixture, ".claude", "skills", `skill-${index}`, "SKILL.md");
      writeFileSync(path, `---\nname: skill-${index}\n---\nInstruction revision ${revision}.\n`);
      git("add", "-A");
      git("commit", "-qm", `Update skill ${index}`);
    }
    repository = fixture;
  }

  const started = performance.now();
  const report = analyzeRepository(repository);
  const seconds = (performance.now() - started) / 1000;
  const latest = report.revisions.at(-1);
  process.stdout.write(`${JSON.stringify({
    fixture: Boolean(fixture), revisions: report.revisions.length,
    latestComponents: latest?.components.length ?? 0,
    latestEstimatedTokens: latest?.estimatedTokens ?? 0,
    seconds: Number(seconds.toFixed(3)),
    revisionsPerSecond: Number((report.revisions.length / seconds).toFixed(1)),
  }, null, 2)}\n`);
} finally {
  if (fixture) rmSync(fixture, { recursive: true, force: true });
}
