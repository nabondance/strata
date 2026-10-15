import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";
import { getEncoding } from "js-tiktoken";
import { analyzeRepository } from "../dist/analyze.js";
import { expandRevisions } from "../dist/expand.js";
import { defaultModels, resolvePrecisePlan } from "../dist/precise.js";
import { renderHtml } from "../dist/report.js";

const cliPath = resolve("dist/cli.js");
const noKeys = { ANTHROPIC_API_KEY: "", GEMINI_API_KEY: "", GOOGLE_API_KEY: "", GOOGLE_CLOUD_PROJECT: "" };

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), "strata-precise-"));
  const git = (...args) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  const put = (path, content) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  };
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Strata Test");
  git("config", "user.email", "strata-test@example.invalid");
  git("config", "commit.gpgsign", "false");
  put("CLAUDE.md", "Claude instructions.\n");
  put("GEMINI.md", "Gemini instructions.\n");
  put("AGENTS.md", "Shared instructions.\n");
  git("add", "-A");
  git("commit", "-q", "-m", "Add instructions");
  return repo;
}

/** A provider CLI stub: `ant` and `gcloud` print what `outputs` maps their arguments to, or fail. */
const cliStub = (outputs) => (command, args) => outputs[`${command} ${args.join(" ")}`] ?? null;

const signedIn = cliStub({
  "ant auth print-credentials --access-token": "ant-session-token",
  "gcloud config get-value project": "strata-test-project",
  "gcloud auth print-access-token": "gcloud-session-token",
});

/** Records each request and answers like the count endpoints, or with `status` for chosen hosts. */
function countServer(failing = {}) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const host = new URL(url).host;
    requests.push({ url, host, headers: init.headers, body: JSON.parse(init.body) });
    if (failing[host]) return new Response("{}", { status: failing[host] });
    const tokens = host === "api.anthropic.com" ? { input_tokens: 7 } : { totalTokens: 9 };
    return new Response(JSON.stringify(tokens), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { requests, fetchImpl };
}

const summary = (report) =>
  Object.fromEntries(
    report.providerMeasurements.map(({ provider, accuracy, credential, recipient }) => [
      provider,
      [accuracy, credential ?? null, recipient ?? null],
    ]),
  );

