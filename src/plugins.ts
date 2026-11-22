import type { Classification } from "./adapters.js";
import { type ContentPass, type ContentUse, utf8Text } from "./content-pass.js";
import { stripComments } from "./gemini-settings.js";
import { blobSizes, readBlobs } from "./git.js";
import { type TrackedFile, versionKey } from "./inventory.js";
import { assignmentAt, keyParts, stripTrailingCommas, tomlLines } from "./mcp-servers.js";
import type { PluginRef, PluginRefs } from "./model.js";

/**
 * How a file names plugins: `settings`, `copilot-settings`, and `codex-config` turn them on or off, `manifest` defines
 * one, `skills-folder` defines one in the root `.claude/skills`, which Claude Code loads without a
 * settings entry, and `marketplace` is a catalog of them. `agent-manifest` is a `plugin.json` at a
 * plugin's root or inside an agent's folder, where a marketplace can place one: it defines a plugin
 * only if it declares the Agent Plugins schema, whose name rule then applies. `codex-manifest` is an overlay beside a root manifest, which
 * `compareRevisions` and the report leave to that manifest.
 */
type PluginFormat =
  | "settings"
  | "copilot-settings"
  | "codex-config"
  | "manifest"
  | "codex-manifest"
  | "agent-manifest"
  | "skills-folder"
  | "marketplace"
  | "cursor-marketplace"
  | "codex-marketplace";

/** The plugin format of a recognized file, or null when the file cannot name a plugin. */
export function pluginFormat(path: string, classification: Classification): PluginFormat | null {
  // A file tracked only because a Claude import reaches it is not read as a plugin file.
  if (classification.imported) return null;
  const parts = path.split("/");
  const name = parts.at(-1) ?? "";
  // Inside a skill, only a manifest directly in a root `.claude/skills/<name>` is a plugin. Any other
  // is one of the skill's files, such as a template it scaffolds from.
  if (classification.skillRole) {
    return classification.provider === "claude" && /^\.claude\/skills\/[^/]+\/\.claude-plugin\/plugin\.json$/.test(path)
      ? "skills-folder"
      : null;
  }
  if (classification.pluginPackage) {
    if (name !== "marketplace.json") {
      if (classification.provider === "shared") return "agent-manifest";
      return classification.provider === "codex" ? "codex-manifest" : "manifest";
    }
    if (classification.provider === "cursor") return "cursor-marketplace";
    return classification.provider === "codex" ? "codex-marketplace" : "marketplace";
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

/** A plugin name is short. A longer value is file text, which a default report must not carry. */
const maxNameLength = 256;

const isName = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maxNameLength;

/** Strict JSON, as Claude Code reads these files, or JSON with comments; undefined when it does not parse. */
function parsed(text: string, comments = false): unknown {
  const source = text.replace(/^\uFEFF/, "");
  try {
    return JSON.parse(comments ? stripTrailingCommas(stripComments(source)) : source);
  } catch {
    return undefined;
  }
}

const agentPluginSchema = /^https:\/\/agent-plugins\.org\/schemas\/\d+\.\d+\.\d+\/plugin\.schema\.json$/;

/** A file's text for searching when it does not parse: any encoding, with JSON's escapes undone. */
const rawText = (body: Buffer) =>
  body
    .toString("latin1")
    .replaceAll("\0", "")
    .replaceAll("\\/", "/")
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, code: string) => String.fromCharCode(Number.parseInt(code, 16)));

/** Whether a file declares the Agent Plugins schema. One that no longer parses is searched as raw text. */
const declaresAgentSchema = (value: unknown, body: Buffer) =>
  value === undefined
    ? /https:\/\/agent-plugins\.org\/schemas\/\d+\.\d+\.\d+\/plugin\.schema\.json/.test(rawText(body))
    : isObject(value) && typeof value.$schema === "string" && agentPluginSchema.test(value.$schema);

/** The name the Agent Plugins schema allows; clients must refuse a manifest with any other. */
const isAgentPluginName = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 64 && /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value);

