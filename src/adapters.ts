export const categories = [
  "instructions",
  "skills",
  "agents",
  "rules",
  "commands",
  "memory",
  "settings",
  "tools",
  "other",
] as const;

export type Category = (typeof categories)[number];
export type Provider = "claude" | "codex" | "copilot" | "cursor" | "gemini" | "shared" | "unknown";
/**
 * Context files whose Gemini CLI loading depends on `context.fileName`: `AGENTS.md` and `GEMINI.md`.
 * The labels are not the file names, so they cannot match a path a shareable report aliases.
 */
export type ContextFile = "agents-md" | "gemini-md";

export interface Classification {
  provider: Provider;
  category: Category;
  instructionalText: boolean;
  /**
   * The providers documented as reading the path, on a shared file or on another tool's file Cursor
   * or Copilot reads for compatibility. A reader may still depend on a runtime condition Strata does
   * not resolve, such as Claude Code reading `AGENTS.md`. Cursor and Copilot read a file they do not
   * own only at a revision that tracks their own configuration, and each is left out of `readers`
   * when no revision does.
   */
  readers?: Provider[];
  /** Set on files Gemini CLI reads only while `context.fileName` names them (or leaves it at its default). */
  contextFile?: ContextFile;
  /** Set on a format the provider still reads but documents as superseded, such as `.cursorrules`. */
  legacy?: true;
  skillRoot?: string;
  skillRole?: "manifest" | "resource";
  /** Set on `CLAUDE.md`, `CLAUDE.local.md`, and `AGENTS.md`, where Claude Code starts expanding `@path` imports. */
  importRoot?: true;
  /** Set on files recognized only because a Claude `@path` import reaches them; never by `classify`. */
  imported?: boolean;
  /**
   * Set on an instruction file at the repository root that its readers load when a session starts
   * there: `listed`, or `unresolved` when the provider's documentation does not say. Root rules
   * get theirs from their frontmatter instead; see `src/rule-loading.ts`.
   */
  upFront?: UpFront;
}

/** Whether a file is stored text an agent keeps from the start of a session at the repository root. */
export type UpFront = "listed" | "unresolved";

/**
 * Root instruction files that sessions started at the repository root load. `REVIEW.md` is left
 * out, because only code review reads it, and `.gemini/system.md`, which needs `GEMINI_SYSTEM_MD`.
 * Cursor's documentation no longer says when the legacy `.cursorrules` applies.
 */
const upFrontPaths: Record<string, UpFront> = {
  "CLAUDE.md": "listed",
  ".claude/CLAUDE.md": "listed",
  "CLAUDE.local.md": "listed",
  "AGENTS.md": "listed",
  "AGENTS.override.md": "listed",
  "GEMINI.md": "listed",
  ".github/copilot-instructions.md": "listed",
  ".cursorrules": "unresolved",
};

type Adapter = (path: string, parts: string[]) => Classification | null;

// Codex, Copilot, Cursor, and Gemini CLI all discover project skills under `.agents/skills`.
// Copilot and Cursor also load `.claude/skills` for compatibility; those skills stay Claude's, with
// Copilot and Cursor as conditional readers (see `providerReads`).
const skillDirectories: Array<[directory: string, provider: Provider, readers?: Provider[]]> = [
  [".agents", "shared", ["codex", "copilot", "cursor", "gemini"]],
  [".claude", "claude", ["claude", "copilot", "cursor"]],
  [".gemini", "gemini"],
  [".cursor", "cursor"],
  [".github", "copilot"],
];

function skill(_path: string, parts: string[]): Classification | null {
  for (const [directory, provider, readers] of skillDirectories) {
    const index = parts.indexOf(directory);
    if (index < 0) continue;
    const within = parts.slice(index + 1);
    if (within[0] !== "skills") continue;
    const labels = { provider, ...(readers ? { readers: [...readers] } : {}) };
    // Gemini CLI also accepts a single skill whose manifest sits directly in its skill directory;
    // Codex, Claude Code, Copilot, and Cursor document only `<name>/SKILL.md`.
    if ((directory === ".agents" || directory === ".gemini") && within.length === 2 && within[1] === "SKILL.md") {
      return {
        provider: "gemini",
        category: "skills",
        instructionalText: true,
        skillRoot: parts.slice(0, index + 2).join("/"),
        skillRole: "manifest",
      };
    }
    if (within.length < 3) continue;
    const manifest = within.length === 3 && parts.at(-1) === "SKILL.md";
    return {
      ...labels,
      category: "skills",
      instructionalText: manifest,
      skillRoot: parts.slice(0, index + 3).join("/"),
      skillRole: manifest ? "manifest" : "resource",
    };
  }
  return null;
}

