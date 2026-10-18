import type { Classification } from "./adapters.js";
import { geminiSettingsPath, stripComments } from "./gemini-settings.js";
import { readBlobs } from "./git.js";
import { type BlobMeasurement, type TrackedFile, versionKey } from "./inventory.js";
import type { McpServer, McpServers } from "./model.js";

/**
 * How a file defines MCP servers. `key` is the object holding servers by name; `bare` also accepts
 * servers at the top level when `key` is absent, as Copilot CLI does. `syntax` follows what the
 * tool's own parser accepts, so Strata does not list servers from a file the tool would reject:
 * `json` is strict, `comments` allows comments, and `jsonc` also allows trailing commas.
 * `optional` marks a settings file, which has the field only when it mentions MCP servers.
 * Only syntax is checked: a server whose values its tool would reject is still listed.
 */
type McpFormat =
  | {
      kind: "json";
      key: "mcpServers" | "servers";
      bare?: true;
      syntax: "json" | "comments" | "jsonc";
      optional?: true;
      /** Gemini CLI settings, whose `mcp.allowed` and `mcp.excluded` lists turn servers off. */
      gemini?: true;
    }
  | { kind: "toml" };

const filename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** The MCP format of a recognized file, or null when the file cannot define MCP servers. */
export function mcpFormat(path: string, classification: Classification): McpFormat | null {
  const name = filename(path);
  if (classification.category === "tools") {
    if (path === ".vscode/mcp.json") return { kind: "json", key: "servers", syntax: "jsonc" };
    if (classification.provider === "cursor") return { kind: "json", key: "mcpServers", syntax: "jsonc" };
    if (classification.provider === "copilot") return { kind: "json", key: "mcpServers", bare: true, syntax: "json" };
    if (name === ".mcp.json") return { kind: "json", key: "mcpServers", syntax: "json" };
    return null;
  }
  if (classification.category !== "settings") return null;
  // Gemini CLI reads workspace settings at the repository root only, as `geminiSettingsPath` does.
  if (classification.provider === "gemini" && path === geminiSettingsPath) {
    return { kind: "json", key: "mcpServers", syntax: "comments", optional: true, gemini: true };
  }
  if (classification.provider === "codex" && name === "config.toml") return { kind: "toml" };
  return null;
}

/** Remove commas before a closing bracket or brace, outside strings, as JSONC parsers accept. */
function stripTrailingCommas(text: string): string {
  let output = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === '"') {
      const start = index;
      for (index += 1; index < text.length && text[index] !== '"'; index += 1) if (text[index] === "\\") index += 1;
      output += text.slice(start, index + 1);
    } else if (char === ",") {
      let next = index + 1;
      while (/\s/.test(text[next] ?? "")) next += 1;
      if (text[next] !== "}" && text[next] !== "]") output += char;
    } else {
      output += char;
    }
  }
  return output;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * Where a server runs, from the keys every tool documents: `local` starts a process on the
 * developer's machine (`command`, or a `type` of `stdio` or `local`); `remote` connects to a URL
 * (`url` or `httpUrl`, or a `type` of `http`, `streamable-http`, `sse`, or `ws`). Without a `type`,
 * an entry with both a command and a URL is `unknown`: tools disagree on which one wins.
 */
function transport(entry: unknown): McpServer["transport"] {
  if (!isObject(entry)) return "unknown";
  const type = typeof entry.type === "string" ? entry.type.toLowerCase() : null;
  if (type === "stdio" || type === "local") return "local";
  if (type && ["http", "streamable-http", "streamablehttp", "sse", "ws"].includes(type)) return "remote";
  if (type) return "unknown";
  const local = typeof entry.command === "string";
  const remote = typeof entry.url === "string" || typeof entry.httpUrl === "string";
  return local === remote ? "unknown" : local ? "local" : "remote";
}