const listed = (plugins: PluginRef[]): PluginRefs => ({ status: "listed", plugins });
const unresolved: PluginRefs = { status: "unresolved" };

/**
 * A settings file's `enabledPlugins` and `extraKnownMarketplaces`, or null when it has neither.
 * Claude's settings schema also allows a list of strings as a value; Copilot documents only booleans.
 */
function settingsPlugins(text: string, allowsLists: boolean): PluginRefs | null {
  // A key can also be written with JSON escapes, so only a file with neither is skipped unparsed.
  const mentioned = /enabledPlugins|extraKnownMarketplaces|additionalMarketplaces/.test(text);
  if (!mentioned && !text.includes("\\u")) return null;
  // Copilot documents its settings as JSON with comments.
  const settings = parsed(text, !allowsLists);
  // An escape can hide the key in a file that does not parse, so its plugins are unknown.
  if (settings === undefined) return unresolved;
  if (!isObject(settings)) return mentioned ? unresolved : null;
  const enabled = settings.enabledPlugins;
  // Claude Code reads `additionalMarketplaces` as an alias, and the canonical key wins when both are set.
  const marketplaces = settings.extraKnownMarketplaces ?? (allowsLists ? settings.additionalMarketplaces : undefined);
  if (enabled === undefined && marketplaces === undefined) return null;
  const plugins: PluginRef[] = [];
  if (enabled !== undefined) {
    if (!isObject(enabled)) return unresolved;
    for (const [name, value] of Object.entries(enabled)) {
      if (!isName(name)) return unresolved;
      if (typeof value === "boolean") plugins.push({ name, state: value ? "enabled" : "disabled" });
      else if (allowsLists && Array.isArray(value) && value.every((item) => typeof item === "string")) {
        plugins.push({ name, state: "configured" });
      } else return unresolved;
    }
  }
  if (marketplaces !== undefined) {
    if (!isObject(marketplaces)) return unresolved;
    for (const [name, value] of Object.entries(marketplaces)) {
      if (!isName(name) || !isObject(value) || !isObject(value.source)) return unresolved;
      plugins.push({ name, state: "marketplace" });
    }
  }
  return listed(plugins);
}

/** The plugin a manifest defines. In `.claude/skills` its ID is `<name>@skills-dir`, as settings name it. */
function manifestPlugin(text: string, format: "manifest" | "codex-manifest" | "skills-folder"): PluginRefs {
  const manifest = parsed(text);
  if (!isObject(manifest) || !isName(manifest.name)) return unresolved;
  if (format !== "skills-folder") return listed([{ name: manifest.name, state: "defined" }]);
  const name = `${manifest.name}@skills-dir`;
  return listed([{ name, state: manifest.defaultEnabled === false ? "defined" : "skills-folder" }]);
}

/** Whether a marketplace source is a relative path, whose base depends on the tool, not a URL, a known Git host, or an absolute path. */
const isRelativePath = (source: string) =>
  !/^[^/\\]*:/.test(source) &&
  !/^[/\\~]/.test(source) &&
  !/^(?:www\.)?(?:github\.com|gitlab\.com|bitbucket\.org)\//i.test(source);

/** Whether a marketplace entry's source is a relative path or something else, or null when the entry is invalid. */
function entrySource(entry: unknown, format: string): "local" | "external" | null {
  if (!isObject(entry) || !isName(entry.name)) return null;
  const source = entry.source;
  // Cursor documents only `name` as required, so an entry without a source still counts, as not a path.
  if (source === undefined) return format === "cursor-marketplace" ? "external" : null;
  // A path is a string, Codex's `{ source: "local", path }`, or Cursor's `{ path }`.
  if (
    typeof source === "string" ||
    (isObject(source) &&
      (source.source === "local" || (source.source === undefined && format === "cursor-marketplace")))
  ) {
    const path = typeof source === "string" ? source : source.path;
    // A source is never stored, so it has no length limit.
    if (typeof path !== "string" || !path) return null;
    return isRelativePath(path) ? "local" : "external";
  }
  return isObject(source) && isName(source.source) ? "external" : null;
}

