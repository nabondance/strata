import assert from "node:assert/strict";
import test from "node:test";
import { analyzeRepository } from "../dist/analyze.js";
import { configMap } from "../dist/config-map.js";
import { expandRevisions } from "../dist/expand.js";
import { importLinks } from "../dist/import-links.js";
import { redactReport, shareableConventions } from "../dist/privacy.js";
import { renderHtml } from "../dist/report.js";
import { loadReportUi } from "./report-ui.mjs";
import { syntheticRepo } from "./synthetic-repo.mjs";

/**
 * A map's folder tree without its names: each row's kind, how many folders its row stands for, its
 * file, source-only, and token counts, and its children, in a fixed order. Two maps with the same
 * shape give the same string whatever their rows are called.
 */
function mapShape(map) {
  const children = map.rows.map(() => []);
  const roots = [];
  for (const [index, row] of map.rows.entries()) (row.parent < 0 ? roots : children[row.parent]).push(index);
  const shape = (index) => {
    const row = map.rows[index];
    const below = children[index].map(shape).sort();
    return JSON.stringify([row.kind, row.depth, row.chain?.length ?? 0, row.files, row.sourceOnly, row.tokens, below]);
  };
  return roots.map(shape).sort();
}

// Names the repository chose. None may appear anywhere in the shareable JSON or HTML.
const privateNames = [
  "acmecorp",
  "corelib",
  "paysvc",
  "webportal",
  "billingdesk",
  "deploy-checks",
  "smoke-test",
  "runbook",
  "lintwise",
  "backendish",
  "frontendish",
  "secretsafe",
  "handbook",
  "onboarding",
  "acme-tools",
];