function gemini(_path: string, parts: string[]): Classification | null {
  const filename = parts.at(-1);
  if (filename === "GEMINI.md") {
    return {
      provider: "gemini",
      readers: ["copilot", "gemini"],
      category: "instructions",
      instructionalText: true,
      contextFile: "gemini-md",
    };
  }
  const index = parts.indexOf(".gemini");
  if (index < 0) return null;
  const within = parts.slice(index + 1);
  if (within.length === 1 && filename === "settings.json") {
    return { provider: "gemini", category: "settings", instructionalText: false };
  }
  if (within.length === 1 && filename === "system.md") {
    return { provider: "gemini", category: "instructions", instructionalText: true };
  }
  // Gemini CLI reads only top-level agent files and skips names starting with `_`.
  if (within[0] === "agents" && within.length === 2 && filename?.endsWith(".md") && !filename.startsWith("_")) {
    return { provider: "gemini", category: "agents", instructionalText: true };
  }
  if (within[0] === "commands" && within.length >= 2 && filename?.endsWith(".toml")) {
    return { provider: "gemini", category: "commands", instructionalText: false };
  }
  return candidateExtension(filename) ? { provider: "gemini", category: "other", instructionalText: false } : null;
}

function claude(path: string, parts: string[]): Classification | null {
  const filename = parts.at(-1);
  // Copilot reads `CLAUDE.md` and the root `.mcp.json` too, but not `CLAUDE.local.md`.
  if (filename === "CLAUDE.md") {
    return {
      provider: "claude",
      readers: ["claude", "copilot"],
      category: "instructions",
      instructionalText: true,
      importRoot: true,
    };
  }
  if (filename === "CLAUDE.local.md") {
    return { provider: "claude", category: "instructions", instructionalText: true, importRoot: true };
  }
  // Claude Code's Code Review service reads `REVIEW.md` at the root and in subfolders; Copilot code
  // review reads it too, alongside `CLAUDE.md`.
  if (filename === "REVIEW.md") {
    return { provider: "claude", readers: ["claude", "copilot"], category: "instructions", instructionalText: true };
  }
  if (path === ".mcp.json") {
    return { provider: "claude", readers: ["claude", "copilot"], category: "tools", instructionalText: false };
  }
  const index = parts.indexOf(".claude");
  if (index < 0) return null;
  const within = parts.slice(index + 1);
  if (within.length === 1 && /^settings(?:\.local)?\.json$/.test(filename ?? "")) {
    return { provider: "claude", category: "settings", instructionalText: false };
  }
  if (within.length >= 2 && filename?.endsWith(".md")) {
    // VS Code's Copilot reads Claude agents and rules in their own format, skipping `README.md`, and
    // Copilot CLI reads agents.
    const copilotReads = filename !== "README.md" ? { readers: ["claude", "copilot"] satisfies Provider[] } : {};
    if (within[0] === "agents")
      return { provider: "claude", ...copilotReads, category: "agents", instructionalText: true };
    if (within[0] === "rules")
      return { provider: "claude", ...copilotReads, category: "rules", instructionalText: true };
    if (within[0] === "commands") return { provider: "claude", category: "commands", instructionalText: true };
    if ((within[0] === "agent-memory" || within[0] === "agent-memory-local") && within.length >= 3) {
      return { provider: "claude", category: "memory", instructionalText: true };
    }
  }
  return candidateExtension(filename) ? { provider: "claude", category: "other", instructionalText: false } : null;
}

function codex(_path: string, parts: string[]): Classification | null {
  const filename = parts.at(-1);
  if (filename === "AGENTS.override.md") {
    return { provider: "codex", category: "instructions", instructionalText: true };
  }
  if (parts.includes(".agents") && candidateExtension(filename)) {
    return { provider: "unknown", category: "other", instructionalText: false };
  }
  const index = parts.indexOf(".codex");
  if (index < 0) return null;
  const within = parts.slice(index + 1);
  if (within.length === 1 && filename === "config.toml") {
    return { provider: "codex", category: "settings", instructionalText: false };
  }
  if (within[0] === "agents" && within.length === 2 && filename?.endsWith(".toml")) {
    return { provider: "codex", category: "agents", instructionalText: false };
  }
  if (within[0] === "rules" && within.length >= 2 && filename?.endsWith(".rules")) {
    return { provider: "codex", category: "rules", instructionalText: false };
  }
  return candidateExtension(filename) ? { provider: "codex", category: "other", instructionalText: false } : null;
}

function shared(_path: string, parts: string[]): Classification | null {
  // Gemini CLI reads AGENTS.md only when configured to; that depends on the revision, not the file.
  return parts.at(-1) === "AGENTS.md"
    ? {
        provider: "shared",
        category: "instructions",
        instructionalText: true,
        readers: ["claude", "codex", "copilot", "cursor"],
        contextFile: "agents-md",
        importRoot: true,
      }
    : null;
}

