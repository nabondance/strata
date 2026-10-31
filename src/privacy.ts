import type { Report } from "./model.js";

/**
 * Path pieces a shareable report keeps as they are, because they are public tool conventions rather
 * than names a repository chose. `names` are whole folder or file names, kept wherever they appear in
 * a path: the recognized file and folder names in docs/analysis-scope.md. `suffixes` end a file name
 * whose stem is aliased: the Copilot suffixes, then common file extensions. A file name keeps the
 * longest suffix it ends with; one ending with no listed suffix is aliased whole. Every other folder
 * name and file stem is replaced with an alias.
 */
export const shareableConventions = {
  names: new Set([
    // Recognized files.
    "CLAUDE.md",
    "CLAUDE.local.md",
    "AGENTS.md",
    "AGENTS.override.md",
    "REVIEW.md",
    "GEMINI.md",
    "SKILL.md",
    "README.md",
    "settings.json",
    "settings.local.json",
    "mcp.json",
    "hooks.json",
    "config.toml",
    "system.md",
    "copilot-instructions.md",
    "copilot-setup-steps.yml",
    "copilot-code-review.yml",
    ".cursorrules",
    ".cursorignore",
    ".mcp.json",
    // Recognized folders.
    ".claude",
    ".codex",
    ".gemini",
    ".agents",
    ".cursor",
    ".github",
    ".vscode",
    "skills",
    "agents",
    "rules",
    "commands",
    "memory",
    "prompts",
    "instructions",
    "chatmodes",
    "agent-memory",
    "agent-memory-local",
    "workflows",
    "copilot",
    "hooks",
    // The resource folders the Agent Skills format names inside a skill.
    "scripts",
    "references",
    "assets",
  ]),
  suffixes: [
    ".instructions.md",
    ".prompt.md",
    ".agent.md",
    ".chatmode.md",
    ...[
      ...["md", "mdc", "mdx", "markdown", "txt", "rules", "json", "jsonc", "json5", "toml", "yaml", "yml"],
      ...["xml", "csv", "tsv", "ini", "cfg", "conf", "env", "lock", "log", "tmpl", "template", "j2", "hbs"],
      ...["sh", "bash", "zsh", "fish", "ps1", "bat", "cmd", "py", "js", "mjs", "cjs", "ts", "mts", "cts"],
      ...["jsx", "tsx", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "php"],
      ...["lua", "pl", "r", "sql", "html", "htm", "css", "scss", "svg", "png", "jpg", "jpeg", "gif", "webp"],
      ...["ico", "pdf", "ipynb"],
    ].map((extension) => `.${extension}`),
  ],
} as const;

/** Numbers aliases in the order values are first given, padded so that they sort by name in that order. */
class Aliases {
  private readonly order = new Map<string, number>();
  constructor(private readonly prefix: string) {}
  add(value: string): void {
    if (!this.order.has(value)) this.order.set(value, this.order.size + 1);
  }
  get(value: string): string {
    const number = this.order.get(value);
    if (number === undefined) throw new Error("A shareable alias was requested for a value that was never added.");
    return `${this.prefix}${String(number).padStart(String(this.order.size).length, "0")}`;
  }
}

/** Splits a file name into the stem to alias and the suffix to keep. */
function splitName(name: string): [stem: string, suffix: string] {
  const lower = name.toLowerCase();
  const suffix = shareableConventions.suffixes.find(
    (candidate) => lower.endsWith(candidate) && name.length > candidate.length,
  );
  return suffix ? [name.slice(0, -suffix.length), name.slice(-suffix.length)] : [name, ""];
}

/**
 * Aliases paths one segment at a time, so a shareable report keeps the folder tree. Each folder name
 * and each file stem gets its own alias (`d1`, `f1`), the same wherever it appears; convention names
 * stay. Aliases hold no dot and convention names never look like one, so two different paths never
 * get the same alias.
 */
class PathAliases {
  private readonly folders = new Aliases("d");
  private readonly stems = new Aliases("f");
  private readonly kept: ReadonlySet<string> = shareableConventions.names;

  private segments(path: string, lastIsFile: boolean): Array<[segment: string, file: boolean]> {
    const parts = path.split("/");
    return parts.map((segment, index) => [segment, lastIsFile && index === parts.length - 1]);
  }

  /** Records a path; `lastIsFile` is false for a path that names a folder, such as a skill root. */
  add(path: string, lastIsFile = true): void {
    for (const [segment, file] of this.segments(path, lastIsFile)) {
      if (this.kept.has(segment) || segment === "") continue;
      if (file) this.stems.add(splitName(segment)[0]);
      else this.folders.add(segment);
    }
  }