function jsonServers(text: string, format: Extract<McpFormat, { kind: "json" }>): McpServers | null {
  const source = text.replace(/^\uFEFF/, "");
  if (format.optional && !source.includes(format.key)) return null;
  let parsed: unknown;
  try {
    const uncommented = format.syntax === "json" ? source : stripComments(source);
    parsed = JSON.parse(format.syntax === "jsonc" ? stripTrailingCommas(uncommented) : uncommented);
  } catch {
    return { status: "unresolved" };
  }
  if (!isObject(parsed)) return { status: "unresolved" };
  if (!(format.key in parsed)) {
    if (format.optional) return null;
    if (!format.bare) return { status: "listed", servers: [] };
    // Copilot CLI also reads servers at the top level. Only entries shaped like a server count, so a
    // file in another tool's format (VS Code's `servers`) is not read as one server of that name.
    return {
      status: "listed",
      servers: Object.entries(parsed).flatMap(([name, entry]) =>
        isObject(entry) && ["command", "url", "type"].some((key) => typeof entry[key] === "string")
          ? [{ name, transport: transport(entry) }]
          : [],
      ),
    };
  }
  const servers = parsed[format.key];
  if (!isObject(servers)) return { status: "unresolved" };
  const off = format.gemini ? geminiDisabled(parsed) : () => false;
  return {
    status: "listed",
    servers: Object.entries(servers).map(([name, entry]) => ({
      name,
      transport: transport(entry),
      ...(off(name) ? { disabled: true as const } : {}),
    })),
  };
}

/**
 * Which servers Gemini CLI settings turn off: those `mcp.excluded` names, and, when `mcp.allowed`
 * is set, those it does not name. `excludeMCPServers` and `allowMCPServers` are the same lists
 * before the settings format changed.
 */
function geminiDisabled(settings: Record<string, unknown>): (name: string) => boolean {
  const mcp = isObject(settings.mcp) ? settings.mcp : {};
  const list = (value: unknown) => (Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : null);
  const excluded = list("excluded" in mcp ? mcp.excluded : settings.excludeMCPServers) ?? [];
  const allowed = list("allowed" in mcp ? mcp.allowed : settings.allowMCPServers);
  return (name) => excluded.includes(name) || (allowed !== null && !allowed.includes(name));
}

/**
 * Split a TOML key such as `mcp_servers."my server".env` into its parts, or null when it is not a
 * key Strata reads: bare parts, basic strings with simple escapes, and literal strings.
 */
