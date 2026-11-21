import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

// The Action's image-branch option, run against a local bare repository that
// stands in for GitHub.

const script = resolve("scripts/action-image.sh");
const action = readFileSync("action.yml", "utf8");

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function setup(t) {
  const temp = mkdtempSync(join(tmpdir(), "strata-action-image-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const remote = join(temp, "remote.git");
  const repo = join(temp, "repo");
  git(temp, "init", "-q", "--bare", "-b", "main", remote);
  git(temp, "init", "-q", "-b", "main", repo);
  git(repo, "config", "user.name", "Strata test");
  git(repo, "config", "user.email", "strata-test@example.invalid");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "remote", "add", "origin", remote);
  const commit = (text) => {
    writeFileSync(join(repo, "CLAUDE.md"), text);
    git(repo, "add", "CLAUDE.md");
    git(repo, "commit", "-q", "-m", "Change instructions");
    return git(repo, "rev-parse", "HEAD");
  };
  const first = commit("Run the tests before you commit.\n");
  git(repo, "push", "-q", "origin", "main");

  const run = (command, extra = {}) => {
    const id = Math.random().toString(36).slice(2);
    const output = join(temp, `output-${id}`);
    const summary = join(temp, `summary-${id}`);
    writeFileSync(output, "");
    writeFileSync(summary, "");
    const result = spawnSync("bash", ["--noprofile", "--norc", script, command], {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_WORKSPACE: repo,
        GITHUB_SHA: git(repo, "rev-parse", "HEAD"),
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
        GITHUB_SERVER_URL: "https://github.example",
        GITHUB_REPOSITORY: "owner/repo",
        RUNNER_TEMP: temp,
        STRATA_DIST: resolve("dist"),
        STRATA_IGNORE: "",
        STRATA_IMAGE_BRANCH: "strata-image",
        STRATA_DEFAULT_BRANCH: "main",
        STRATA_IMAGE_REMOTE: remote,
        STRATA_TOKEN: "",
        ...extra,
      },
    });
    const outputs = Object.fromEntries(
      readFileSync(output, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    return { ...result, outputs, summary: readFileSync(summary, "utf8") };
  };
  const publish = (extra = {}) => {
    const rendered = run("render", extra);
    assert.equal(rendered.status, 0, rendered.stdout + rendered.stderr);
    return run("publish", { STRATA_IMAGE_DIR: rendered.outputs["image-dir"], ...extra });
  };
  const tip = (branch = "strata-image") => {
    const line = git(temp, "ls-remote", "--heads", remote, `refs/heads/${branch}`);
    return line.split("\t")[0];
  };
  return { temp, remote, repo, commit, first, run, publish, tip };
}

test("publishes the image and badge as the branch's single commit", (t) => {
  const { remote, first, publish, tip } = setup(t);
  const result = publish();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.outputs["image-url"], "https://github.example/owner/repo/raw/strata-image/strata.svg");
  assert.equal(git(remote, "rev-list", "--count", "strata-image"), "1");
  assert.equal(git(remote, "ls-tree", "-r", "--name-only", "strata-image"), "strata-badge.json\nstrata.svg");
  assert.match(git(remote, "show", "strata-image:strata.svg"), /^<svg/);
  assert.equal(git(remote, "log", "-1", "--format=%s", "strata-image"), `Update Strata image for ${first}`);
  assert.ok(tip());
  // The default branch and the checkout are untouched.
  assert.equal(git(remote, "rev-parse", "main"), first);
});

test("replaces the image on a later commit and keeps one commit", (t) => {
  const { remote, repo, commit, publish, tip } = setup(t);
  assert.equal(publish().status, 0);
  const before = tip();
  const later = commit(`${"More instructions. ".repeat(40)}\n`);
  git(repo, "push", "-q", "origin", "main");
  const result = publish();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.notEqual(tip(), before);
  assert.equal(git(remote, "rev-list", "--count", "strata-image"), "1");
  assert.equal(git(remote, "log", "-1", "--format=%s", "strata-image"), `Update Strata image for ${later}`);
});

test("pushes nothing when the image is unchanged", (t) => {
  const { publish, tip } = setup(t);
  assert.equal(publish().status, 0);
  const before = tip();
  const again = publish();
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /unchanged/);
  assert.equal(again.outputs["image-url"], "https://github.example/owner/repo/raw/strata-image/strata.svg");
  assert.equal(tip(), before);
});

