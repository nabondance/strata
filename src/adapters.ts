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
export type Provider = "claude" | "codex" | "shared" | "unknown";

export interface Classification {
  provider: Provider;
  category: Category;
  instructionalText: boolean;
}

type Adapter = (path: string, parts: string[]) => Classification | null;

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
  if (within[0] === "skills" && within.length === 3 && filename === "SKILL.md") {
    return { provider: "claude", category: "skills", instructionalText: true };
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
  const skillsIndex = parts.indexOf(".agents");
  if (skillsIndex >= 0) {
    const within = parts.slice(skillsIndex + 1);
    if (within[0] === "skills" && within.length === 3 && filename === "SKILL.md") {
      return { provider: "codex", category: "skills", instructionalText: true };
    }
    if (candidateExtension(filename)) {
      return { provider: "unknown", category: "other", instructionalText: false };
    }
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
  return parts.at(-1) === "AGENTS.md"
    ? { provider: "shared", category: "instructions", instructionalText: true }
    : null;
}

function candidateExtension(filename: string | undefined): boolean {
  return /\.(?:md|json|toml|rules)$/.test(filename ?? "");
}

const adapters: Adapter[] = [shared, codex, claude];

export function classify(path: string): Classification | null {
  const parts = path.split("/");
  for (const adapter of adapters) {
    const classification = adapter(path, parts);
    if (classification) return classification;
  }
  return null;
}
