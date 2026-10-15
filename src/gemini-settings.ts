import type { ContextFile } from "./adapters.js";

const contextFiles = new Map<string, ContextFile>([
  ["AGENTS.md", "agents-md"],
  ["GEMINI.md", "gemini-md"],
]);

/** The workspace settings file whose `context.fileName` Strata resolves. Nested copies are not consulted. */
export const geminiSettingsPath = ".gemini/settings.json";

/** Remove `//` and `/* *\/` comments outside strings, as Gemini CLI does before parsing its settings. */
function stripComments(text: string): string {
  let output = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === '"') {
      const start = index;
      for (index += 1; index < text.length && text[index] !== '"'; index += 1) if (text[index] === "\\") index += 1;
      output += text.slice(start, index + 1);
    } else if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      output += "\n";
    } else if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end < 0 ? text.length : end + 1;
      output += " ";
    } else {
      output += char;
    }
  }
  return output;
}

/**
 * The recognized context files Gemini CLI settings configure, or null when they leave the
 * default (`GEMINI.md`) in place. `context.fileName` replaces that default; `contextFileName` is its
 * name before the settings format changed. Settings that do not parse leave the default. Other
 * configured names are dropped: Strata does not recognize those files, and the report would
 * otherwise carry repository-chosen names that `--shareable` does not alias.
 */
export function geminiContextFiles(text: string): ContextFile[] | null {
  let settings: unknown;
  try {
    settings = JSON.parse(stripComments(text.replace(/^\uFEFF/, "")));
  } catch {
    return null;
  }
  if (!settings || typeof settings !== "object") return null;
  const { context, contextFileName } = settings as { context?: { fileName?: unknown }; contextFileName?: unknown };
  const names = context && typeof context === "object" && "fileName" in context ? context.fileName : contextFileName;
  const list = typeof names === "string" ? [names] : Array.isArray(names) ? names : null;
  if (!list) return null;
  return [...contextFiles].flatMap(([name, label]) => (list.includes(name) ? [label] : []));
}
