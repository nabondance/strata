import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { getEncoding } from "js-tiktoken";
import { analyzeRepository } from "../dist/analyze.js";
import { fileCountCache } from "../dist/count-cache.js";
import { expandRevisions } from "../dist/expand.js";
import { compareGitCommitsPrecise, renderPullRequestDelta } from "../dist/pr-delta.js";
import { countRemoteText } from "../dist/provider-count.js";
import { defaultModels, installHints, resolvePrecisePlan } from "../dist/precise.js";
import { renderHtml } from "../dist/report.js";

const cliPath = resolve("dist/cli.js");
const noKeys = { ANTHROPIC_API_KEY: "", GEMINI_API_KEY: "", GOOGLE_API_KEY: "", GOOGLE_CLOUD_PROJECT: "" };

function fixture(
  files = {
    "CLAUDE.md": "Claude instructions.\n",
    "GEMINI.md": "Gemini instructions.\n",
    "AGENTS.md": "Shared instructions.\n",
  },
) {
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
  for (const [path, content] of Object.entries(files)) put(path, content);
  git("add", "-A");
  git("commit", "-q", "-m", "Add instructions");
  return repo;
}

/** Installed provider CLIs that print what `outputs` maps their arguments to, or fail. */
const cliStub = (outputs) => (command, args) => ({ output: outputs[`${command} ${args.join(" ")}`] ?? null });

const signedIn = cliStub({
  "ant auth print-credentials --access-token": "ant-session-token",
  "gcloud config get-value project": "strata-test-project",
  "gcloud auth print-access-token": "gcloud-session-token",
});

/** The text a count request carries, in either provider's request shape. */
const requestText = (body) => body.messages?.[0]?.content ?? body.contents?.[0]?.parts?.[0]?.text;

/**
 * Records each request and answers like the count endpoints, or with `status` for chosen hosts.
 * Claude endpoints count a file as 7 and the one-letter wrapper probe as 3, so 2 wrapper tokens are
 * subtracted; Gemini counts a file as 9 and the probe as 1, with no wrapper.
 */