test("an older commit's run does not replace a newer image", (t) => {
  const { repo, commit, first, run, publish, tip } = setup(t);
  const oldDir = run("render").outputs["image-dir"];
  const newer = commit(`${"Newer instructions. ".repeat(40)}\n`);
  git(repo, "push", "-q", "origin", "main");
  assert.equal(publish().status, 0);
  const before = tip();
  git(repo, "checkout", "-q", first);
  const late = run("publish", { GITHUB_SHA: first, STRATA_IMAGE_DIR: oldDir });
  assert.equal(late.status, 0, late.stdout + late.stderr);
  assert.match(late.stdout, new RegExp(`newer commit \\(${newer}\\)`));
  assert.equal(tip(), before);
});

test("the job summary links the image and says what happened to it", (t) => {
  const { repo, commit, first, run, publish } = setup(t);
  const url = "https://github.example/owner/repo/raw/strata-image/strata.svg";
  const snippet = `![Agent context through time](${url})`;

  // Before the first publish, a pull request says what the next push does.
  const before = run("link");
  assert.equal(before.status, 0, before.stdout + before.stderr);
  assert.match(before.summary, /### README image/);
  assert.match(before.summary, /The next push to `main` publishes the image to `strata-image`\./);
  assert.ok(before.summary.includes(snippet));
  assert.doesNotMatch(before.summary, /\[strata\.svg\]/);

  const published = publish();
  assert.ok(published.summary.includes(`Published to \`strata-image\`: [strata.svg](${url}).`));
  assert.ok(published.summary.includes(snippet));
  const unchanged = publish();
  assert.ok(unchanged.summary.includes(`Unchanged on \`strata-image\`: [strata.svg](${url}).`));

  // Once it exists, a pull request links it.
  git(repo, "fetch", "-q", "origin", "+refs/heads/strata-image:refs/remotes/origin/strata-image");
  const current = run("link");
  assert.ok(
    current.summary.includes(
      `Current image on \`strata-image\`: [strata.svg](${url}). The next push to \`main\` updates it.`,
    ),
  );

  // An older commit's late run names the newer image.
  const rendered = run("render");
  commit(`${"Newer instructions. ".repeat(40)}\n`);
  git(repo, "push", "-q", "origin", "main");
  assert.equal(publish().status, 0);
  git(repo, "checkout", "-q", first);
  const late = run("publish", { STRATA_IMAGE_DIR: rendered.outputs["image-dir"] });
  assert.ok(late.summary.includes(`\`strata-image\` already shows a newer commit: [strata.svg](${url}).`));
});

test("a slow run whose checkout lacks the newer commit does not replace its image", (t) => {
  const { temp, remote, repo, commit, first, run, publish, tip } = setup(t);
  const slow = join(temp, "slow");
  git(temp, "clone", "-q", remote, slow);
  const rendered = run("render", { GITHUB_WORKSPACE: slow, GITHUB_SHA: first });
  assert.equal(rendered.status, 0, rendered.stdout + rendered.stderr);
  const newer = commit(`${"Newer instructions. ".repeat(40)}\n`);
  git(repo, "push", "-q", "origin", "main");
  assert.equal(publish().status, 0);
  const before = tip();
  const late = run("publish", {
    GITHUB_WORKSPACE: slow,
    GITHUB_SHA: first,
    STRATA_IMAGE_DIR: rendered.outputs["image-dir"],
  });
  assert.equal(late.status, 0, late.stdout + late.stderr);
  assert.match(late.stdout, new RegExp(`newer commit \\(${newer}\\)`));
  assert.equal(tip(), before);
});

test("after a rollback, the image follows the default branch", (t) => {
  const { remote, repo, commit, first, run, publish, tip } = setup(t);
  const removed = commit(`${"Instructions rolled back later. ".repeat(40)}\n`);
  git(repo, "push", "-q", "origin", "main");
  assert.equal(publish().status, 0);
  git(repo, "push", "-q", "--force", "origin", `${first}:refs/heads/main`);
  git(repo, "reset", "-q", "--hard", first);
  const rolledBack = publish();
  assert.equal(rolledBack.status, 0, rolledBack.stdout + rolledBack.stderr);
  assert.equal(git(remote, "log", "-1", "--format=%s", "strata-image"), `Update Strata image for ${first}`);

  // A late run for the removed commit publishes nothing.
  const before = tip();
  git(repo, "checkout", "-q", removed);
  const rendered = run("render");
  const late = run("publish", { STRATA_IMAGE_DIR: rendered.outputs["image-dir"] });
  assert.equal(late.status, 0, late.stdout + late.stderr);
  assert.match(late.stdout, /is no longer on main/);
  assert.match(late.summary, /Not published, because this commit is no longer on `main`\./);
  assert.doesNotMatch(late.summary, /strata\.svg/);
  assert.equal(tip(), before);
});

test("pushes nothing when the default branch cannot be read", (t) => {
  const { run, tip } = setup(t);
  const rendered = run("render");
  const result = run("publish", { STRATA_IMAGE_DIR: rendered.outputs["image-dir"], STRATA_DEFAULT_BRANCH: "missing" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Could not read the default branch/);
  assert.equal(tip(), "");
});

test("check refuses a checkout that kept its credentials, without printing them", (t) => {
  const { temp, repo, run } = setup(t);
  const key = "http.https://github.com/.extraheader";
  const refused = () => {
    const result = run("check");
    assert.equal(result.status, 1);
    assert.match(result.stdout, /persist-credentials: false/);
    assert.doesNotMatch(result.stdout + result.stderr, /c2VjcmV0/);
  };
  git(repo, "config", key, "AUTHORIZATION: basic c2VjcmV0");
  refused();
  git(repo, "config", "--unset", key);
  assert.equal(run("check").status, 0);

  // A header for every host has no URL in its key.
  git(repo, "config", "http.extraheader", "AUTHORIZATION: basic c2VjcmV0");
  refused();
  git(repo, "config", "--unset", "http.extraheader");
  assert.equal(run("check").status, 0);

  // How actions/checkout keeps them: in a file outside the repository.
  const file = join(temp, "credentials.config");
  writeFileSync(file, '[http "https://github.com/"]\n\textraheader = AUTHORIZATION: basic c2VjcmV0\n');
  git(repo, "config", `includeIf.gitdir:${join(realpathSync(repo), ".git")}.path`, file);
  refused();
});

test("leaves a branch alone that is not Strata's image branch", (t) => {
  const { repo, commit, run, publish, tip } = setup(t);
  // More than one commit.
  commit("A second commit.\n");
  git(repo, "push", "-q", "origin", "main", "main:refs/heads/strata-image");
  const history = tip();
  const refused = publish();
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /more than one commit/);
  assert.equal(tip(), history);

  // One commit, holding someone's file.
  git(repo, "checkout", "-q", "--orphan", "notes");
  writeFileSync(join(repo, "notes.md"), "Mine.\n");
  git(repo, "rm", "-q", "--cached", "CLAUDE.md");
  git(repo, "add", "notes.md");
  git(repo, "commit", "-q", "-m", "Notes");
  git(repo, "push", "-q", "origin", "notes:refs/heads/notes");
  git(repo, "checkout", "-q", "-f", "main");
  const notes = tip("notes");
  const dir = run("render").outputs["image-dir"];
  const other = run("publish", { STRATA_IMAGE_BRANCH: "notes", STRATA_IMAGE_DIR: dir });
  assert.equal(other.status, 1);
  assert.match(other.stdout, /holds other files, such as notes\.md/);
  assert.equal(tip("notes"), notes);
});

test("a longer branch name ending in the image branch's is not mistaken for it", (t) => {
  const { repo, publish, tip } = setup(t);
  const lookalike = "mirror/refs/heads/strata-image";
  git(repo, "push", "-q", "origin", `main:refs/heads/${lookalike}`);
  const before = git(repo, "rev-parse", "main");
  const result = publish();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Published the image/);
  assert.ok(tip());
  assert.equal(git(repo, "ls-remote", "origin", `refs/heads/${lookalike}`).split("\t")[0], before);
});

