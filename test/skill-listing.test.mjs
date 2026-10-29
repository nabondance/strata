import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { getEncoding } from "js-tiktoken";
import { analyzeRepository } from "../dist/analyze.js";
import { compareRevisions } from "../dist/compare.js";
import { expandRevisions } from "../dist/expand.js";
import { compareGitCommits, renderPullRequestDelta } from "../dist/pr-delta.js";
import { redactReport } from "../dist/privacy.js";
import { viewRevision } from "../dist/provider-view.js";
import { renderHtml } from "../dist/report.js";
import { listingText, readFrontmatter } from "../dist/skill-listing.js";

test("reads the listed name and description from the frontmatter subset", () => {
  const claude = (text, directory = "skill") => listingText(text, "claude", directory);
  const codex = (text) => listingText(text, "shared", "skill");

  assert.equal(claude("---\nname: review\ndescription: Review a diff\n---\nBody.\n"), "review\nReview a diff");
  // Claude Code defaults the name to the directory and the description to the first body line.
  assert.equal(claude("\n# Review\n\nReview carefully.\n", "code-review"), "code-review\n# Review");
  assert.equal(claude("---\ndescription: Only a description\n---\n", "lint"), "lint\nOnly a description");
  assert.equal(claude("---\nname: empty\n---\n\n"), "empty");
  assert.equal(
    claude("---\ndescription: Deploy\nwhen_to_use: When asked to ship\n---\n"),
    "skill\nDeploy\nWhen asked to ship",
  );
  assert.equal(claude(`---\ndescription: ${"a".repeat(1600)}\n---\n`), `skill\n${"a".repeat(1536)}`);
  assert.equal(claude("---\ndescription: Deploy\ndisable-model-invocation: true\n---\n"), "");
  assert.equal(claude("---\ndescription: Deploy\ndisable-model-invocation: false\n---\n"), "skill\nDeploy");

  // Plain, quoted, and block scalars, with comments and other fields around them.
  assert.equal(
    claude(
      "---\r\nname: 'it''s'   # quoted\r\nallowed-tools: [Read, Grep]\r\nmetadata:\r\n  owner: docs\r\ndescription: >-\r\n  Folded text\r\n  over lines.\r\n\r\n  Second paragraph.\r\n---\r\n",
    ),
    "it's\nFolded text over lines.\nSecond paragraph.",
  );
  assert.equal(claude('---\ndescription: "Tab\\tand \\u00e9"\n---\n'), "skill\nTab\tand é");
  assert.equal(claude("---\ndescription: |\n  Line one\n  Line two\n---\n"), "skill\nLine one\nLine two");
  assert.equal(claude("---\ndescription:\n  Plain over\n  two lines\n---\n"), "skill\nPlain over two lines");
  assert.equal(claude("---\nhooks:\n- matcher: Bash\ndescription: After a list\n---\n"), "skill\nAfter a list");

  // Values Strata does not read are unresolved rather than guessed.
  assert.equal(claude("---\ndescription: Triggers: lint, test\n---\n"), null);
  assert.equal(claude("---\ndescription: [a, b]\n---\n"), null);
  assert.equal(claude('---\ndescription: "spans\n  two lines"\n---\n'), null);
  assert.equal(claude("---\nname: a\nname: b\n---\n"), null);
  assert.equal(claude("---\ndescription: never closed\n"), null);
  assert.equal(readFrontmatter("---\n  indented: key\n---\n"), null);
  // An escape past the last code point, or value text after a comment line, is not readable YAML.
  assert.equal(claude('---\ndescription: "\\UFFFFFFFF"\n---\n'), null);
  assert.equal(claude('---\ndescription: "\\U0001F600"\n---\n'), "skill\n😀");
  assert.equal(claude("---\ndescription: first\n  # note\n  second\n---\n"), null);
  assert.equal(claude("---\ndescription: first\n  # trailing note\nname: n\n---\n"), "n\nfirst");

  // Codex and Gemini CLI require both fields and ignore Claude-only ones.
  assert.equal(codex("---\nname: release\ndescription: Ship it\nwhen_to_use: Always\n---\n"), "release\nShip it");
  assert.equal(codex("---\nname: release\n---\nShip it.\n"), null);
  assert.equal(codex("Ship it.\n"), null);
  assert.equal(codex("---\nname: r\ndescription: d\ndisable-model-invocation: true\n---\n"), "r\nd");
});

