import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sourceDigest } from "../scripts/source-digest.mjs";

// The Action's install step, run with stand-ins for npm and pnpm that record
// their calls: it takes the npm package only when that package was built from
// the Action's own source, and builds from source otherwise.

const action = readFileSync("action.yml", "utf8");
const script = action
  .split("    - name: Install Strata")[1]
  .split("    - name: ")[0]
  .split("      run: |\n")[1]
  .split("\n")
  .map((line) => line.slice(8))
  .join("\n");

const fakeNpm = `#!/usr/bin/env bash
echo "npm $*" >> "$FAKE_LOG"
case "$1" in
  install)
    [ "$2" = --global ] && exit 0
    [ -n "\${FAKE_NPM_FAIL:-}" ] && exit 1
    mkdir -p "$3/node_modules/context-strata/dist"
    echo "$FAKE_NPM_DIGEST" > "$3/node_modules/context-strata/dist/source-digest.txt" ;;
  audit) [ -z "\${FAKE_AUDIT_FAIL:-}" ] ;;
esac
`;
const fakePnpm = `#!/usr/bin/env bash
echo "pnpm $*" >> "$FAKE_LOG"
if [ "$1" = build ]; then mkdir -p dist && node scripts/source-digest.mjs --write dist/source-digest.txt; fi
`;

function setup() {
  const temp = mkdtempSync(join(tmpdir(), "strata-action-install-"));
  const source = join(temp, "action");
  for (const path of [
    "package.json",
    "pnpm-lock.yaml",
    "tsconfig.json",
    "src",
    "skills",
    "scripts/source-digest.mjs",
  ]) {
    cpSync(path, join(source, path), { recursive: true });
  }
  const bin = join(temp, "bin");
  mkdirSync(bin);
  for (const [name, text] of [
    ["npm", fakeNpm],
    ["pnpm", fakePnpm],
  ]) {
    writeFileSync(join(bin, name), text);
    chmodSync(join(bin, name), 0o755);
  }
  const runnerTemp = join(temp, "runner");
  mkdirSync(runnerTemp);
  const log = join(temp, "calls.log");
  const run = (env = {}) => {
    const output = join(temp, `output-${Math.random()}`);
    writeFileSync(log, "");
    const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_ACTION_PATH: source,
        RUNNER_TEMP: runnerTemp,
        GITHUB_OUTPUT: output,
        FAKE_LOG: log,
        FAKE_NPM_DIGEST: sourceDigest(source),
        ...env,
      },
    });
    let outputs = {};
    try {
      outputs = Object.fromEntries(
        readFileSync(output, "utf8")
          .trim()
          .split("\n")
          .map((line) => line.split(/=(.*)/s).slice(0, 2)),
      );
    } catch {}
    return { ...result, outputs, calls: readFileSync(log, "utf8") };
  };
  return { temp, source, runnerTemp, run, cleanup: () => rmSync(temp, { recursive: true, force: true }) };
}

const { version } = JSON.parse(readFileSync("package.json", "utf8"));

test("the Action uses the npm package built from its own source, and checks its signatures", () => {
  const { runnerTemp, run, cleanup } = setup();
  try {
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.outputs.install, "npm");
    assert.equal(first.outputs.dist, join(runnerTemp, `strata-npm-${version}`, "node_modules/context-strata/dist"));
    assert.match(
      first.calls,
      new RegExp(`npm install --prefix \\S+ .*context-strata@${version.replaceAll(".", "\\.")}`),
    );
    assert.match(first.calls, /npm audit signatures/);
    assert.doesNotMatch(first.calls, /pnpm/);
    const again = run();
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.outputs.install, "npm");
    assert.equal(again.calls, "", "a later call in the job reuses the package");
  } finally {
    cleanup();
  }
});

test("the Action builds from its source when the npm package was built from other source", () => {
  const { source, run, cleanup } = setup();
  try {
    const first = run({ FAKE_NPM_DIGEST: "sha256-other" });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.outputs.install, "source");
    assert.equal(first.outputs.dist, join(source, "dist"));
    assert.match(first.stdout, /differs from context-strata@/);
    assert.match(first.calls, /pnpm install --frozen-lockfile\npnpm build/);
    assert.doesNotMatch(first.calls, /npm audit/);
    const again = run({ FAKE_NPM_DIGEST: "sha256-other" });
    assert.equal(again.outputs.install, "source");
    assert.equal(again.calls, "", "a later call in the job reuses the build");
  } finally {
    cleanup();
  }
});

test("the Action builds from its source when npm cannot serve the package", () => {
  const { run, cleanup } = setup();
  try {
    const result = run({ FAKE_NPM_FAIL: "1" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.outputs.install, "source");
    assert.match(result.stdout, /::notice title=Strata::context-strata@\S+ could not be installed from npm/);
    assert.match(result.calls, /pnpm build/);
  } finally {
    cleanup();
  }
});

test("the Action stops when the npm package fails its signature check", () => {
  const { run, cleanup } = setup();
  try {
    const result = run({ FAKE_AUDIT_FAIL: "1" });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /::error title=Strata::context-strata@\S+ from npm failed its signature check/);
    assert.equal(result.outputs.install, undefined);
    assert.doesNotMatch(result.calls, /pnpm/);
    const again = run();
    assert.match(again.calls, /npm install --prefix/, "a later call does not reuse the rejected package");
    assert.match(again.calls, /npm audit signatures/);
  } finally {
    cleanup();
  }
});

test("the source digest covers the build inputs only", () => {
  const { source, cleanup } = setup();
  try {
    const before = sourceDigest(source);
    writeFileSync(join(source, "README.md"), "not a build input\n");
    writeFileSync(join(source, "src", ".DS_Store"), "untracked\n");
    assert.equal(sourceDigest(source), before);
    writeFileSync(join(source, "src", "cli.ts"), `${readFileSync(join(source, "src", "cli.ts"), "utf8")}\n`);
    assert.notEqual(sourceDigest(source), before);
  } finally {
    cleanup();
  }
});
