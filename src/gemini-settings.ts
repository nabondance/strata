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
 * Whether Gemini CLI settings name `AGENTS.md` as a context file. `context.fileName` replaces the
 * default `GEMINI.md`; `contextFileName` is its name before the settings format changed. Settings
 * that do not parse leave the default in place.
 */
export function geminiReadsAgentsMd(text: string): boolean {
  let settings: unknown;
  try {
    settings = JSON.parse(stripComments(text.replace(/^﻿/, "")));
  } catch {
    return false;
  }
  if (!settings || typeof settings !== "object") return false;
  const { context, contextFileName } = settings as { context?: { fileName?: unknown }; contextFileName?: unknown };
  const names = context && typeof context === "object" && "fileName" in context ? context.fileName : contextFileName;
  return names === "AGENTS.md" || (Array.isArray(names) && names.includes("AGENTS.md"));
}