/** A marketplace file, by its name and how many plugins it lists. A source's URL is never kept. */
function marketplacePlugins(
  text: string,
  format: "marketplace" | "cursor-marketplace" | "codex-marketplace",
): PluginRefs {
  const marketplace = parsed(text);
  if (!isObject(marketplace) || !isName(marketplace.name) || !Array.isArray(marketplace.plugins)) return unresolved;
  const counted = { local: 0, external: 0 };
  for (const entry of marketplace.plugins as unknown[]) {
    const kind = entrySource(entry, format);
    if (kind) counted[kind] += 1;
    // Codex documents skipping an entry it cannot resolve and keeping the rest of the marketplace.
    else if (format !== "codex-marketplace") return unresolved;
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
 * A plugin with settings but no `enabled` of its own, such as MCP policy tables, is `configured`.
 * Strata reads only this subset of TOML; an inline table or anything else it cannot follow makes the
 * list unresolved.
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
        if (parts[1] !== undefined && !isName(parts[1])) return unresolved;
        if (parts[1] !== undefined) entry(parts[1]);
      }
      table = parts;
      continue;
    }
    const equals = assignmentAt(line);
    if (equals < 0) return unresolved;
    const key = keyParts(line.slice(0, equals));
    if (!key) {
      if (table[0] === "plugins" || (!table.length && namesPlugins(line.slice(0, equals)))) return unresolved;
      continue;
    }
    const path = [...table, ...key];
    if (path[0] !== "plugins") continue;
    mentioned = true;
    if (path.length < 3 || !isName(path[1])) return unresolved;
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
    plugins.push({ name, state: enabled === null ? "configured" : enabled ? "enabled" : "disabled" });
  }
  return listed(plugins);
}

/** The plugins one version of a file names, or null when a settings file names none. */
export function pluginRefs(text: string, format: PluginFormat): PluginRefs | null {
  if (format === "settings" || format === "copilot-settings") return settingsPlugins(text, format === "settings");
  if (format === "codex-config") return codexPlugins(text);
  if (format === "agent-manifest") {
    const manifest = parsed(text);
    if (!declaresAgentSchema(manifest, Buffer.from(text))) return null;
    return isObject(manifest) && isAgentPluginName(manifest.name)
      ? listed([{ name: manifest.name, state: "defined" }])
      : unresolved;
  }
  if (format === "marketplace" || format === "cursor-marketplace" || format === "codex-marketplace") {
    return marketplacePlugins(text, format);
  }
  return manifestPlugin(text, format);
}

/** Plugin files are small. A common file name can belong to something huge, which is not loaded to check it. */
const maxPluginFileBytes = 64 * 1024 * 1024;

const isSettingsFormat = (format: PluginFormat) =>
  format === "settings" || format === "copilot-settings" || format === "codex-config";

/** Whether a file is a plugin manifest or marketplace, which a partial clone does not read. */
export const isPluginPackageFile = (file: TrackedFile) => {
  const format = pluginFormat(file.path, file.classification);
  return format !== null && !isSettingsFormat(format);
};

/** A file that cannot be decoded is unresolved only if its bytes show it may name a plugin. */
function undecodedRefs(body: Buffer, format: PluginFormat): PluginRefs | null {
  if (format === "agent-manifest") return declaresAgentSchema(undefined, body) ? unresolved : null;
  if (!isSettingsFormat(format)) return unresolved;
  const raw = rawText(body);
  const keys = format === "codex-config" ? /plugins/ : /enabledPlugins|extraKnownMarketplaces|additionalMarketplaces/;
  return keys.test(raw) ? unresolved : null;
}

/** A file too deep or long for a parser is unresolved rather than stopping the analysis. */
function safeRefs(text: string, format: PluginFormat): PluginRefs | null {
  try {
    return pluginRefs(text, format);
  } catch {
    return unresolved;
  }
}

/**
 * The plugins every distinct version of a settings, manifest, or marketplace file names, keyed by
 * path and blob, found as the shared content pass reads them. Only names and states are kept. A
 * file that is not valid UTF-8 is unresolved, except a `plugin.json` in an agent folder that does
 * not declare the Agent Plugins schema, which names no plugin.
 */
