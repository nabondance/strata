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
export type Provider = "claude" | "codex" | "gemini" | "shared" | "unknown";
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
   * For a shared file, the providers documented as reading its path. A reader may still depend on
   * a runtime condition Strata does not resolve, such as Claude Code reading `AGENTS.md`.
   */
  readers?: Provider[];
  /** Set on files Gemini CLI reads only while `context.fileName` names them (or leaves it at its default). */
  contextFile?: ContextFile;
  skillRoot?: string;
  skillRole?: "manifest" | "resource";
}

type Adapter = (path: string, parts: string[]) => Classification | null;

// Codex and Gemini CLI both discover project skills under `.agents/skills`.
const skillDirectories: Array<[directory: string, provider: Provider, readers?: Provider[]]> = [
  [".agents", "shared", ["codex", "gemini"]],
  [".claude", "claude"],
  [".gemini", "gemini"],
];

function skill(_path: string, parts: string[]): Classification | null {
  for (const [directory, provider, readers] of skillDirectories) {
    const index = parts.indexOf(directory);
    if (index < 0) continue;
    const within = parts.slice(index + 1);
    if (within[0] !== "skills") continue;
    const labels = { provider, ...(readers ? { readers: [...readers] } : {}) };
    // Gemini CLI also accepts a single skill whose manifest sits directly in its skill directory;
    // Codex and Claude Code document only `<name>/SKILL.md`.
    if (directory !== ".claude" && within.length === 2 && within[1] === "SKILL.md") {
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
        readers: ["claude", "codex"],
        contextFile: "agents-md",
      }
    : null;
}

function candidateExtension(filename: string | undefined): boolean {
  return /\.(?:md|json|toml|rules)$/.test(filename ?? "");
}

const adapters: Adapter[] = [skill, shared, codex, claude, gemini];

export function classify(path: string): Classification | null {
  const parts = path.split("/");
  for (const adapter of adapters) {
    const classification = adapter(path, parts);
    if (classification) return classification;
  }
  return null;
}