test("a shareable report keeps the folder tree, categories, and totals, and no name the repository chose", async () => {
  const { repo, put, git, commit, cleanup } = syntheticRepo("strata-shareable-");
  try {
    put("AGENTS.md", "Root instructions.\n@docs/handbook.md\n");
    put("CLAUDE.md", "@AGENTS.md\n@packages/corelib/AGENTS.md\n@acmecorp/onboarding\n");
    put("docs/handbook.md", "Handbook for the team.\n");
    put("packages/corelib/AGENTS.md", "Core package instructions.\n");
    put("packages/paysvc/AGENTS.md", "Server package instructions.\n");
    put("packages/paysvc/CLAUDE.md", "Server Claude instructions.\n");
    // A folder literally named `skills`, and one named like an alias, under a package.
    put("packages/skills/AGENTS.md", "A package called skills.\n");
    put("packages/d1/AGENTS.md", "A package whose name looks like an alias.\n");
    put(
      ".claude/skills/deploy-checks/SKILL.md",
      "---\nname: deploy-checks\ndescription: Check a deploy.\n---\nSteps.\n",
    );
    put(".claude/skills/deploy-checks/references/runbook.md", "Runbook.\n");
    put(".claude/skills/deploy-checks/scripts/smoke-test.py", "print('ok')\n");
    put(".claude/skills/deploy-checks/scripts/smoke-test.sh", "#!/bin/sh\n");
    put(".claude/rules/lintwise.md", "Run the linter.\n");
    put(".claude/agents/billingdesk.md", "You handle billing questions.\n");
    put(".claude/settings.json", "{}\n");
    put(".mcp.json", '{"mcpServers":{"acme-tools":{"command":"acmecorp"}}}\n');
    put(".github/instructions/backendish.instructions.md", "Backend rules.\n");
    put(".github/instructions/frontendish.instructions.md", "Frontend rules.\n");
    put(".cursor/rules/secretsafe.mdc", "---\nalwaysApply: true\n---\nNever print secrets.\n");
    commit("Configure agents");
    git("mv", "packages/paysvc", "packages/webportal");
    put("packages/corelib/AGENTS.md", "Core package instructions, longer now.\n");
    commit("Rename the payment package");

    const report = await analyzeRepository(repo);
    const shareable = redactReport(report);
    const json = JSON.stringify(shareable);
    const html = renderHtml(shareable);
    for (const name of privateNames) {
      assert.ok(JSON.stringify(report).includes(name), `the local report names ${name}`);
      assert.ok(!json.includes(name), `the shareable JSON names ${name}`);
      assert.ok(!html.includes(name), `the shareable HTML names ${name}`);
    }
    // `packages` and `docs` are also private, but too common to search the HTML for.
    assert.doesNotMatch(json, /packages|docs/);

    // Every segment is a convention name or an alias, and a file keeps its extension or Copilot suffix.
    const segments = new Set(
      shareable.components.flatMap((component) => [
        ...component.path.split("/"),
        ...(component.imports ?? []).flatMap(({ target }) => (target ? target.split("/") : [])),
      ]),
    );
    for (const segment of segments) {
      assert.ok(shareableConventions.names.has(segment) || /^[df]\d+(\.[a-z.]+)?$/.test(segment), segment);
    }
    const paths = shareable.components.map((component) => component.path);
    assert.ok(paths.includes(".claude/settings.json"));
    assert.ok(paths.includes(".mcp.json"));
    assert.ok(paths.some((path) => /^\.claude\/skills\/d\d+\/scripts\/f\d+\.py$/.test(path)));
    assert.ok(paths.some((path) => /^\.github\/instructions\/f\d+\.instructions\.md$/.test(path)));
    assert.ok(paths.some((path) => /^\.cursor\/rules\/f\d+\.mdc$/.test(path)));
    assert.ok(paths.some((path) => /^d\d+\/skills\/AGENTS\.md$/.test(path)));
    // The folder named `d1` gets an alias like any other, and no two folders share one.
    const packageFolders = new Set(
      paths.filter((path) => /^d\d+\/[^/]+\/AGENTS\.md$/.test(path)).map((path) => path.split("/")[1]),
    );
    assert.equal(packageFolders.size, 5);
    // The two stems of `smoke-test.py` and `smoke-test.sh` share an alias, and the two packages' AGENTS.md
    // share their package folder's alias.
    assert.equal(
      new Set(paths.filter((path) => /\/f\d+\.(py|sh)$/.test(path)).map((path) => path.slice(0, -3))).size,
      1,
    );
    // A rename keeps a previous path in the same folder alias as the files still there.
    const renames = shareable.revisions.flatMap((revision) => revision.changes.filter((change) => change.previousPath));
    assert.ok(renames.length >= 2);
    for (const change of renames) {
      assert.equal(change.previousPath.split("/")[0], change.path.split("/")[0]);
      assert.notEqual(change.previousPath.split("/")[1], change.path.split("/")[1]);
    }
    assert.match(shareable.components.find((component) => component.skill)?.skill.root, /^\.claude\/skills\/d\d+$/);
    // The table stays ordered by path, so sorting indexes sorts an inventory.
    const collator = new Intl.Collator();
    assert.deepEqual(
      [...paths].sort((a, b) => collator.compare(a, b)),
      paths,
    );

    // Expanded, both reports draw the same tree with the same categories and totals at every revision.
    const local = expandRevisions(report);
    const shared = expandRevisions(shareable);
    assert.equal(shared.length, local.length);
    for (const [index, revision] of local.entries()) {
      const sharedRevision = shared[index];
      assert.equal(sharedRevision.estimatedTokens, revision.estimatedTokens);
      assert.deepEqual(sharedRevision.categoryTotals, revision.categoryTotals);
      assert.equal(sharedRevision.skillGroups.length, revision.skillGroups.length);
      const localLinks = importLinks(revision.components);
      const sharedLinks = importLinks(sharedRevision.components);
      assert.deepEqual(sharedLinks.map(({ status }) => status).sort(), localLinks.map(({ status }) => status).sort());
      const localMap = configMap(revision.components, localLinks, { fallback: "expanded" });
      const sharedMap = configMap(sharedRevision.components, sharedLinks, { fallback: "expanded" });
      assert.deepEqual(mapShape(sharedMap), mapShape(localMap));
      assert.equal(sharedMap.folders, localMap.folders);
      assert.equal(sharedMap.edges.length, localMap.edges.length);
      assert.ok(sharedMap.folders >= 5);
    }

    // The report's map draws folders, and its note no longer says paths have none.
    const ui = loadReportUi(html);
    const folderRows = ui.get("config-map").children.filter((child) => child.className.startsWith("map-row folder"));
    assert.ok(folderRows.length > 0);
    assert.doesNotMatch(ui.get("map-hover").textContent, /not grouped into folders/);
  } finally {
    cleanup();
  }
});

test("convention names never take an alias's shape", () => {
  for (const name of shareableConventions.names) assert.doesNotMatch(name, /^[df]\d+(\.|$)/);
  for (const suffix of shareableConventions.suffixes) assert.match(suffix, /^\.[a-z0-9.]+$/);
});