export class PluginLists implements ContentUse {
  readonly lists = new Map<string, PluginRefs>();
  readonly maxBytes = maxPluginFileBytes;

  /** With `settingsOnly`, for a partial clone, reads only the settings that name plugins. */
  constructor(private readonly settingsOnly = false) {}

  wants(file: TrackedFile): boolean {
    const format = pluginFormat(file.path, file.classification);
    return format !== null && (!this.settingsOnly || isSettingsFormat(format));
  }

  /** A file too large to read may still name plugins, unless it is only a `plugin.json` in an agent folder. */
  tooLarge(files: TrackedFile[]): void {
    for (const file of files) {
      if (pluginFormat(file.path, file.classification) === "agent-manifest") continue;
      this.lists.set(versionKey(file.path, file.blob), unresolved);
    }
  }

  read(_blob: string, body: Buffer, files: TrackedFile[]): void {
    const text = utf8Text(body);
    for (const file of files) {
      const format = pluginFormat(file.path, file.classification)!;
      const plugins = text === null ? undecodedRefs(body, format) : safeRefs(text, format);
      if (plugins) this.lists.set(versionKey(file.path, file.blob), plugins);
    }
  }
}

/**
 * Whether a root `marketplace.json` is a plugin marketplace, even with a damaged field: `plugins`
 * beside `owner`, or a non-empty list of objects beside `name`. A file that no longer parses needs those keys.
 */
function readsLikeCatalog(value: unknown, body: Buffer): boolean {
  if (value === undefined) {
    const raw = rawText(body);
    if (!raw.includes('"plugins"')) return false;
    return raw.includes('"owner"') || (raw.includes('"name"') && /"plugins"\s*:\s*\[\s*\{/.test(raw));
  }
  if (!isObject(value) || !("plugins" in value)) return false;
  if ("owner" in value) return true;
  return "name" in value && Array.isArray(value.plugins) && value.plugins.length > 0 && value.plugins.every(isObject);
}

/**
 * The version keys of the candidates whose content shows they are plugin packages: a `plugin.json`
 * that declares the Agent Plugins `$schema`, which Copilot, Codex, and Cursor share, or a root
 * `marketplace.json` that `readsLikeCatalog`, including a version whose fields are wrong or that no
 * longer parses but still reads like one. Another `plugin.json`, including Copilot's legacy form, cannot be
 * told apart from any other project's file.
 */
export function confirmedPackages(
  repo: string,
  files: TrackedFile[],
  env?: NodeJS.ProcessEnv,
  pass?: ContentPass,
): Set<string> {
  const confirmed = new Set<string>();
  if (!files.length) return confirmed;
  const sizes = blobSizes(repo, [...new Set(files.map((file) => file.blob))], env);
  const readable = files.filter((file) => sizes.get(file.blob)! <= maxPluginFileBytes);
  const blobs = [...new Set(readable.map((file) => file.blob))];
  pass?.add(readable);
  const manifests = new Set<string>();
  const catalogs = new Set<string>();
  for (const [blob, body] of readBlobs(repo, blobs, (id) => sizes.get(id) ?? 0, env)) {
    const text = utf8Text(body);
    const value = text === null ? undefined : parsed(text);
    // A version that breaks a field or no longer parses stays a package, whose plugins are unresolved.
    if (declaresAgentSchema(value, body)) manifests.add(blob);
    if (readsLikeCatalog(value, body)) catalogs.add(blob);
    pass?.offer(blob, body);
  }
  for (const file of readable) {
    if ((file.path === "marketplace.json" ? catalogs : manifests).has(file.blob)) {
      confirmed.add(versionKey(file.path, file.blob));
    }
  }
  return confirmed;
}

/** What Strata says when a partial clone may hold plugin packages it does not read. */
export const packagesLeftOutNotice =
  "This is a partial clone, which may lack the history of plugin manifests and marketplace files, so Strata does not read them and its plugin results may be incomplete. A full clone includes them.";