function keyParts(key: string): string[] | null {
  const parts: string[] = [];
  let rest = key.trim();
  while (rest) {
    const bare = rest.match(/^[A-Za-z0-9_-]+/);
    const basic = bare ? null : rest.match(/^"((?:[^"\\]|\\["\\])*)"/);
    const literal = bare || basic ? null : rest.match(/^'([^']*)'/);
    const part = bare ?? basic ?? literal;
    if (!part) return null;
    parts.push(bare ? part[0] : basic ? part[1]!.replace(/\\(["\\])/g, "$1") : part[1]!);
    rest = rest.slice(part[0].length).trim();
    if (!rest) break;
    if (rest[0] !== ".") return null;
    rest = rest.slice(1).trim();
  }
  return parts.length ? parts : null;
}

/** The index of the `=` that ends a TOML key, outside quoted key parts, or -1. */
function assignmentAt(line: string): number {
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (char === "=") return index;
    if (char === '"' || char === "'") {
      for (index += 1; index < line.length && line[index] !== char; index += 1) {
        if (char === '"' && line[index] === "\\") index += 1;
      }
    }
  }
  return -1;
}

/**
 * Split TOML into logical lines: a value that spans lines, such as a multi-line array, inline
 * table, or triple-quoted string, joins the line that starts it. Comments are dropped. Returns null
 * when a string or bracket is never closed.
 */
function tomlLines(text: string): string[] | null {
  const lines: string[] = [];
  let line = "";
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    const triple = text.startsWith('"""', index) ? '"""' : text.startsWith("'''", index) ? "'''" : null;
    if (triple) {
      const end = text.indexOf(triple, index + 3);
      if (end < 0) return null;
      line += '""';
      index = end + 2;
      while (text[index + 1] === triple[0]) index += 1;
    } else if (char === '"' || char === "'") {
      let end = index + 1;
      while (end < text.length && text[end] !== char && text[end] !== "\n")
        end += char === '"' && text[end] === "\\" ? 2 : 1;
      if (text[end] !== char) return null;
      line += text.slice(index, end + 1);
      index = end;
    } else if (char === "#") {
      while (index + 1 < text.length && text[index + 1] !== "\n") index += 1;
    } else if (char === "\n" && depth === 0) {
      lines.push(line);
      line = "";
    } else {
      if (char === "[" || char === "{") depth += 1;
      if (char === "]" || char === "}") depth -= 1;
      if (depth < 0) return null;
      line += char === "\n" ? " " : char;
    }
  }
  if (depth !== 0) return null;
  lines.push(line);
  return lines;
}

/**
 * The servers a Codex `config.toml` defines in `[mcp_servers.<name>]` tables, or null when it does
 * not mention `mcp_servers`. `command` makes a server local and `url` remote; `enabled = false`
 * marks it disabled. Strata reads only this subset of TOML; inline `mcp_servers` tables and
 * anything it cannot follow make the list unresolved.
 */
export function codexServers(text: string): McpServers | null {
  if (!text.includes("mcp_servers")) return null;
  const lines = tomlLines(text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n"));
  if (!lines) return { status: "unresolved" };
  const servers = new Map<string, McpServer>();
  const server = (name: string) => {
    const entry = servers.get(name) ?? { name, transport: "unknown" };
    servers.set(name, entry);
    return entry;
  };
  let table: string[] = [];
  // `mcp_servers` can appear only in a comment or a string; such a file defines no servers.
  let mentioned = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("[")) {
      const header = line.match(/^\[\[(.*)\]\]$/) ?? line.match(/^\[(.*)\]$/);
      const parts = header ? keyParts(header[1]!) : null;
      if (!parts) return { status: "unresolved" };
      // An array of tables cannot name a server, so Strata does not follow one under `mcp_servers`.
      if (line.startsWith("[[") && parts[0] === "mcp_servers") return { status: "unresolved" };
      table = parts;
      if (parts[0] === "mcp_servers") mentioned = true;
      if (parts[0] === "mcp_servers" && parts[1] !== undefined) server(parts[1]);
      continue;
    }
    const equals = assignmentAt(line);
    const key = equals < 0 ? null : keyParts(line.slice(0, equals));
    if (!key) return { status: "unresolved" };
    const value = line.slice(equals + 1).trim();
    const path = [...table, ...key];
    if (path[0] !== "mcp_servers") continue;
    mentioned = true;
    // An inline table or dotted key that holds whole servers is outside what Strata reads.
    if (path.length < 3) return { status: "unresolved" };
    if (path.length > 3) {
      server(path[1]!);
      continue;
    }
    const entry = server(path[1]!);
    if (path[2] === "command" && entry.transport === "unknown") entry.transport = "local";
    if (path[2] === "url" && entry.transport === "unknown") entry.transport = "remote";
    if (path[2] === "enabled" && value === "false") entry.disabled = true;
  }
  return mentioned ? { status: "listed", servers: [...servers.values()] } : null;
}

/** The servers one version of a file defines, or null when it defines none in a format Strata reads. */
export function mcpServers(text: string, format: McpFormat): McpServers | null {
  return format.kind === "toml" ? codexServers(text) : jsonServers(text, format);
}

/**
 * The MCP servers every distinct version of an MCP or settings file defines, keyed by path and
 * blob. Only names, where each server runs, and whether it is disabled are kept; commands, URLs,
 * arguments, environment values, and headers are never read into the report. A file that is not
 * valid UTF-8 is unresolved.
 */
export function mcpServerLists(
  root: string,
  files: Iterable<TrackedFile>,
  measured: Map<string, BlobMeasurement>,
): Map<string, McpServers> {
  const wanted = new Map<string, { file: TrackedFile; format: McpFormat }>();
  for (const file of files) {
    const format = mcpFormat(file.path, file.classification);
    if (format) wanted.set(versionKey(file.path, file.blob), { file, format });
  }
  const blobs = [...new Set([...wanted.values()].map(({ file }) => file.blob))];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const texts = new Map<string, string | null>();
  for (const [blob, body] of readBlobs(root, blobs, (id) => measured.get(id)?.bytes ?? 0)) {
    try {
      texts.set(blob, decoder.decode(body));
    } catch {
      texts.set(blob, null);
    }
  }
  const lists = new Map<string, McpServers>();
  for (const [key, { file, format }] of wanted) {
    const text = texts.get(file.blob);
    const servers: McpServers | null = text == null ? { status: "unresolved" } : mcpServers(text, format);
    if (servers) lists.set(key, servers);
  }
  return lists;
}