  get(path: string, lastIsFile = true): string {
    return this.segments(path, lastIsFile)
      .map(([segment, file]) => {
        if (this.kept.has(segment) || segment === "") return segment;
        if (!file) return this.folders.get(segment);
        const [stem, suffix] = splitName(segment);
        return `${this.stems.get(stem)}${suffix}`;
      })
      .join("/");
  }
}

/** Numbers values in sorted order, as `prefix-00001`. */
function sortedAliases(values: Iterable<string>, prefix: string): Map<string, string> {
  return new Map(
    [...new Set(values)].sort().map((value, index) => [value, `${prefix}-${String(index + 1).padStart(5, "0")}`]),
  );
}

const collator = new Intl.Collator();

/**
 * Return a redacted copy with identifiers replaced by aliases. The input report is left untouched.
 *
 * Paths are aliased segment by segment (see `PathAliases`), so the copy keeps every folder, its depth,
 * and the files in it. Aliases are numbered in the order the history first mentions each name, which
 * the report already shows, rather than in the names' alphabetical order, which it does not.
 */
export function redactReport(report: Report): Report {
  const paths = new PathAliases();
  for (const revision of report.revisions) {
    for (const change of revision.changes) {
      if (change.previousPath !== undefined) paths.add(change.previousPath);
      paths.add(change.path);
      const component = change.component === null ? undefined : report.components[change.component];
      if (component?.skill) paths.add(component.skill.root, false);
    }
  }
  // Every path a change mentions belongs to some file version, so this adds nothing for a report
  // analysis wrote. An import can name a path no file version has, such as a package name or a
  // symlink, so import targets and the files symlinks lead to are aliased with the same rule.
  for (const component of report.components) {
    paths.add(component.path);
    if (component.skill) paths.add(component.skill.root, false);
    for (const { target, symlinkTarget } of component.imports ?? []) {
      if (target !== null) paths.add(target);
      if (symlinkTarget !== undefined) paths.add(symlinkTarget);
    }
  }
  for (const submodule of report.submodules ?? []) paths.add(submodule.path, false);

  const servers = sortedAliases(
    report.components.flatMap((component) =>
      component.mcp?.status === "listed" ? component.mcp.servers.map((server) => server.name) : [],
    ),
    "server",
  );
  const blobs = sortedAliases(
    report.components.map((component) => component.blob),
    "blob",
  );
  const revisions = new Map(
    report.revisions.map((revision, index) => [revision.id, `revision-${String(index + 1).padStart(5, "0")}`]),
  );
  const outsideParents = sortedAliases(
    report.revisions.flatMap((revision) =>
      revision.firstParent && !revisions.has(revision.firstParent) ? [revision.firstParent] : [],
    ),
    "outside-parent",
  );

  const components = report.components.map((component) => ({
    ...component,
    path: paths.get(component.path),
    blob: blobs.get(component.blob)!,
    ...(component.skill ? { skill: { ...component.skill, root: paths.get(component.skill.root, false) } } : {}),
    ...(component.mcp?.status === "listed"
      ? {
          mcp: {
            ...component.mcp,
            servers: component.mcp.servers.map((server) => ({ ...server, name: servers.get(server.name)! })),
          },
        }
      : {}),
    ...(component.imports
      ? {
          imports: component.imports.map((entry) => ({
            ...entry,
            target: entry.target === null ? null : paths.get(entry.target),
            ...(entry.symlinkTarget === undefined ? {} : { symlinkTarget: paths.get(entry.symlinkTarget) }),
          })),
        }
      : {}),
  }));
  // The table stays ordered by path, now the aliased path, so sorting indexes still sorts an inventory.
  // The sort is stable, so versions of one path keep their order.
  const order = components
    .map((_, index) => index)
    .sort((a, b) => collator.compare(components[a]!.path, components[b]!.path));
  const renumbered = new Array<number>(components.length);
  for (const [position, index] of order.entries()) renumbered[index] = position;

  return {
    ...report,
    repository: "redacted repository",
    branch: "redacted branch",
    privacy: { mode: "shareable" },
    ...(report.submodules
      ? {
          submodules: report.submodules.map((submodule) => ({ ...submodule, path: paths.get(submodule.path, false) })),
        }
      : {}),
    components: order.map((index) => components[index]!),
    revisions: report.revisions.map((revision) => ({
      ...revision,
      id: revisions.get(revision.id)!,
      // An absent firstParent is the previous revision's id, whose alias is the previous alias, so it stays absent.
      ...(revision.firstParent === undefined
        ? {}
        : {
            firstParent: revision.firstParent
              ? (revisions.get(revision.firstParent) ?? outsideParents.get(revision.firstParent)!)
              : null,
          }),
      changes: revision.changes.map((change) => ({
        ...change,
        path: paths.get(change.path),
        ...(change.previousPath !== undefined ? { previousPath: paths.get(change.previousPath) } : {}),
        component: change.component === null ? null : renumbered[change.component]!,
      })),
    })),
  };
}