test("measures each manifest's listing separately from its stored tokens", async () => {
  const repo = mkdtempSync(join(tmpdir(), "strata-listing-"));
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  const put = (path, content) => {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), content);
  };
  const commit = (message) => {
    git("add", "-A");
    git("commit", "-m", message);
    return git("rev-parse", "HEAD");
  };
  const estimate = (text) => Math.ceil(Buffer.byteLength(text) / 4);
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Strata Test");
    git("config", "user.email", "strata-test@example.invalid");
    const body = "Long instructions that only load when the skill runs.\n".repeat(20);
    put(".claude/skills/review/SKILL.md", `Review this project carefully.\n${body}`);
    put(".claude/skills/deploy/SKILL.md", `---\ndescription: Deploy\ndisable-model-invocation: true\n---\n${body}`);
    put(".claude/skills/broken/SKILL.md", `---\ndescription: [one, two]\n---\n${body}`);
    put(".claude/skills/review/references/guide.md", "Reference.\n");
    put(".agents/skills/release/SKILL.md", `---\nname: release\ndescription: |\n  Prepare a release.\n---\n${body}`);
    put(".agents/skills/nameless/SKILL.md", `---\ndescription: No name\n---\n${body}`);
    put(".gemini/skills/latin/SKILL.md", Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0x0a]));
    put("CLAUDE.md", "Project instructions.\n");
    const added = commit("Add skills");
    git("mv", ".claude/skills/review", ".claude/skills/code-review");
    const renamed = commit("Rename a skill");

    const report = await analyzeRepository(repo);
    assert.equal(report.schemaVersion, 19);
    const listing = (path) => report.components.find((component) => component.path === path)?.skill?.listing;
    const reviewListing = { status: "listed", tokens: estimate("review\nReview this project carefully.") };
    assert.deepEqual(listing(".claude/skills/review/SKILL.md"), reviewListing);
    // The listed name defaults to the directory, so a rename changes the listing but not the file.
    assert.deepEqual(listing(".claude/skills/code-review/SKILL.md"), {
      status: "listed",
      tokens: estimate("code-review\nReview this project carefully."),
    });
    assert.deepEqual(listing(".claude/skills/deploy/SKILL.md"), { status: "hidden", tokens: 0 });
    assert.deepEqual(listing(".claude/skills/broken/SKILL.md"), { status: "unresolved", tokens: null });
    assert.deepEqual(listing(".agents/skills/release/SKILL.md"), {
      status: "listed",
      tokens: estimate("release\nPrepare a release."),
    });
    assert.deepEqual(listing(".agents/skills/nameless/SKILL.md"), { status: "unresolved", tokens: null });
    assert.deepEqual(listing(".gemini/skills/latin/SKILL.md"), { status: "unresolved", tokens: null });
    assert.equal(listing(".claude/skills/review/references/guide.md"), undefined);
    assert.equal(report.components.find((component) => component.path === "CLAUDE.md").skill, undefined);

    const revisions = expandRevisions(report);
    const latest = revisions.at(-1);
    const listed = latest.components.reduce((sum, component) => sum + (component.skill?.listing?.tokens ?? 0), 0);
    assert.equal(latest.skillListingTokens, listed);
    // The broken, nameless, and non-UTF-8 manifests are unresolved and counted apart.
    assert.equal(latest.skillListingUnresolved, 3);
    assert.equal(revisions[0].skillListingTokens, listed - 1);
    // The listing is never added to the category total.
    assert.equal(
      latest.categoryTotals.skills.estimatedTokens,
      latest.components
        .filter((component) => component.category === "skills")
        .reduce((sum, component) => sum + (component.estimatedTokens ?? 0), 0),
    );
    assert.ok(latest.skillListingTokens * 10 < latest.categoryTotals.skills.estimatedTokens);
    const group = latest.skillGroups.find((entry) => entry.root === ".claude/skills/code-review");
    assert.deepEqual(group.listing, listing(".claude/skills/code-review/SKILL.md"));
    assert.equal(group.resourceCount, 1);

    const claudeView = viewRevision(latest, "claude", revisions.at(-2), report.components);
    assert.equal(claudeView.skillListingTokens, listing(".claude/skills/code-review/SKILL.md").tokens);
    assert.equal(claudeView.skillListingUnresolved, 1);
    const codexView = viewRevision(latest, "codex", revisions.at(-2), report.components);
    assert.equal(codexView.skillListingTokens, listing(".agents/skills/release/SKILL.md").tokens);
    assert.equal(codexView.skillListingUnresolved, 1);

    const shareable = redactReport(report);
    assert.deepEqual(
      shareable.components.flatMap((component) => (component.skill?.listing ? [component.skill.listing] : [])),
      report.components.flatMap((component) => (component.skill?.listing ? [component.skill.listing] : [])),
    );
    assert.doesNotMatch(JSON.stringify(report), /Review this project|Prepare a release/);

    const html = renderHtml(report);
    assert.match(html, />Summary<\/th>/);
    assert.doesNotMatch(html, /Review this project|Prepare a release/);

    // The HTML comparison and `strata diff` share one comparison, listings included.
    const compared = compareRevisions(revisions[0], latest);
    assert.deepEqual(compared.skillListing, {
      beforeTokens: revisions[0].skillListingTokens,
      afterTokens: latest.skillListingTokens,
      deltaTokens: 1,
      beforeManifests: 6,
      afterManifests: 6,
      beforeUnresolved: 3,
      afterUnresolved: 3,
    });
    assert.deepEqual(
      compared.components.map(({ path, listing }) => [path, listing]),
      [
        [
          ".claude/skills/code-review/SKILL.md",
          { before: null, after: listing(".claude/skills/code-review/SKILL.md"), deltaTokens: 11 },
        ],
        [".claude/skills/review/SKILL.md", { before: reviewListing, after: null, deltaTokens: -10 }],
        [".claude/skills/code-review/references/guide.md", undefined],
        [".claude/skills/review/references/guide.md", undefined],
      ],
    );

    put(
      ".agents/skills/release/SKILL.md",
      `---\nname: release\ndescription: |\n  Prepare and tag a release.\n---\n${body}`,
    );
    put(".claude/skills/broken/SKILL.md", `---\ndescription: Fixed\n---\n${body}`);
    const edited = commit("Edit two descriptions");
    const delta = compareGitCommits(repo, renamed, edited);
    assert.equal(delta.schemaVersion, 12);
    assert.deepEqual(delta.comparison.skillListing, {
      beforeTokens: latest.skillListingTokens,
      afterTokens:
        latest.skillListingTokens -
        estimate("release\nPrepare a release.") +
        estimate("release\nPrepare and tag a release.") +
        estimate("broken\nFixed"),
      deltaTokens: delta.comparison.skillListing.afterTokens - latest.skillListingTokens,
      beforeManifests: 6,
      afterManifests: 6,
      beforeUnresolved: 3,
      afterUnresolved: 2,
    });
    const markdown = renderPullRequestDelta(delta);
    assert.match(
      markdown,
      /Skill listings, the names and descriptions an agent keeps in context before a skill is used: \*\*\+\d+\*\* tokens \(\d+ → \d+\), measured separately from the stored text above; do not add them\. Manifests with unreadable frontmatter, not counted: 3 → 2\./,
    );
    assert.match(markdown, /\| File \| Change \| Δ tokens \| Δ listed \|/);
    assert.match(markdown, /\| \.agents\/skills\/release\/SKILL\.md \| edited \| \+\d+ \| \+2 \|/);
    assert.match(markdown, /\| \.claude\/skills\/broken\/SKILL\.md \| edited \| -?\d+ \| unresolved → 3 \|/);
    // Without a changed manifest the file table has no listing column, but the listing total stays.
    const unchanged = renderPullRequestDelta(compareGitCommits(repo, added, added));
    assert.doesNotMatch(unchanged, /Δ listed/);
    assert.match(unchanged, /Skill listings, .*\*\*0\*\* tokens/);

    // The command line names the listed total beside the stored one and counts unreadable manifests apart.
    const cli = spawnSync(
      process.execPath,
      [resolve("dist/cli.js"), "analyze", repo, "--format", "json", "--output", "-"],
      {
        encoding: "utf8",
      },
    );
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(
      cli.stderr,
      /Skills: \d+ listed tokens, the names and descriptions kept in context before a skill is used; the skill files store \d+\. 2 manifests have frontmatter Strata could not read and are not counted\./,
    );

    // An OpenAI encoding rejects text that is not UTF-8, so its check uses a history without that manifest.
    git("checkout", "-q", "--orphan", "utf8");
    git("rm", "-rq", "--cached", ".gemini");
    rmSync(join(repo, ".gemini"), { recursive: true });
    commit("Only UTF-8 manifests");
    const exact = await analyzeRepository(repo, { mode: "openai-o200k_base" });
    assert.equal(
      exact.components.find((component) => component.path === ".agents/skills/release/SKILL.md").skill.listing.tokens,
      getEncoding("o200k_base").encode("release\nPrepare and tag a release.").length,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
