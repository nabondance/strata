import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sourceDigest } from "../scripts/source-digest.mjs";

// The Action's install step, run with stand-ins for npm and pnpm that record
// their calls: it takes the npm package only when that package was built from
// the Action's own source and its provenance checks out, and builds from
// source otherwise.

const action = readFileSync("action.yml", "utf8");
const script = action
  .split("    - name: Install Strata")[1]
  .split("    - name: ")[0]
  .split("      run: |\n")[1]
  .split("\n")
  .map((line) => line.slice(8))
  .join("\n");

// npm pack, install, and audit signatures, with the provenance shaped as npm
// reports it. FAKE_* variables choose what each one finds.
const fakeNpm = `#!/usr/bin/env node
const { appendFileSync, mkdirSync, writeFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const { join } = require("node:path");
const env = process.env;
const args = process.argv.slice(2);
appendFileSync(env.FAKE_LOG, \`npm \${args.join(" ")}\\n\`);
const sha = "ab".repeat(64);
const writePackage = (root) => {
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "dist", "source-digest.txt"), env.FAKE_NPM_DIGEST + "\\n");
};
if (args[0] === "pack") {
  if (env.FAKE_NPM_MISSING) process.exit(1);
  const work = join(process.cwd(), "work");
  writePackage(join(work, "package"));
  execFileSync("tar", ["-czf", "context-strata.tgz", "-C", work, "package"]);
} else if (args[0] === "install" && args[1] === "--prefix") {
  const prefix = args[2];
  writePackage(join(prefix, "node_modules", "context-strata"));
  const integrity = "sha512-" + Buffer.from(env.FAKE_INSTALLED_SHA || sha, "hex").toString("base64");
  writeFileSync(join(prefix, "package-lock.json"), JSON.stringify({ packages: { "node_modules/context-strata": { integrity } } }));
} else if (args[0] === "audit") {
  if (env.FAKE_AUDIT_FAIL) process.exit(1);
  const version = env.FAKE_VERSION;
  const statement = {
    predicateType: "https://slsa.dev/provenance/v1",
    subject: [{ name: \`pkg:npm/context-strata@\${version}\`, digest: { sha512: sha } }],
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            ref: \`refs/tags/v\${version}\`,
            repository: env.FAKE_REPOSITORY || "https://github.com/nabondance/strata",
            path: ".github/workflows/publish.yml",
          },
        },
      },
    },
  };
  const payload = Buffer.from(JSON.stringify(statement)).toString("base64");
  const verified = [{ name: "context-strata", version, attestationBundles: [{ bundle: { dsseEnvelope: { payload } } }] }];
  console.log(JSON.stringify({ invalid: [], missing: [], verified }));
}
`;
const fakePnpm = `#!/usr/bin/env bash
echo "pnpm $*" >> "$FAKE_LOG"
if [ "$1" = build ]; then mkdir -p dist && node scripts/source-digest.mjs --write dist/source-digest.txt; fi
`;

const { version } = JSON.parse(readFileSync("package.json", "utf8"));

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
    "scripts/verify-npm-package.mjs",
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
        FAKE_VERSION: version,
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

test("the Action uses the npm package built from its own source, once its provenance checks out", () => {
  const { runnerTemp, run, cleanup } = setup();
  try {
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.outputs.install, "npm", first.stdout);
    assert.equal(first.outputs.dist, join(runnerTemp, `strata-npm-${version}`, "node_modules/context-strata/dist"));
    assert.match(first.calls, new RegExp(`^npm pack --silent context-strata@${version.replaceAll(".", "\\.")}$`, "m"));
    assert.match(first.calls, /^npm install --prefix \S+ .*context-strata@/m);
    assert.match(first.calls, /^npm audit signatures --prefix \S+ --json --include-attestations$/m);
    assert.doesNotMatch(first.calls, /pnpm/);
    const again = run();
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.outputs.install, "npm");
    assert.equal(again.calls, "", "a later call in the job reuses the verified package");
  } finally {
    cleanup();
  }
});

test("the Action builds from its source, without installing, when no npm package matches it", () => {
  for (const [why, env] of [
    ["built from other source", { FAKE_NPM_DIGEST: "sha256-other" }],
    ["not published", { FAKE_NPM_MISSING: "1" }],
  ]) {
    const { source, run, cleanup } = setup();
    try {
      const first = run(env);
      assert.equal(first.status, 0, first.stderr);
      assert.equal(first.outputs.install, "source", why);
      assert.equal(first.outputs.dist, join(source, "dist"));
      assert.match(first.stdout, /No context-strata@\S+ on npm was built from this Action's source/);
      assert.doesNotMatch(first.stdout, /::(notice|warning)/, `${why}: an expected case, not an annotation`);
      assert.doesNotMatch(first.calls, /npm install --prefix/);
      assert.match(first.calls, /pnpm install --frozen-lockfile\npnpm build/);
      const again = run(env);
      assert.equal(again.outputs.install, "source");
      assert.equal(again.calls, "", "a later call in the job reuses the build");
    } finally {
      cleanup();
    }
  }
});

test("the Action builds from its source when the npm package cannot be verified", () => {
  for (const [why, env] of [
    ["signature check fails", { FAKE_AUDIT_FAIL: "1" }],
    ["built in another repository", { FAKE_REPOSITORY: "https://github.com/someone/strata" }],
    ["another tarball installed", { FAKE_INSTALLED_SHA: "cd".repeat(64) }],
  ]) {
    const { runnerTemp, run, cleanup } = setup();
    try {
      const first = run(env);
      assert.equal(first.status, 0, first.stderr);
      assert.equal(first.outputs.install, "source", why);
      assert.match(
        first.stdout,
        /::warning title=Strata::context-strata@\S+ from npm could not be installed or verified/,
      );
      assert.ok(!existsSync(join(runnerTemp, `strata-npm-${version}`)), `${why}: the rejected package is removed`);
      assert.match(first.calls, /pnpm build/);
      const again = run(env);
      assert.equal(again.outputs.install, "source", "a later call reuses the build, not the rejected package");
    } finally {
      cleanup();
    }
  }
});

test("the source digest covers the build inputs only", () => {
  const { source, cleanup } = setup();
  try {
    const before = sourceDigest(source);
    writeFileSync(join(source, "README.md"), "not a build input\n");
    writeFileSync(join(source, "src", ".DS_Store"), "untracked\n");
    assert.equal(sourceDigest(source), before);
    writeFileSync(join(source, "skills", ".config"), "a tracked dotfile\n");
    assert.notEqual(sourceDigest(source), before);
    rmSync(join(source, "skills", ".config"));
    writeFileSync(join(source, "src", "cli.ts"), `${readFileSync(join(source, "src", "cli.ts"), "utf8")}\n`);
    assert.notEqual(sourceDigest(source), before);
  } finally {
    cleanup();
  }
});
