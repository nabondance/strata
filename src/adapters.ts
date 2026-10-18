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
export type Provider = "claude" | "codex" | "cursor" | "gemini" | "shared" | "unknown";
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
   * reads for compatibility. A reader may still depend on a runtime condition Strata does not
   * resolve, such as Claude Code reading `AGENTS.md`. Cursor reads a file it does not own only at a
   * revision that tracks Cursor configuration, and is left out of `readers` when no revision does.
   */
  readers?: Provider[];
  /** Set on files Gemini CLI reads only while `context.fileName` names them (or leaves it at its default). */
  contextFile?: ContextFile;
  /** Set on a format the provider still reads but documents as superseded, such as `.cursorrules`. */
  legacy?: true;
  skillRoot?: string;
  skillRole?: "manifest" | "resource";
}

type Adapter = (path: string, parts: string[]) => Classification | null;

// Codex, Cursor, and Gemini CLI all discover project skills under `.agents/skills`. Cursor also
// loads `.claude/skills` for compatibility; those skills stay Claude's, with Cursor as a conditional
// reader (see `providerReads`).
const skillDirectories: Array<[directory: string, provider: Provider, readers?: Provider[]]> = [
  [".agents", "shared", ["codex", "cursor", "gemini"]],
  [".claude", "claude", ["claude", "cursor"]],
  [".gemini", "gemini"],
  [".cursor", "cursor"],
];

function skill(_path: string, parts: string[]): Classification | null {
  for (const [directory, provider, readers] of skillDirectories) {
    const index = parts.indexOf(directory);
    if (index < 0) continue;
    const within = parts.slice(index + 1);
    if (within[0] !== "skills") continue;
    const labels = { provider, ...(readers ? { readers: [...readers] } : {}) };
    // Gemini CLI also accepts a single skill whose manifest sits directly in its skill directory;
    // Codex, Claude Code, and Cursor document only `<name>/SKILL.md`.
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
    return { provider: "gemini", category: "instructions", instructionalText: true, contextFile: "gemini-md" };
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
  if (filename === "CLAUDE.md" || filename === "CLAUDE.local.md") {
    return { provider: "claude", category: "instructions", instructionalText: true };
  }
  if (path === ".mcp.json") {
    return { provider: "claude", category: "tools", instructionalText: false };
  }
  const index = parts.indexOf(".claude");
  if (index < 0) return null;
  const within = parts.slice(index + 1);
  if (within.length === 1 && /^settings(?:\.local)?\.json$/.test(filename ?? "")) {
    return { provider: "claude", category: "settings", instructionalText: false };
  }
  if (within.length >= 2 && filename?.endsWith(".md")) {
    if (within[0] === "agents") return { provider: "claude", category: "agents", instructionalText: true };
    if (within[0] === "rules") return { provider: "claude", category: "rules", instructionalText: true };
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
        readers: ["claude", "codex", "cursor"],
        contextFile: "agents-md",
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

function candidateExtension(filename: string | undefined): boolean {
  return /\.(?:md|json|toml|rules)$/.test(filename ?? "");
}

const adapters: Adapter[] = [skill, shared, codex, claude, gemini, cursor];

export function classify(path: string): Classification | null {
  const parts = path.split("/");
  for (const adapter of adapters) {
    const classification = adapter(path, parts);
    if (classification) return classification;
  }
  return null;
}

/**
 * Drop Cursor from `readers` in a history with no Cursor configuration, so a repository that does not
 * use Cursor is described without it. A file left with only its own provider loses `readers`.
 */
export function withoutCursorReader(classification: Classification): void {
  if (!classification.readers?.includes("cursor")) return;
  const readers = classification.readers.filter((reader) => reader !== "cursor");
  if (readers.length === 1 && readers[0] === classification.provider) delete classification.readers;
  else classification.readers = readers;
}