test("--precise uses a signed-in account through the provider CLI, with default models", async () => {
  const repo = fixture();
  try {
    const { requests, fetchImpl } = countServer();
    const notices = [];
    const report = await analyzeRepository(repo, {
      providerPlan: resolvePrecisePlan({ env: noKeys, run: signedIn, fetchImpl }),
      onNotice: (line) => notices.push(line),
    });
    assert.equal(report.schemaVersion, 11);
    assert.deepEqual(summary(report), {
      claude: ["api-counted", "signed-in Anthropic account (ant auth login)", "api.anthropic.com"],
      gemini: ["api-counted", "signed-in Google Cloud account (gcloud, Vertex AI)", "aiplatform.googleapis.com"],
      codex: ["encoding-exact", null, null],
    });
    assert.deepEqual(
      report.providerMeasurements.map(({ model }) => model),
      [defaultModels.claude, defaultModels.gemini, defaultModels.codex],
    );
    assert.ok(report.providerMeasurements.every((measured) => !measured.fallbacks));

    const claude = requests.filter(({ host }) => host === "api.anthropic.com");
    assert.equal(claude.length, 2, "CLAUDE.md and AGENTS.md");
    assert.equal(claude[0].headers.authorization, "Bearer ant-session-token");
    assert.equal(claude[0].headers["anthropic-beta"], "oauth-2025-04-20");
    assert.equal(claude[0].headers["x-api-key"], undefined);
    const vertex = requests.filter(({ host }) => host === "aiplatform.googleapis.com");
    assert.equal(vertex.length, 1, "GEMINI.md only; the fixture leaves AGENTS.md out of Gemini's context");
    assert.equal(
      vertex[0].url,
      `https://aiplatform.googleapis.com/v1/projects/strata-test-project/locations/global/publishers/google/models/${defaultModels.gemini}:countTokens`,
    );
    assert.equal(vertex[0].headers.authorization, "Bearer gcloud-session-token");
    assert.equal(requests.length, 3, "Codex is counted locally");

    const [revision] = expandRevisions(report);
    const agents = revision.components.find((component) => component.path === "AGENTS.md");
    assert.equal(agents.providerTokenCounts.claude.tokens, 7);
    assert.equal(
      agents.providerTokenCounts.codex.tokens,
      getEncoding("o200k_base").encode("Shared instructions.\n").length,
    );
    assert.deepEqual(revision.providerTokenTotals, {
      claude: 14,
      gemini: 9,
      codex: revision.providerTokenTotals.codex,
    });
    assert.equal(notices.length, 2);
    assert.match(notices[0], /Sending 2 Claude instruction file versions to api\.anthropic\.com/);
    assert.match(notices[1], /Sending 1 Gemini instruction file version to aiplatform\.googleapis\.com/);

    const json = JSON.stringify(report);
    for (const secret of ["ant-session-token", "gcloud-session-token", "strata-test-project", "Shared instructions."]) {
      assert.ok(!json.includes(secret), secret);
      assert.ok(!notices.join("\n").includes(secret), secret);
    }
    const html = renderHtml(report);
    assert.match(
      html,
      /Claude text was sent to api\.anthropic\.com; Gemini text was sent to aiplatform\.googleapis\.com/,
    );
    assert.match(html, /<th class="num"[^>]*>Codex local exact<\/th>/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("--precise uses API keys from the environment when no account is signed in", async () => {
  const repo = fixture();
  try {
    const { requests, fetchImpl } = countServer();
    const report = await analyzeRepository(repo, {
      providerPlan: resolvePrecisePlan({
        env: { ...noKeys, ANTHROPIC_API_KEY: "anthropic-test-key", GOOGLE_API_KEY: "google-test-key" },
        run: cliStub({}),
        claudeModel: "claude-test-model",
        geminiModel: "gemini-test-model",
        fetchImpl,
      }),
    });
    assert.deepEqual(summary(report), {
      claude: ["api-counted", "ANTHROPIC_API_KEY", "api.anthropic.com"],
      gemini: ["api-counted", "GOOGLE_API_KEY", "generativelanguage.googleapis.com"],
      codex: ["encoding-exact", null, null],
    });
    assert.deepEqual(report.providerMeasurements[0].fallbacks, [
      "no signed-in Anthropic account: `ant auth print-credentials` gave no token",
    ]);
    assert.deepEqual(report.providerMeasurements[1].fallbacks, [
      "no Google Cloud project: set GOOGLE_CLOUD_PROJECT or `gcloud config set project`",
    ]);
    assert.equal(report.providerMeasurements[0].model, "claude-test-model");
    assert.ok(requests.every(({ headers }) => !headers.authorization));
    assert.equal(requests.find(({ host }) => host === "api.anthropic.com").headers["x-api-key"], "anthropic-test-key");
    const gemini = requests.find(({ host }) => host === "generativelanguage.googleapis.com");
    assert.equal(gemini.headers["x-goog-api-key"], "google-test-key");
    assert.match(gemini.url, /\/v1beta\/models\/gemini-test-model:countTokens$/);
    const json = JSON.stringify(report);
    assert.ok(!json.includes("anthropic-test-key") && !json.includes("google-test-key"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("--precise falls back to the estimate without an account or key, and sends nothing", async () => {
  const repo = fixture();
  try {
    const { requests, fetchImpl } = countServer();
    const notices = [];
    const report = await analyzeRepository(repo, {
      providerPlan: resolvePrecisePlan({ env: noKeys, run: cliStub({}), fetchImpl }),
      onNotice: (line) => notices.push(line),
    });
    assert.equal(requests.length, 0);
    assert.deepEqual(notices, []);
    assert.deepEqual(summary(report), {
      claude: ["estimate", null, null],
      gemini: ["estimate", null, null],
      codex: ["encoding-exact", null, null],
    });
    assert.equal(report.providerMeasurements[0].model, null);
    assert.deepEqual(report.providerMeasurements[0].fallbacks, [
      "no signed-in Anthropic account: `ant auth print-credentials` gave no token",
      "ANTHROPIC_API_KEY is not set",
      "no local exact Claude tokenizer exists",
    ]);
    const [revision] = expandRevisions(report);
    const claudeFile = revision.components.find((component) => component.path === "CLAUDE.md");
    assert.equal(claudeFile.providerTokenCounts.claude.tokens, claudeFile.estimatedTokens);
    assert.equal(claudeFile.providerTokenCounts.claude.accuracy, "estimate");
    const html = renderHtml(report);
    assert.match(html, /No instruction text was sent to a provider\./);
    assert.match(html, /Claude fell back to estimate: /);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a failing method is discarded whole, so one provider's counts never mix methods", async () => {
  const repo = fixture();
  try {
    // The signed-in Claude account is rejected; the key works. Vertex fails with no key behind it.
    const { requests, fetchImpl } = countServer({ "aiplatform.googleapis.com": 403 });
    let rejectedOnce = false;
    const mixed = async (url, init) => {
      if (init.headers.authorization === "Bearer ant-session-token" && !rejectedOnce) {
        rejectedOnce = true;
        return new Response("{}", { status: 401 });
      }
      return fetchImpl(url, init);
    };
    const notices = [];
    const report = await analyzeRepository(repo, {
      providerPlan: resolvePrecisePlan({
        env: { ...noKeys, ANTHROPIC_API_KEY: "anthropic-test-key" },
        run: signedIn,
        fetchImpl: mixed,
      }),
      onNotice: (line) => notices.push(line),
    });
    assert.deepEqual(summary(report), {
      claude: ["api-counted", "ANTHROPIC_API_KEY", "api.anthropic.com"],
      gemini: ["estimate", null, null],
      codex: ["encoding-exact", null, null],
    });
    assert.deepEqual(report.providerMeasurements[0].fallbacks, [
      "signed-in Anthropic account (ant auth login) failed: claude token count request failed with HTTP 401",
    ]);
    assert.deepEqual(report.providerMeasurements[1].fallbacks, [
      "signed-in Google Cloud account (gcloud, Vertex AI) failed: gemini token count request failed with HTTP 403",
      "GEMINI_API_KEY and GOOGLE_API_KEY are not set",
      "no local exact Gemini tokenizer exists",
    ]);
    const [revision] = expandRevisions(report);
    for (const component of revision.components) {
      const claude = component.providerTokenCounts?.claude;
      if (claude) assert.equal(claude.tokens, 7, `${component.path} is counted with the key, not a mix`);
    }
    assert.ok(requests.some(({ headers }) => headers["x-api-key"] === "anthropic-test-key"));
    assert.ok(notices.some((line) => /HTTP 401; trying the next method/.test(line)));
    // Paths stay out of the recorded reasons, which shareable reports keep.
    assert.ok(!JSON.stringify(report.providerMeasurements).includes(".md"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("strata analyze --precise reports each provider's method and what it skipped", () => {
  const repo = fixture();
  const bin = mkdtempSync(join(tmpdir(), "strata-bin-"));
  try {
    // Provider CLIs that are installed but signed out.
    for (const name of ["ant", "gcloud"]) {
      writeFileSync(join(bin, name), "#!/bin/sh\nexit 1\n");
      chmodSync(join(bin, name), 0o755);
    }
    const output = join(repo, "report.json");
    const result = spawnSync(
      process.execPath,
      [cliPath, "analyze", repo, "--precise", "--format", "json", "-o", output],
      {
        encoding: "utf8",
        env: { ...process.env, ...noKeys, PATH: `${bin}${delimiter}${process.env.PATH}` },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Claude: \d+ tokens latest, byte estimate\./);
    assert.match(result.stdout, /Skipped: ANTHROPIC_API_KEY is not set\./);
    assert.match(result.stdout, new RegExp(`Codex: \\d+ tokens latest, encoding-exact with ${defaultModels.codex}\\.`));
    assert.doesNotMatch(result.stderr, /Sending/);
    const report = JSON.parse(readFileSync(output, "utf8"));
    assert.deepEqual(
      report.providerMeasurements.map(({ accuracy }) => accuracy),
      ["estimate", "estimate", "encoding-exact"],
    );

    for (const [args, message] of [
      [["--precise", "--provider-api"], /Choose either --precise or --provider-api/],
      [["--precise", "--model", "gpt-4o"], /Choose either --precise or --model\/--tokenizer/],
      [["--precise", "--codex-model", "gpt-unknown"], /Unsupported model: gpt-unknown/],
    ]) {
      const invalid = spawnSync(process.execPath, [cliPath, "analyze", repo, ...args], { encoding: "utf8" });
      assert.equal(invalid.status, 2, args.join(" "));
      assert.match(invalid.stderr, message);
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});
