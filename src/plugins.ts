import type { Classification } from "./adapters.js";
import { type ContentUse, utf8Text } from "./content-pass.js";
import { type TrackedFile, versionKey } from "./inventory.js";
import type { PluginRef, PluginRefs } from "./model.js";

/**
 * How a file names Claude Code plugins: `settings` turns them on or off, `manifest` defines one,
 * `skills-folder` defines one in the root `.claude/skills`, which Claude Code loads without a
 * settings entry, and `marketplace` is a catalog of them.
 */
type PluginFormat = "settings" | "manifest" | "skills-folder" | "marketplace";

/** The plugin format of a recognized file, or null when the file cannot name a plugin. */
export function pluginFormat(path: string, classification: Classification): PluginFormat | null {
  if (classification.provider !== "claude") return null;
  const parts = path.split("/");
  const name = parts.at(-1) ?? "";
  if (parts.at(-2) === ".claude-plugin") {
    if (name === "marketplace.json") return "marketplace";
    if (name !== "plugin.json") return null;
    return /^\.claude\/skills\/[^/]+\/\.claude-plugin\/plugin\.json$/.test(path) ? "skills-folder" : "manifest";
  }
  return classification.category === "settings" && parts.at(-2) === ".claude" ? "settings" : null;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isName = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** Strict JSON, as Claude Code reads these files; undefined when it does not parse. */
function parsed(text: string): unknown {
  try {
    return JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    return undefined;
  }
}

const listed = (plugins: PluginRef[]): PluginRefs => ({ status: "listed", plugins });
const unresolved: PluginRefs = { status: "unresolved" };

/** A settings file's `enabledPlugins` and `extraKnownMarketplaces`, or null when it has neither. */
function settingsPlugins(text: string): PluginRefs | null {
  if (!/enabledPlugins|extraKnownMarketplaces/.test(text)) return null;
  const settings = parsed(text);
  if (!isObject(settings)) return unresolved;
  const enabled = settings.enabledPlugins;
  const marketplaces = settings.extraKnownMarketplaces;
  if (enabled === undefined && marketplaces === undefined) return null;
  const plugins: PluginRef[] = [];
  if (enabled !== undefined) {
    if (!isObject(enabled)) return unresolved;
    for (const [name, value] of Object.entries(enabled)) {
      if (!name || typeof value !== "boolean") return unresolved;
      plugins.push({ name, state: value ? "enabled" : "disabled" });
    }
  }
  if (marketplaces !== undefined) {
    if (!isObject(marketplaces)) return unresolved;
    for (const [name, value] of Object.entries(marketplaces)) {
      if (!name || !isObject(value)) return unresolved;
      plugins.push({ name, state: "marketplace" });
    }
  }
  return listed(plugins);
}

/** The plugin a manifest defines. In `.claude/skills` its ID is `<name>@skills-dir`, as settings name it. */
function manifestPlugin(text: string, format: "manifest" | "skills-folder"): PluginRefs {
  const manifest = parsed(text);
  if (!isObject(manifest) || !isName(manifest.name)) return unresolved;
  if (format === "manifest") return listed([{ name: manifest.name, state: "defined" }]);
  const name = `${manifest.name}@skills-dir`;
  return listed([{ name, state: manifest.defaultEnabled === false ? "defined" : "skills-folder" }]);
}

/** A marketplace file, by its name and how many plugins it lists. A source's URL is never kept. */
function marketplacePlugins(text: string): PluginRefs {
  const marketplace = parsed(text);
  if (!isObject(marketplace) || !isName(marketplace.name) || !Array.isArray(marketplace.plugins)) return unresolved;
  const counted = { local: 0, external: 0 };
  for (const entry of marketplace.plugins as unknown[]) {
    if (!isObject(entry) || !isName(entry.name)) return unresolved;
    const source = entry.source;
    if (typeof source === "string") counted.local += 1;
    else if (isObject(source) && isName(source.source)) counted.external += 1;
    else return unresolved;
  }
  return listed([{ name: marketplace.name, state: "catalog", listed: counted }]);
}

/** The plugins one version of a file names, or null when a settings file names none. */
export function pluginRefs(text: string, format: PluginFormat): PluginRefs | null {
  if (format === "settings") return settingsPlugins(text);
  return format === "marketplace" ? marketplacePlugins(text) : manifestPlugin(text, format);
}

/**
 * The plugins every distinct version of a settings, manifest, or marketplace file names, keyed by
 * path and blob, found as the shared content pass reads them. Only names and states are kept. A
 * file that is not valid UTF-8 is unresolved, except a settings file, which may have no plugins.
 */
export class PluginLists implements ContentUse {
  readonly lists = new Map<string, PluginRefs>();

  wants(file: TrackedFile): boolean {
    return pluginFormat(file.path, file.classification) !== null;
  }

  read(_blob: string, body: Buffer, files: TrackedFile[]): void {
    const text = utf8Text(body);
    for (const file of files) {
      const format = pluginFormat(file.path, file.classification)!;
      const plugins = text === null ? (format === "settings" ? null : unresolved) : pluginRefs(text, format);
      if (plugins) this.lists.set(versionKey(file.path, file.blob), plugins);
    }
  }
}