function cursor(path: string, parts: string[]): Classification | null {
  // Cursor still reads a root `.cursorrules`, but documents `.cursor/rules` as its replacement.
  if (path === ".cursorrules") return { provider: "cursor", category: "rules", instructionalText: true, legacy: true };
  if (path === ".cursorignore") return { provider: "cursor", category: "settings", instructionalText: false };
  const index = parts.indexOf(".cursor");
  if (index < 0) return null;
  const within = parts.slice(index + 1);
  const filename = parts.at(-1) ?? "";
  // Cursor ignores a rule file without the `.mdc` extension, so plain Markdown there stays `other`.
  if (within[0] === "rules" && within.length >= 2 && filename.endsWith(".mdc")) {
    return { provider: "cursor", category: "rules", instructionalText: true };
  }
  if (within[0] === "commands" && within.length === 2 && filename.endsWith(".md")) {
    return { provider: "cursor", category: "commands", instructionalText: true };
  }
  if (within.length === 1 && filename === "mcp.json") {
    return { provider: "cursor", category: "tools", instructionalText: false };
  }
  // Projects also keep notes and reports under `.cursor/`, so only Cursor's own folders and its
  // top-level JSON configuration stay visible as candidates.
  const candidate =
    ["rules", "commands", "skills"].includes(within[0] ?? "") || (within.length === 1 && filename.endsWith(".json"));
  return candidate && /\.(?:md|mdc|json)$/.test(filename)
    ? { provider: "cursor", category: "other", instructionalText: false }
    : null;
}

/** Copilot's own folders under `.github` and VS Code's `.vscode/mcp.json`; nothing else in `.github`. */
function copilot(path: string, parts: string[]): Classification | null {
  const own = (category: Category, instructionalText: boolean, legacy = false): Classification => ({
    provider: "copilot",
    category,
    instructionalText,
    ...(legacy ? { legacy: true as const } : {}),
  });
  if (path === ".vscode/mcp.json") return own("tools", false);
  const index = parts.indexOf(".github");
  if (index < 0) return null;
  const within = parts.slice(index + 1);
  const filename = parts.at(-1) ?? "";
  const markdown = filename.endsWith(".md");
  if (within.length === 1) {
    if (filename === "copilot-instructions.md") return own("instructions", true);
    if (filename === "mcp.json") return own("tools", false);
    return null;
  }
  // Hooks, CLI settings, and environment workflows are read from the repository root only.
  const root = index === 0 && within.length === 2;
  switch (within[0]) {
    case "instructions":
      if (filename.endsWith(".instructions.md")) return own("rules", true);
      return markdown ? own("other", false) : null;
    case "prompts":
      // VS Code reads prompt files directly in the folder, not in subfolders.
      if (within.length === 2 && filename.endsWith(".prompt.md")) return own("commands", true);
      return markdown ? own("other", false) : null;
    case "agents":
      // VS Code skips `README.md` there; a `.chatmode.md` is the format custom agents replaced.
      if (!markdown) return null;
      if (filename === "README.md") return own("other", false);
      return own("agents", true, filename.endsWith(".chatmode.md"));
    case "chatmodes":
      // VS Code no longer reads this folder unless a user setting adds it.
      return markdown ? own("other", false) : null;
    case "skills":
      return candidateExtension(filename) ? own("other", false) : null;
    case "hooks":
      return root && filename.endsWith(".json") ? own("settings", false) : null;
    case "copilot":
      if (root && /^settings(?:\.local)?\.json$/.test(filename)) return own("settings", false);
      return candidateExtension(filename) ? own("other", false) : null;
    case "workflows":
      return root && (filename === "copilot-setup-steps.yml" || filename === "copilot-code-review.yml")
        ? own("settings", false)
        : null;
    default:
      return null;
  }
}

function candidateExtension(filename: string | undefined): boolean {
  return /\.(?:md|json|toml|rules)$/.test(filename ?? "");
}

const adapters: Adapter[] = [skill, shared, codex, claude, gemini, cursor, copilot];

export function classify(path: string): Classification | null {
  const parts = path.split("/");
  for (const adapter of adapters) {
    const classification = adapter(path, parts);
    if (!classification) continue;
    const upFront = Object.hasOwn(upFrontPaths, path) ? upFrontPaths[path] : undefined;
    return upFront && classification.instructionalText ? { ...classification, upFront } : classification;
  }
  return null;
}

/**
 * Whether a path is a rule whose frontmatter decides if it loads at the start of a session at the
 * repository root: a Claude rule in the root `.claude/rules` (unless it sets `paths`) or a Cursor
 * rule in the root `.cursor/rules` (when it sets `alwaysApply: true`). Rules in nested folders
 * load only for work there.
 */
export function rootRuleProvider(path: string, classification: Classification): "claude" | "cursor" | null {
  if (classification.category !== "rules" || !classification.instructionalText) return null;
  if (classification.provider === "claude" && path.startsWith(".claude/rules/")) return "claude";
  if (classification.provider === "cursor" && path.startsWith(".cursor/rules/")) return "cursor";
  return null;
}

/**
 * Providers that need no repository file to run but read other tools' files, and so read those files
 * only at revisions that track their own configuration.
 */
export const conditionalReaders = ["copilot", "cursor"] as const satisfies readonly Provider[];

/**
 * Drop a conditional reader from `readers` in a history with none of its configuration, so a
 * repository that does not use it is described without it. A file left with only its own provider
 * loses `readers`.
 */
export function withoutReader(classification: Classification, reader: Provider): void {
  if (!classification.readers?.includes(reader)) return;
  const readers = classification.readers.filter((entry) => entry !== reader);
  if (readers.length === 1 && readers[0] === classification.provider) delete classification.readers;
  else classification.readers = readers;
}