test("publishing does not fetch the repository's submodules", (t) => {
  const { temp, repo, publish, tip } = setup(t);
  const library = join(temp, "library");
  git(temp, "init", "-q", "-b", "main", library);
  git(
    library,
    "-c",
    "user.name=Strata test",
    "-c",
    "user.email=strata-test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "Library",
  );
  git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", library, "library");
  git(repo, "commit", "-q", "-m", "Add a submodule");
  git(repo, "push", "-q", "origin", "main");
  // A submodule the job cannot reach, as a private one is without credentials.
  git(repo, "config", "fetch.recurseSubmodules", "true");
  rmSync(library, { recursive: true, force: true });
  const result = publish();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(tip());
});

test("names the fix when the push is refused", (t) => {
  const { temp, remote, run } = setup(t);
  const hook = join(remote, "hooks", "pre-receive");
  writeFileSync(hook, "#!/bin/sh\necho denied >&2\nexit 1\n", { mode: 0o755 });
  const dir = run("render").outputs["image-dir"];
  const result = run("publish", { STRATA_IMAGE_DIR: dir, RUNNER_TEMP: temp });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /permissions: contents: write/);
});

test("refuses a shallow checkout and a checkout of another commit", (t) => {
  const { temp, remote, repo, commit, run } = setup(t);
  commit("A second commit.\n");
  git(repo, "push", "-q", "origin", "main");
  const shallow = join(temp, "shallow");
  git(temp, "clone", "-q", "--depth=1", `file://${remote}`, shallow);
  // Checked before Strata runs, so a pull request shows it.
  const refused = run("check", { GITHUB_WORKSPACE: shallow });
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /fetch-depth: 0/);

  const other = run("render", { GITHUB_SHA: "0".repeat(40) });
  assert.equal(other.status, 1);
  assert.match(other.stdout, /must show the pushed commit/);
});

