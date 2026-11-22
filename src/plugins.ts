import type { Classification } from "./adapters.js";
import { type ContentUse, utf8Text } from "./content-pass.js";
import { blobSizes, readBlobs } from "./git.js";
import { type TrackedFile, versionKey } from "./inventory.js";
import { assignmentAt, keyParts, tomlLines } from "./mcp-servers.js";
import type { PluginRef, PluginRefs } from "./model.js";

/**
 * How a file names plugins: `settings`, `copilot-settings`, and `codex-config` turn them on or off, `manifest` defines
 * one, `skills-folder` defines one in the root `.claude/skills`, which Claude Code loads without a
 * settings entry, and `marketplace` is a catalog of them. `agent-manifest` is a `plugin.json` already
 * tracked inside an agent's folder, which defines a plugin only if it declares the Agent Plugins schema.
 */
type PluginFormat =
  | "settings"
  | "copilot-settings"
  | "codex-config"
  | "manifest"
  | "agent-manifest"
  | "skills-folder"
  | "marketplace"
  | "cursor-marketplace";

/** The plugin format of a recognized file, or null when the file cannot name a plugin. */
export function pluginFormat(path: string, classification: Classification): PluginFormat | null {
  // A file tracked only because a Claude import reaches it is not read as a plugin file.
  if (classification.imported) return null;
  const parts = path.split("/");
  const name = parts.at(-1) ?? "";
  // A manifest saved inside a Claude skill folder stays that skill's resource, so it has no package label.
  if (classification.provider === "claude" && parts.at(-2) === ".claude-plugin" && name === "plugin.json") {
    return /^\.claude\/skills\/[^/]+\/\.claude-plugin\/plugin\.json$/.test(path) ? "skills-folder" : "manifest";
  }
  if (classification.pluginPackage) {
    if (name !== "marketplace.json") return "manifest";
    return classification.provider === "cursor" ? "cursor-marketplace" : "marketplace";
  }
  if (classification.category === "other" && name === "plugin.json") return "agent-manifest";
  if (classification.category !== "settings") return null;
  if (classification.provider === "codex") return name === "config.toml" ? "codex-config" : null;
  if (classification.provider === "claude") return parts.at(-2) === ".claude" ? "settings" : null;
  return classification.provider === "copilot" && /^\.github\/copilot\/settings(?:\.local)?\.json$/.test(path)
    ? "copilot-settings"
    : null;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isName = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** Strict JSON, as Claude Code reads these files; undefined when it does not parse. */
function parsed(text: string): unknown {
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    return undefined;
  }
}

const agentPluginSchema = /^https:\/\/agent-plugins\.org\/schemas\/\d+\.\d+\.\d+\/plugin\.schema\.json$/;