function countServer(failing = {}) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const host = new URL(url).host;
    const body = JSON.parse(init.body);
    const probe = requestText(body) === "a";
    requests.push({ url, host, headers: init.headers, body, probe });
    if (failing[host]) return new Response("{}", { status: failing[host] });
    const claude = host === "api.anthropic.com" || url.includes("/publishers/anthropic/");
    const tokens = claude ? { input_tokens: probe ? 3 : 7 } : { totalTokens: probe ? 1 : 9 };
    return new Response(JSON.stringify(tokens), { status: 200, headers: { "content-type": "application/json" } });
  };
  const files = () => requests.filter((request) => !request.probe);
  return { requests, files, fetchImpl };
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
    const { requests, files, fetchImpl } = countServer();
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

    const claude = files().filter(({ host }) => host === "api.anthropic.com");
    assert.equal(claude.length, 2, "CLAUDE.md and AGENTS.md");
    assert.equal(claude[0].headers.authorization, "Bearer ant-session-token");
    assert.equal(claude[0].headers["anthropic-beta"], "oauth-2025-04-20");
    assert.equal(claude[0].headers["x-api-key"], undefined);
    const vertex = files().filter(({ host }) => host === "aiplatform.googleapis.com");
    assert.equal(vertex.length, 1, "GEMINI.md only; the fixture leaves AGENTS.md out of Gemini's context");
    assert.equal(
      vertex[0].url,
      `https://aiplatform.googleapis.com/v1/projects/strata-test-project/locations/global/publishers/google/models/${defaultModels.gemini}:countTokens`,
    );
    assert.equal(vertex[0].headers.authorization, "Bearer gcloud-session-token");
    assert.equal(files().length, 3, "Codex is counted locally");
    assert.equal(requests.filter(({ probe }) => probe).length, 2, "one wrapper probe per remote provider");
    assert.deepEqual(
      report.providerMeasurements.map(({ wrapperTokens }) => wrapperTokens),
      [2, 0, undefined],
    );

    const [revision] = expandRevisions(report);
    const agents = revision.components.find((component) => component.path === "AGENTS.md");
    assert.equal(agents.providerTokenCounts.claude.tokens, 5, "7 counted, less the 2-token wrapper");
    assert.equal(
      agents.providerTokenCounts.codex.tokens,
      getEncoding("o200k_base").encode("Shared instructions.\n").length,
    );
    assert.deepEqual(revision.providerTokenTotals, {
      claude: 10,
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
    assert.match(html, /Claude counts exclude the 2-token message wrapper/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

/** Run a report's script against a minimal DOM and return its elements by id. */
function runReport(html) {
  class Element {
    constructor() {
      this.children = [];
      this.style = {};
      this.listeners = {};
      this.classList = { add() {}, remove() {}, toggle() {} };
    }
    append(...children) {
      this.children.push(...children);
    }
    prepend(...children) {
      this.children.unshift(...children);
    }
    replaceChildren(...children) {
      this.children = children;
    }
    addEventListener(event, listener) {
      this.listeners[event] = listener;
    }
    setAttribute(name, value) {
      this[name] = value;
    }
    getBoundingClientRect() {
      return { top: 0, bottom: 0, right: 0, left: 0, width: 0, height: 0 };
    }
  }
  const elements = new Map();
  const document = {
    createElement: () => new Element(),
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    },
  };
  const [d3Script, script] = [...html.matchAll(/<script>\n?([\s\S]*?)\n? {0,2}<\/script>/g)].map((match) => match[1]);
  const context = { document, Intl, setTimeout: () => 0, clearTimeout() {} };
  runInNewContext(d3Script, context);
  runInNewContext(script, context);
  return (id) => elements.get(id);
}

test("the HTML report describes the counting method in use and charts a provider's own counts", async () => {
  const repo = fixture();
  try {
    const { fetchImpl } = countServer();
    const report = await analyzeRepository(repo, {
      providerPlan: resolvePrecisePlan({ env: noKeys, run: signedIn, fetchImpl }),
    });
    const get = runReport(renderHtml(report));
    // All files: the estimate, with each provider's method summarized.
    assert.equal(get("measure-switch").hidden, true);
    assert.equal(get("tokens-label").textContent, "Estimated tokens");
    assert.match(get("method").textContent, /^Estimated stored-text tokens — utf8-bytes-divided-by-four-v1/);
    assert.match(
      get("method").textContent,
      /Claude: API-counted with claude-opus-5-5 — .*less the 2-token message wrapper measured by counting "a".*counted by api\.anthropic\.com using signed-in Anthropic account \(ant auth login\)/,
    );
    assert.match(get("method").textContent, /Codex: exact \(local encoding\) with gpt-5 .*counted on this machine/);

    // The Claude tab opens on Claude's API counts and says so.
    get("provider-tabs")
      .children.find((tab) => tab.textContent === "Claude + shared")
      .listeners.click();
    assert.equal(get("measure-switch").hidden, false);
    assert.equal(get("tokens").textContent, "10");
    assert.equal(get("tokens-label").textContent, "Claude API-counted tokens");
    assert.equal(get("compare-tokens-label").textContent, "Claude API-counted tokens");
    assert.match(get("repo-meta").textContent, /Claude API-counted tokens under claude-opus-5-5$/);
    assert.match(get("method").textContent, /^Claude: API-counted with claude-opus-5-5/);
    assert.match(
      get("method").textContent,
      /Totals add up the files whose paths Claude is documented to read at each revision/,
    );

    // Switching back to the estimate restores its labels and helper.
    get("measure-switch")
      .children.find((button) => button.textContent === "Byte estimate")
      .listeners.click();
    assert.equal(get("tokens-label").textContent, "Estimated tokens");
    assert.match(get("method").textContent, /^Estimated stored-text tokens/);
    assert.equal(
      get("tokens").textContent,
      String(
        expandRevisions(report)[0]
          .components.filter((c) => c.path !== "GEMINI.md")
          .reduce((sum, c) => sum + c.estimatedTokens, 0),
      ),
    );

    // Codex is counted locally, and its tab says so.
    get("provider-tabs")
      .children.find((tab) => tab.textContent === "Codex + shared")
      .listeners.click();
    assert.equal(get("tokens-label").textContent, "Codex exact tokens");
    assert.match(get("method").textContent, /counted on this machine/);
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
      "no signed-in Anthropic account: run `ant auth login`",
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
      "no signed-in Anthropic account: run `ant auth login`",
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
        const body = { type: "error", error: { type: "authentication_error", message: "invalid token for org-123" } };
        return new Response(JSON.stringify(body), { status: 401 });
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
      "signed-in Anthropic account (ant auth login) failed: claude token count request failed with HTTP 401 (authentication_error: the credential was rejected)",
    ]);
    assert.deepEqual(report.providerMeasurements[1].fallbacks, [
      "signed-in Google Cloud account (gcloud, Vertex AI) failed: gemini token count request failed with HTTP 403",
      "GEMINI_API_KEY and GOOGLE_API_KEY are not set",
      "no local exact Gemini tokenizer exists",
    ]);
    const [revision] = expandRevisions(report);
    for (const component of revision.components) {
      const claude = component.providerTokenCounts?.claude;
      if (claude) assert.equal(claude.tokens, 5, `${component.path} is counted with the key, not a mix`);
    }
    assert.ok(requests.some(({ headers }) => headers["x-api-key"] === "anthropic-test-key"));
    assert.ok(notices.some((line) => /HTTP 401 \(authentication_error: the credential was rejected\); trying the next method/.test(line)));
    // Paths stay out of the recorded reasons, which shareable reports keep.
    assert.ok(!JSON.stringify(report.providerMeasurements).includes(".md"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("--precise looks up credentials only for providers the history has instructions for", async () => {
  for (const [files, expected, commands] of [
    [{ "CLAUDE.md": "Claude only.\n" }, ["claude"], ["ant"]],
    [{ "GEMINI.md": "Gemini only.\n" }, ["gemini"], ["gcloud"]],
    [{ ".codex/config.toml": "model = 'gpt-5'\n", "README.md": "No instructions.\n" }, [], []],
  ]) {
    const repo = fixture(files);
    try {
      const ran = [];
      const run = (command, args) => {
        ran.push(command);
        return signedIn(command, args);
      };
      const { requests, fetchImpl } = countServer();
      const notices = [];
      const report = await analyzeRepository(repo, {
        providerPlan: resolvePrecisePlan({ env: noKeys, run, fetchImpl }),
        onNotice: (line) => notices.push(line),
      });
      const label = Object.keys(files).join(", ");
      assert.deepEqual(
        report.providerMeasurements.map(({ provider }) => provider),
        expected,
        label,
      );
      assert.deepEqual([...new Set(ran)], commands, label);
      assert.equal(notices.length, expected.filter((provider) => provider !== "codex").length, label);
      assert.equal(requests.length, expected.length * 2, `${label}: a wrapper probe and one file each`);
      assert.deepEqual(Object.keys(report.revisions.at(-1).providerTokenTotals), expected, label);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test("rate limits are retried with the server's wait instead of falling back", async () => {
  const repo = fixture({ "CLAUDE.md": "Claude only.\n" });
  try {
    const { files, fetchImpl } = countServer();
    let limited = 0;
    const waits = [];
    const busy = async (url, init) => {
      if (limited < 2) {
        limited += 1;
        return new Response("{}", { status: 429, headers: { "retry-after": "3" } });
      }
      return fetchImpl(url, init);
    };
    const notices = [];
    const report = await analyzeRepository(repo, {
      providerPlan: {
        ...resolvePrecisePlan({ env: noKeys, run: signedIn, fetchImpl: busy }),
        sleep: async (milliseconds) => {
          waits.push(milliseconds);
        },
      },
      onNotice: (line) => notices.push(line),
    });
    assert.deepEqual(waits, [3000, 3000]);
    assert.equal(report.providerMeasurements[0].accuracy, "api-counted");
    assert.equal(report.providerMeasurements[0].fallbacks, undefined);
    assert.equal(files().length, 1);
    assert.equal(notices.filter((line) => /HTTP 429; retrying/.test(line)).length, 1, "one notice per provider");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("counts are cached between runs, so unchanged file versions are not sent again", async () => {
  const repo = fixture();
  const cacheDirectory = mkdtempSync(join(tmpdir(), "strata-cache-"));
  try {
    const cachePath = join(cacheDirectory, "provider-counts.json");
    const run = async () => {
      const server = countServer();
      const cache = fileCountCache(cachePath);
      const notices = [];
      const report = await analyzeRepository(repo, {
        providerPlan: resolvePrecisePlan({ env: noKeys, run: signedIn, fetchImpl: server.fetchImpl, cache }),
        onNotice: (line) => notices.push(line),
      });
      cache.save();
      return { report, requests: server.requests, notices };
    };
    const first = await run();
    assert.equal(first.requests.length, 5);
    const second = await run();
    assert.equal(second.requests.length, 0, "everything, including the wrapper probes, came from the cache");
    assert.deepEqual(second.report.providerMeasurements, first.report.providerMeasurements);
    assert.deepEqual(second.report.components, first.report.components);
    assert.match(
      second.notices[0],
      /Using cached Claude counts for all 2 instruction file versions; no instruction text sent\./,
    );
    const stored = readFileSync(cachePath, "utf8");
    assert.ok(!stored.includes("instructions"), "the cache holds counts, not text");
    assert.ok(!stored.includes("CLAUDE.md"), "the cache holds blob IDs, not paths");
    assert.equal(statSync(cachePath).mode & 0o777, 0o600);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(cacheDirectory, { recursive: true, force: true });
  }
});

test("--precise --dry-run says what would be used and sent, and sends nothing", async () => {
  const repo = fixture();
  try {
    const { requests, fetchImpl } = countServer();
    const notices = [];
    await analyzeRepository(repo, {
      providerPlan: resolvePrecisePlan({
        env: { ...noKeys, ANTHROPIC_API_KEY: "anthropic-test-key" },
        run: cliStub({}),
        fetchImpl,
        dryRun: true,
      }),
      onNotice: (line) => notices.push(line),
    });
    assert.equal(requests.length, 0);
    assert.deepEqual(notices, [
      `Claude: would send 2 instruction file versions to api.anthropic.com to count with ${defaultModels.claude}, using ANTHROPIC_API_KEY.`,
      "  Skipped: no signed-in Anthropic account: run `ant auth login`.",
      "Gemini: would use the byte estimate for 1 instruction file version; nothing sent.",
      "  Skipped: no Google Cloud project: set GOOGLE_CLOUD_PROJECT or `gcloud config set project`.",
      "  Skipped: GEMINI_API_KEY and GOOGLE_API_KEY are not set.",
      "  Skipped: no local exact Gemini tokenizer exists.",
      `Codex: would count 1 instruction file version locally with ${defaultModels.codex} (o200k_base); nothing sent.`,
    ]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("without an Anthropic account or key, Claude is counted through a signed-in gcloud on Vertex AI", async () => {
  const repo = fixture({ "CLAUDE.md": "Claude only.\n" });
  try {
    const { files, fetchImpl } = countServer();
    const report = await analyzeRepository(repo, {
      providerPlan: resolvePrecisePlan({
        env: noKeys,
        run: cliStub({
          "gcloud config get-value project": "strata-test-project",
          "gcloud auth print-access-token": "gcloud-session-token",
        }),
        fetchImpl,
      }),
    });
    assert.deepEqual(summary(report), {
      claude: ["api-counted", "signed-in Google Cloud account (gcloud, Vertex AI)", "aiplatform.googleapis.com"],
    });
    const [request] = files();
    assert.equal(
      request.url,
      "https://aiplatform.googleapis.com/v1/projects/strata-test-project/locations/global/publishers/anthropic/models/count-tokens:rawPredict",
    );
    assert.equal(request.headers.authorization, "Bearer gcloud-session-token");
    assert.equal(request.body.model, defaultModels.claude);
    assert.equal(expandRevisions(report)[0].providerTokenTotals.claude, 5);

    // A gcloud that is installed but not ready is not mentioned to someone who only uses Claude.
    const unready = resolvePrecisePlan({ env: noKeys, run: cliStub({}) }).methods.claude();
    assert.ok(unready.every((method) => !/Google Cloud|gcloud/.test(method.reason ?? "")));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("strata diff --precise adds each provider's totals at both commits", async () => {
  const repo = fixture({ "CLAUDE.md": "Claude only.\n" });
  try {
    const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(repo, "AGENTS.md"), "Shared instructions.\n");
    git("add", "-A");
    git("commit", "-q", "-m", "Add AGENTS.md");
    const head = git("rev-parse", "HEAD");
    const { fetchImpl } = countServer();
    const delta = await compareGitCommitsPrecise(repo, base, head, {
      providerPlan: resolvePrecisePlan({ env: noKeys, run: signedIn, fetchImpl }),
    });
    assert.equal(delta.schemaVersion, 5);
    const codexTokens = getEncoding("o200k_base").encode("Shared instructions.\n").length;
    assert.deepEqual(
      delta.providerTotals.map(({ provider, beforeTokens, afterTokens, deltaTokens }) => [
        provider,
        beforeTokens,
        afterTokens,
        deltaTokens,
      ]),
      [
        ["claude", 5, 10, 5],
        ["codex", 0, codexTokens, codexTokens],
      ],
    );
    const markdown = renderPullRequestDelta(delta);
    assert.match(
      markdown,
      /\| Claude \| api-counted, claude-opus-5-5 via api\.anthropic\.com, less a 2-token message wrapper per file \| 5 \| 10 \| \+5 \|/,
    );
    assert.match(markdown, /Instruction text was sent for counting to api\.anthropic\.com\./);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a method that fails after sending some files still discloses where they went", async () => {
  const repo = fixture({ "CLAUDE.md": "Claude instructions.\n", "AGENTS.md": "Shared instructions.\n" });
  try {
    const { fetchImpl } = countServer();
    const rejectShared = async (url, init) =>
      requestText(JSON.parse(init.body)).startsWith("Shared")
        ? new Response("{}", { status: 400 })
        : fetchImpl(url, init);
    const report = await analyzeRepository(repo, {
      providerPlan: resolvePrecisePlan({
        env: { ...noKeys, ANTHROPIC_API_KEY: "anthropic-test-key" },
        run: cliStub({}),
        fetchImpl: rejectShared,
      }),
    });
    const [claude] = report.providerMeasurements;
    assert.equal(claude.accuracy, "estimate");
    assert.deepEqual(claude.alsoSentTo, ["api.anthropic.com"]);
    assert.match(renderHtml(report), /Claude text was sent to api\.anthropic\.com/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("blank instruction files count as zero without a request", async () => {
  const repo = fixture({ "CLAUDE.md": "", "AGENTS.md": "  \n\t\n" });
  try {
    const { files, fetchImpl } = countServer();
    const report = await analyzeRepository(repo, {
      providerPlan: resolvePrecisePlan({ env: noKeys, run: signedIn, fetchImpl }),
    });
    assert.equal(files().length, 0);
    assert.equal(report.providerMeasurements[0].accuracy, "api-counted");
    assert.equal(expandRevisions(report)[0].providerTokenTotals.claude, 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("Claude text goes to Google Cloud only without an Anthropic account or key", () => {
  const ran = [];
  const run = (command, args) => {
    ran.push(`${command} ${args.join(" ")}`);
    return cliStub({
      "gcloud config get-value project": "strata-test-project",
      "gcloud auth print-access-token": "gcloud-session-token",
    })(command, args);
  };
  const withKey = resolvePrecisePlan({
    env: { ...noKeys, ANTHROPIC_API_KEY: "anthropic-test-key" },
    run,
  }).methods.claude();
  assert.ok(!withKey.some((method) => method.kind === "vertex-claude"));
  assert.ok(!ran.some((command) => command.startsWith("gcloud")), "gcloud is not even run");
  const withoutKey = resolvePrecisePlan({ env: noKeys, run }).methods.claude();
  assert.equal(withoutKey.find((method) => method.kind !== "unavailable").kind, "vertex-claude");
});

test("credential problems are named precisely", () => {
  const apache = resolvePrecisePlan({
    env: noKeys,
    run: (command, args) =>
      command === "ant" && args[0] === "-version"
        ? { output: "Apache Ant(TM) version 1.10.14 compiled on August 16 2023" }
        : { output: null },
  }).methods.claude();
  assert.match(apache[0].reason, /Apache Ant, not the Anthropic CLI/);
  const signedOut = resolvePrecisePlan({
    env: noKeys,
    run: (command, args) =>
      command === "ant" && args[0] === "--version" ? { output: "ant version 1.41.0" } : { output: null },
  }).methods.claude();
  assert.equal(signedOut[0].reason, "no signed-in Anthropic account: run `ant auth login`");
  const badKey = resolvePrecisePlan({ env: { ...noKeys, ANTHROPIC_API_KEY: "sk-ant\nsplit" }, run: cliStub({}) });
  assert.ok(
    badKey.methods
      .claude()
      .some((method) => method.reason === "ANTHROPIC_API_KEY contains characters an HTTP header cannot carry"),
  );
});

test("the count cache merges with counts another run saved meanwhile", () => {
  const directory = mkdtempSync(join(tmpdir(), "strata-cache-"));
  try {
    const path = join(directory, "provider-counts.json");
    const first = fileCountCache(path);
    const second = fileCountCache(path);
    first.set("anthropic\0m\0a", 1);
    second.set("anthropic\0m\0b", 2);
    first.save();
    second.save();
    const reopened = fileCountCache(path);
    assert.equal(reopened.get("anthropic\0m\0a"), 1);
    assert.equal(reopened.get("anthropic\0m\0b"), 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("--precise explains how to install a provider CLI that is missing", () => {
  const plan = resolvePrecisePlan({ env: noKeys, run: () => "missing" });
  assert.deepEqual(plan.methods.claude()[0], { kind: "unavailable", reason: installHints.ant });
  assert.deepEqual(plan.methods.gemini()[0], { kind: "unavailable", reason: installHints.gcloud });
  assert.match(installHints.ant, /not installed.*brew install anthropics\/tap\/ant.*ant auth login/);
  assert.match(installHints.gcloud, /not installed.*gcloud auth login/);

  // The real runner, on a PATH that has Git but neither provider CLI.
  const repo = fixture();
  const bin = mkdtempSync(join(tmpdir(), "strata-bin-"));
  try {
    const gitPath = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();
    symlinkSync(join(gitPath, "git"), join(bin, "git"));
    const result = spawnSync(process.execPath, [cliPath, "analyze", repo, "--precise", "--format", "json", "-o", "-"], {
      encoding: "utf8",
      env: { ...process.env, ...noKeys, PATH: bin },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stderr,
      /Skipped: the Anthropic CLI \(`ant`\) is not installed; .*brew install anthropics\/tap\/ant/,
    );
    assert.match(result.stderr, /Skipped: the Google Cloud CLI \(`gcloud`\) is not installed/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
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
    assert.match(result.stdout, /Skipped: no signed-in Anthropic account: run `ant auth login`\./);
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
      [
        ["--provider-api", "--claude-model", "c", "--gemini-model", "g", "--dry-run"],
        /require --precise, not --provider-api/,
      ],
      [["--precise", "--claude-model", ""], /--claude-model needs a model name/],
      [["--dry-run"], /require --precise/],
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

test("a failed count names the provider's error reason, never its message", async () => {
  const body = {
    error: {
      code: 403,
      message: "Enable billing on project #secret-project-42",
      status: "PERMISSION_DENIED",
      details: [{ reason: "BILLING_DISABLED", metadata: { consumer: "projects/secret-project-42" } }],
    },
  };
  const method = { kind: "vertex", model: "gemini-test", secret: "token", project: "p", location: "global" };
  const failure = await countRemoteText("gemini", method, "text", {
    fetchImpl: async () => new Response(JSON.stringify(body), { status: 403 }),
  }).catch((error) => error.message);
  assert.equal(
    failure,
    "gemini token count request failed with HTTP 403 (BILLING_DISABLED: enable billing on the Google Cloud project; Vertex AI requires it even for token counts)",
  );
  const unexplained = await countRemoteText("gemini", method, "text", {
    fetchImpl: async () => new Response("<html>Forbidden</html>", { status: 403 }),
  }).catch((error) => error.message);
  assert.equal(unexplained, "gemini token count request failed with HTTP 403");
});