test("the image honors the ignore input", (t) => {
  const { temp, repo, run } = setup(t);
  writeFileSync(join(repo, "AGENTS.md"), `${"Agent instructions. ".repeat(200)}\n`);
  git(repo, "add", "AGENTS.md");
  git(repo, "commit", "-q", "-m", "Add AGENTS.md");
  const tokens = (extra) => {
    const rendered = run("render", { RUNNER_TEMP: temp, ...extra });
    assert.equal(rendered.status, 0, rendered.stdout + rendered.stderr);
    return readFileSync(join(rendered.outputs["image-dir"], "strata-badge.json"), "utf8");
  };
  assert.notEqual(tokens({}), tokens({ STRATA_IGNORE: " AGENTS.md, examples/** " }));
});

test("check refuses the default branch and names that are not plain branches", (t) => {
  const { run } = setup(t);
  assert.equal(run("check").status, 0);
  assert.equal(run("check", { STRATA_IMAGE_BRANCH: "assets/strata" }).status, 0);
  const main = run("check", { STRATA_IMAGE_BRANCH: "main" });
  assert.equal(main.status, 1);
  assert.match(main.stdout, /cannot be the default branch/);
  for (const name of ["-x", "a..b", "a b", "refs@{1}", "x.lock", "a/", "$(id)"]) {
    const result = run("check", { STRATA_IMAGE_BRANCH: name });
    assert.equal(result.status, 1, name);
    assert.match(result.stdout, /must be a plain branch name/, name);
  }
});

test("the Action gives the token only to the publish step, on a push to the default branch", () => {
  const steps = action.split("\n    - ").slice(1);
  const holders = steps.filter((step) => step.includes("github.token"));
  assert.equal(holders.length, 1);
  assert.match(holders[0], /^name: Publish the image/);
  assert.match(holders[0], /action-image\.sh" publish/);
  assert.doesNotMatch(holders[0], /STRATA_DIST|cli\.js|npm|npx|node /);
  const render = steps.find((step) => step.startsWith("name: Render the image"));
  assert.match(render, /github\.event_name == 'push'/);
  assert.match(render, /github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/);
  assert.match(holders[0], /steps\.image\.outcome == 'success'/);
});