/** Whether a file declares the Agent Plugins schema. One that no longer parses is searched as raw bytes. */
const declaresAgentSchema = (value: unknown, body: Buffer) =>
  value === undefined
    ? /agent-plugins\.org\/schemas\/[^"]*\/plugin\.schema\.json/.test(body.toString("latin1").replaceAll("\0", ""))
    : isObject(value) && typeof value.$schema === "string" && agentPluginSchema.test(value.$schema);

/** Whether a parsed `plugin.json` declares the Agent Plugins schema that Copilot, Codex, and Cursor share. */
const isAgentManifest = (value: unknown): value is { name: string } =>
  isObject(value) && isName(value.name) && typeof value.$schema === "string" && agentPluginSchema.test(value.$schema);

const listed = (plugins: PluginRef[]): PluginRefs => ({ status: "listed", plugins });
const unresolved: PluginRefs = { status: "unresolved" };

/**
 * A settings file's `enabledPlugins` and `extraKnownMarketplaces`, or null when it has neither.
 * Claude's settings schema also allows a list of strings as a value; Copilot documents only booleans.
 */
function settingsPlugins(text: string, allowsLists: boolean): PluginRefs | null {
  // A key can also be written with JSON escapes, so only a file with neither is skipped unparsed.
  const mentioned = /enabledPlugins|extraKnownMarketplaces/.test(text);
  if (!mentioned && !text.includes("\\u")) return null;
  const settings = parsed(text);
  // An escape can hide the key in a file that does not parse, so its plugins are unknown.
  if (settings === undefined) return unresolved;
  if (!isObject(settings)) return mentioned ? unresolved : null;
  const enabled = settings.enabledPlugins;
  const marketplaces = settings.extraKnownMarketplaces;
  if (enabled === undefined && marketplaces === undefined) return null;
  const plugins: PluginRef[] = [];
  if (enabled !== undefined) {
    if (!isObject(enabled)) return unresolved;
    for (const [name, value] of Object.entries(enabled)) {
      if (!name) return unresolved;
      if (typeof value === "boolean") plugins.push({ name, state: value ? "enabled" : "disabled" });
      else if (allowsLists && Array.isArray(value) && value.every((item) => typeof item === "string")) {
        plugins.push({ name, state: "configured" });
      } else return unresolved;
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

/** Whether a marketplace source is a path relative to the marketplace, not a URL, `host:path`, or absolute path. */
const isRelativePath = (source: string) => !/^[^/\\]*:/.test(source) && !/^[/\\~]/.test(source);

/** A marketplace file, by its name and how many plugins it lists. A source's URL is never kept. */
function marketplacePlugins(text: string, sourceRequired: boolean): PluginRefs {
  const marketplace = parsed(text);
  if (!isObject(marketplace) || !isName(marketplace.name) || !Array.isArray(marketplace.plugins)) return unresolved;
  const counted = { local: 0, external: 0 };
  for (const entry of marketplace.plugins as unknown[]) {
    if (!isObject(entry) || !isName(entry.name)) return unresolved;
    const source = entry.source;
    // Cursor documents only `name` as required, so an entry without a source still counts, as not a path.
    if (source === undefined && !sourceRequired) {
      counted.external += 1;
      continue;
    }
    // A path is a string, Codex's `{ source: "local", path }`, or Cursor's `{ path }`.
    const path = typeof source === "string" ? source : !isObject(source) ? undefined : source.path;
    if (
      typeof source === "string" ||
      (isObject(source) && (source.source === "local" || source.source === undefined))
    ) {
      if (!isName(path)) return unresolved;
      counted[isRelativePath(path) ? "local" : "external"] += 1;
    } else if (isObject(source) && isName(source.source)) counted.external += 1;
    else return unresolved;
  }
  return listed([{ name: marketplace.name, state: "catalog", listed: counted }]);
}

/** Whether a TOML key Strata could not split starts with `plugins`. */
const namesPlugins = (key: string) =>
  /^\s*(?:plugins|"plugins"|'plugins')\s*(?:\.|$)/.test(
    key.replace(/\\u([0-9a-fA-F]{4})|\\U([0-9a-fA-F]{8})/g, (match, short?: string, long?: string) => {
      const code = Number.parseInt(short ?? long ?? "", 16);
      return code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }),
  );

/**
 * The `[plugins."<plugin>@<marketplace>"]` tables of a Codex `config.toml`, or null when it has none.
 * Strata reads only this subset of TOML; a plugin without a literal `enabled`, an inline table, or
 * anything else it cannot follow makes the list unresolved.
 */
function codexPlugins(text: string): PluginRefs | null {
  if (!text.includes("plugins") && !/\\[uU]/.test(text)) return null;
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
      if (!header) return unresolved;
      const parts = keyParts(header[1]!);
      if (!parts) {
        // A key Strata cannot read, such as one with a Unicode escape, matters only under `plugins`.
        if (namesPlugins(header[1]!)) return unresolved;
        table = [""];
        continue;
      }
      if (parts[0] === "plugins") {
        if (line.startsWith("[[")) return unresolved;
        mentioned = true;
        if (parts[1] === "") return unresolved;
        if (parts[1] !== undefined) entry(parts[1]);
      }
      table = parts;
      continue;
    }
    const equals = assignmentAt(line);
    if (equals < 0) return unresolved;
    const key = keyParts(line.slice(0, equals));
    if (!key) {
      if (table[0] === "plugins" || namesPlugins(line.slice(0, equals))) return unresolved;
      continue;
    }
    const path = [...table, ...key];
    if (path[0] !== "plugins") continue;
    mentioned = true;
    if (path.length < 3 || path[1] === "") return unresolved;
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
  if (format === "settings" || format === "copilot-settings") return settingsPlugins(text, format === "settings");
  if (format === "codex-config") return codexPlugins(text);
  if (format === "agent-manifest") {
    const manifest = parsed(text);
    if (isAgentManifest(manifest)) return listed([{ name: manifest.name, state: "defined" }]);
    return declaresAgentSchema(manifest, Buffer.from(text)) ? unresolved : null;
  }
  if (format === "marketplace" || format === "cursor-marketplace") {
    return marketplacePlugins(text, format === "marketplace");
  }
  return manifestPlugin(text, format);
}

const isSettingsFormat = (format: PluginFormat) =>
  format === "settings" || format === "copilot-settings" || format === "codex-config";

/** Whether a file is a plugin manifest or marketplace, which a partial clone does not read. */
export const isPluginPackageFile = (file: TrackedFile) => {
  const format = pluginFormat(file.path, file.classification);
  return format !== null && !isSettingsFormat(format);
};

/**
 * The plugins every distinct version of a settings, manifest, or marketplace file names, keyed by
 * path and blob, found as the shared content pass reads them. Only names and states are kept. A
 * file that is not valid UTF-8 is unresolved, except a `plugin.json` in an agent folder that does
 * not declare the Agent Plugins schema, which names no plugin.
 */
export class PluginLists implements ContentUse {
  readonly lists = new Map<string, PluginRefs>();

  /** With `settingsOnly`, for a partial clone, reads only the settings that name plugins. */
  constructor(private readonly settingsOnly = false) {}

  wants(file: TrackedFile): boolean {
    const format = pluginFormat(file.path, file.classification);
    return format !== null && (!this.settingsOnly || isSettingsFormat(format));
  }

  read(_blob: string, body: Buffer, files: TrackedFile[]): void {
    const text = utf8Text(body);
    for (const file of files) {
      const format = pluginFormat(file.path, file.classification)!;
      const plugins =
        text !== null
          ? pluginRefs(text, format)
          : format !== "agent-manifest" || declaresAgentSchema(undefined, body)
            ? unresolved
            : null;
      if (plugins) this.lists.set(versionKey(file.path, file.blob), plugins);
    }
  }
}

/**
 * The version keys of the candidates whose content shows they are plugin packages: a `plugin.json`
 * that declares the Agent Plugins `$schema`, which Copilot, Codex, and Cursor share, or a root
 * `marketplace.json` with a `plugins` key beside `name` or `owner`, including a version whose fields
 * are wrong or that no longer parses but still reads like one. Another `plugin.json`, including Copilot's legacy form, cannot be
 * told apart from any other project's file.
 */
export function confirmedPackages(repo: string, files: TrackedFile[], env?: NodeJS.ProcessEnv): Set<string> {
  const confirmed = new Set<string>();
  if (!files.length) return confirmed;
  const blobs = [...new Set(files.map((file) => file.blob))];
  const sizes = blobSizes(repo, blobs, env);
  const manifests = new Set<string>();
  const catalogs = new Set<string>();
  for (const [blob, body] of readBlobs(repo, blobs, (id) => sizes.get(id) ?? 0, env)) {
    const text = utf8Text(body);
    const value = text === null ? undefined : parsed(text);
    // A version that breaks a field or no longer parses stays a package, whose plugins are unresolved.
    if (declaresAgentSchema(value, body)) manifests.add(blob);
    const keys =
      value === undefined
        ? ["name", "owner", "plugins"].filter((key) =>
            body.toString("latin1").replaceAll("\0", "").includes(`"${key}"`),
          )
        : isObject(value)
          ? Object.keys(value)
          : [];
    if (keys.includes("plugins") && (keys.includes("name") || keys.includes("owner"))) catalogs.add(blob);
  }
  for (const file of files) {
    if ((file.path === "marketplace.json" ? catalogs : manifests).has(file.blob)) {
      confirmed.add(versionKey(file.path, file.blob));
    }
  }
  return confirmed;
}

/** What Strata says when a partial clone may hold plugin packages it does not read. */
export const packagesLeftOutNotice =
  "This is a partial clone, which may lack the history of plugin manifests and marketplace files, so Strata does not read them and its plugin results may be incomplete. A full clone includes them.";
