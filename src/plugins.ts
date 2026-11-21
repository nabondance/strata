import type { Classification } from "./adapters.js";
import { type ContentUse, utf8Text } from "./content-pass.js";
import { availableBlobSizes, readBlobs } from "./git.js";
import { type TrackedFile, versionKey } from "./inventory.js";
import { assignmentAt, keyParts, tomlLines } from "./mcp-servers.js";
import type { PluginRef, PluginRefs } from "./model.js";

/**
 * How a file names plugins: `settings` and `codex-config` turn them on or off, `manifest` defines
 * one, `skills-folder` defines one in the root `.claude/skills`, which Claude Code loads without a
 * settings entry, and `marketplace` is a catalog of them. `agent-manifest` is a `plugin.json` already
 * tracked inside an agent's folder, which defines a plugin only if it declares the Agent Plugins schema.
 */
type PluginFormat = "settings" | "codex-config" | "manifest" | "agent-manifest" | "skills-folder" | "marketplace";

/** The plugin format of a recognized file, or null when the file cannot name a plugin. */
export function pluginFormat(path: string, classification: Classification): PluginFormat | null {
  const parts = path.split("/");
  const name = parts.at(-1) ?? "";
  // A manifest saved inside a Claude skill folder stays that skill's resource, so it has no package label.
  if (classification.provider === "claude" && parts.at(-2) === ".claude-plugin" && name === "plugin.json") {
    return /^\.claude\/skills\/[^/]+\/\.claude-plugin\/plugin\.json$/.test(path) ? "skills-folder" : "manifest";
  }
  if (classification.pluginPackage) return name === "marketplace.json" ? "marketplace" : "manifest";
  if (classification.category === "other" && name === "plugin.json") return "agent-manifest";
  if (classification.category !== "settings") return null;
  if (classification.provider === "codex") return name === "config.toml" ? "codex-config" : null;
  if (classification.provider === "claude") return parts.at(-2) === ".claude" ? "settings" : null;
  return classification.provider === "copilot" && /^\.github\/copilot\/settings(?:\.local)?\.json$/.test(path)
    ? "settings"
    : null;
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

const agentPluginSchema = /^https:\/\/agent-plugins\.org\/schemas\/\d+\.\d+\.\d+\/plugin\.schema\.json$/;

/** Whether a parsed `plugin.json` declares the Agent Plugins schema that Copilot, Codex, and Cursor share. */
const isAgentManifest = (value: unknown): value is { name: string } =>
  isObject(value) && isName(value.name) && typeof value.$schema === "string" && agentPluginSchema.test(value.$schema);

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
    // A path in the repository: a string, Codex's `{ source: "local", path }`, or Cursor's `{ path }`.
    if (typeof source === "string") counted.local += 1;
    else if (!isObject(source)) return unresolved;
    else if (source.source === "local" || (source.source === undefined && isName(source.path))) counted.local += 1;
    else if (isName(source.source)) counted.external += 1;
    else return unresolved;
  }
  return listed([{ name: marketplace.name, state: "catalog", listed: counted }]);
}

/**
 * The `[plugins."<plugin>@<marketplace>"]` tables of a Codex `config.toml`, or null when it has none.
 * Strata reads only this subset of TOML; a plugin without a literal `enabled`, an inline table, or
 * anything else it cannot follow makes the list unresolved.
 */
function codexPlugins(text: string): PluginRefs | null {
  if (!text.includes("plugins")) return null;
  const lines = tomlLines(text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n"));
  if (!lines) return unresolved;
  const states = new Map<string, boolean | null>();
  const entry = (name: string) => {
    if (!states.has(name)) states.set(name, null);
  };
  let table: string[] = [];
  let mentioned = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("[")) {
      const header = line.match(/^\[\[(.*)\]\]$/) ?? line.match(/^\[(.*)\]$/);
      const parts = header ? keyParts(header[1]!) : null;
      if (!parts) return unresolved;
      if (parts[0] === "plugins") {
        if (line.startsWith("[[")) return unresolved;
        mentioned = true;
        if (parts[1] !== undefined) entry(parts[1]);
      }
      table = parts;
      continue;
    }
    const equals = assignmentAt(line);
    const key = equals < 0 ? null : keyParts(line.slice(0, equals));
    if (!key) return unresolved;
    const path = [...table, ...key];
    if (path[0] !== "plugins") continue;
    mentioned = true;
    if (path.length < 3) return unresolved;
    entry(path[1]!);
    if (path.length === 3 && path[2] === "enabled") {
      const value = line.slice(equals + 1).trim();
      if (value !== "true" && value !== "false") return unresolved;
      states.set(path[1]!, value === "true");
    }
  }
  if (!mentioned) return null;
  const plugins: PluginRef[] = [];
  for (const [name, enabled] of states) {
    if (enabled === null) return unresolved;
    plugins.push({ name, state: enabled ? "enabled" : "disabled" });
  }
  return listed(plugins);
}

/** The plugins one version of a file names, or null when a settings file names none. */
export function pluginRefs(text: string, format: PluginFormat): PluginRefs | null {
  if (format === "settings") return settingsPlugins(text);
  if (format === "codex-config") return codexPlugins(text);
  if (format === "agent-manifest") {
    const manifest = parsed(text);
    return isAgentManifest(manifest) ? listed([{ name: manifest.name, state: "defined" }]) : null;
  }
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
      const optional = format === "settings" || format === "codex-config" || format === "agent-manifest";
      const plugins = text === null ? (optional ? null : unresolved) : pluginRefs(text, format);
      if (plugins) this.lists.set(versionKey(file.path, file.blob), plugins);
    }
  }
}

/** The largest marketplace Cursor documents; a larger file with one of these names is not a package. */
const maxPackageBytes = 10 * 1024 * 1024;

/**
 * The candidates that really are plugin packages: a `plugin.json` that declares the Agent Plugins
 * `$schema`, which Copilot, Codex, and Cursor share, or a root `marketplace.json` with the required
 * `name`, `owner`, and `plugins`. Another `plugin.json`, including Copilot's legacy form, cannot be
 * told apart from any other project's file, so it is left out, as is one that cannot be read.
 */
export function confirmedPackages(repo: string, files: TrackedFile[]): TrackedFile[] {
  if (!files.length) return [];
  const blobs = [...new Set(files.map((file) => file.blob))];
  const sizes = availableBlobSizes(repo, blobs);
  const readable = blobs.filter((blob) => (sizes.get(blob) ?? Number.POSITIVE_INFINITY) <= maxPackageBytes);
  const manifests = new Set<string>();
  const catalogs = new Set<string>();
  for (const [blob, body] of readBlobs(repo, readable, (id) => sizes.get(id) ?? 0)) {
    const text = utf8Text(body);
    const value = text === null ? undefined : parsed(text);
    if (isAgentManifest(value)) manifests.add(blob);
    if (isObject(value) && isName(value.name) && isObject(value.owner) && Array.isArray(value.plugins)) {
      catalogs.add(blob);
    }
  }
  return files.filter((file) => (file.path === "marketplace.json" ? catalogs : manifests).has(file.blob));
}
