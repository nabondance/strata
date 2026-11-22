import type { Component, PluginCatalog, PluginState, RevisionSnapshot } from "./model.js";
import type { SkillListing } from "./skill-listing.js";

/** The part of a revision a comparison reads. */
export type ComparedRevision = Pick<RevisionSnapshot, "components" | "estimatedTokens">;

export interface ComparisonDelta {
  key: string;
  beforeFiles: number;
  afterFiles: number;
  deltaFiles: number;
  beforeTokens: number;
  afterTokens: number;
  deltaTokens: number;
}

export interface ComponentDelta {
  path: string;
  provider: Component["provider"];
  category: Component["category"];
  /** Set when the file is a superseded format its provider still reads, such as `.cursorrules` or a Copilot `.chatmode.md`. */
  legacy?: true;
  /** Set when the file is in the inventory only because a Claude `@path` import reaches it. */
  imported?: true;
  kind: "added" | "removed" | "edited";
  beforeTokens: number | null;
  afterTokens: number | null;
  deltaFiles: number;
  deltaTokens: number;
  /** On a skill manifest: its listing at each side, null where the manifest is absent. */
  listing?: { before: SkillListing | null; after: SkillListing | null; deltaTokens: number };
}

/**
 * Listed skill tokens at each side, measured separately from the stored-text totals and never added
 * to them. `beforeManifests` and `afterManifests` count the skill manifests present, and
 * `beforeUnresolved` and `afterUnresolved` those whose listing is unresolved and left out of the tokens.
 */
export interface ListingComparison {
  beforeTokens: number;
  afterTokens: number;
  deltaTokens: number;
  beforeManifests: number;
  afterManifests: number;
  beforeUnresolved: number;
  afterUnresolved: number;
}

/** An MCP server one side's files define, by name and the file that defines it. */
export interface McpServerRef {
  name: string;
  path: string;
  provider: Component["provider"];
}

/**
 * The MCP servers the tracked files define at each side. A server is identified by its file and
 * name, so moving it to another file is a removal and an addition. `beforeUnresolved` and
 * `afterUnresolved` count files whose servers could not be read; their servers are not counted.
 */
export interface McpComparison {
  beforeServers: number;
  afterServers: number;
  deltaServers: number;
  beforeUnresolved: number;
  afterUnresolved: number;
  added: McpServerRef[];
  removed: McpServerRef[];
}

/** A plugin one side's files name, by name, the file that names it, and what that file says. */
export interface PluginComparisonRef {
  name: string;
  path: string;
  provider: Component["provider"];
  state: PluginState;
  listed?: PluginCatalog;
}

/** A plugin the same file names at both sides with a different state, or a marketplace whose counts moved. */
export interface PluginStateChange {
  name: string;
  path: string;
  provider: Component["provider"];
  before: PluginState;
  after: PluginState;
  /** On a marketplace file: what it lists at each side. */
  beforeListed?: PluginCatalog;
  afterListed?: PluginCatalog;
}

/**
 * The plugin references tracked files hold at each side. A reference is a file and a name, so the
 * same plugin defined in one file and enabled in another is two. `beforeUnresolved` and
 * `afterUnresolved` count files whose plugins could not be read. A file unreadable at either side
 * is left out of the counts and lists at both, since it may still name the plugins it named.
 */
export interface PluginComparison {
  beforePlugins: number;
  afterPlugins: number;
  deltaPlugins: number;
  beforeUnresolved: number;
  afterUnresolved: number;
  added: PluginComparisonRef[];
  removed: PluginComparisonRef[];
  changed: PluginStateChange[];
}

export interface Comparison {
  beforeTokens: number;
  afterTokens: number;
  deltaTokens: number;
  percentChange: number | null;
  beforeFiles: number;
  afterFiles: number;
  deltaFiles: number;
  byProvider: ComparisonDelta[];
  byCategory: ComparisonDelta[];
  skillListing: ListingComparison;
  /** Present when either side has a component with `mcp`: an MCP file, or settings that mention MCP servers. */
  mcp?: McpComparison;
  /** Present when either side names a plugin or has a file whose plugins could not be read. */
  plugins?: PluginComparison;
  components: ComponentDelta[];
}

// This function is also embedded in the standalone HTML report. Keep its runtime
// dependencies inside the function so the browser uses the same comparison logic.
export function compareRevisions(baseline: ComparedRevision, target: ComparedRevision): Comparison {
  const groups = (keyFor: (component: Component) => string): ComparisonDelta[] => {
    const totals = new Map<string, ComparisonDelta>();
    const add = (component: Component, side: "before" | "after") => {
      const key = keyFor(component);
      let total = totals.get(key);
      if (!total) {
        total = { key, beforeFiles: 0, afterFiles: 0, deltaFiles: 0, beforeTokens: 0, afterTokens: 0, deltaTokens: 0 };
        totals.set(key, total);
      }
      if (side === "before") {
        total.beforeFiles += 1;
        total.beforeTokens += component.estimatedTokens ?? 0;
      } else {
        total.afterFiles += 1;
        total.afterTokens += component.estimatedTokens ?? 0;
      }
    };
    for (const component of baseline.components) add(component, "before");
    for (const component of target.components) add(component, "after");
    return [...totals.values()]
      .map((total) => ({
        ...total,
        deltaFiles: total.afterFiles - total.beforeFiles,
        deltaTokens: total.afterTokens - total.beforeTokens,
      }))
      .sort((a, b) => a.key.localeCompare(b.key));
  };

  const identity = (component: Component) => `${component.provider}\0${component.category}\0${component.path}`;
  const before = new Map(baseline.components.map((component) => [identity(component), component]));
  const after = new Map(target.components.map((component) => [identity(component), component]));
  const components: ComponentDelta[] = [];
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const oldComponent = before.get(key);
    const newComponent = after.get(key);
    if (oldComponent?.blob === newComponent?.blob) continue;
    const component = newComponent ?? oldComponent!;
    const manifest = (entry: Component | undefined) => (entry?.skill?.role === "manifest" ? entry : undefined);
    const listed = manifest(oldComponent) || manifest(newComponent);
    components.push({
      path: component.path,
      provider: component.provider,
      category: component.category,
      ...(component.legacy ? { legacy: true as const } : {}),
      ...(component.imported ? { imported: true as const } : {}),
      kind: !oldComponent ? "added" : !newComponent ? "removed" : "edited",
      beforeTokens: oldComponent?.estimatedTokens ?? null,
      afterTokens: newComponent?.estimatedTokens ?? null,
      deltaFiles: Number(Boolean(newComponent)) - Number(Boolean(oldComponent)),
      deltaTokens: (newComponent?.estimatedTokens ?? 0) - (oldComponent?.estimatedTokens ?? 0),
      ...(listed
        ? {
            listing: {
              before: manifest(oldComponent)?.skill?.listing ?? null,
              after: manifest(newComponent)?.skill?.listing ?? null,
              deltaTokens:
                (manifest(newComponent)?.skill?.listing?.tokens ?? 0) -
                (manifest(oldComponent)?.skill?.listing?.tokens ?? 0),
            },
          }
        : {}),
    });
  }
  components.sort((a, b) => Math.abs(b.deltaTokens) - Math.abs(a.deltaTokens) || a.path.localeCompare(b.path));

  const listing = (revision: ComparedRevision) => {
    let tokens = 0;
    let manifests = 0;
    let unresolved = 0;
    for (const component of revision.components) {
      if (component.skill?.role !== "manifest") continue;
      manifests += 1;
      tokens += component.skill.listing?.tokens ?? 0;
      if (component.skill.listing?.status === "unresolved") unresolved += 1;
    }
    return { tokens, manifests, unresolved };
  };
  const servers = (revision: ComparedRevision) => {
    const refs = new Map<string, McpServerRef>();
    let files = 0;
    let unresolved = 0;
    for (const component of revision.components) {
      if (!component.mcp) continue;
      files += 1;
      if (component.mcp.status === "unresolved") {
        unresolved += 1;
        continue;
      }
      for (const server of component.mcp.servers) {
        refs.set(`${component.path}\0${server.name}`, {
          name: server.name,
          path: component.path,
          provider: component.provider,
        });
      }
    }
    return { refs, files, unresolved };
  };
  const serversBefore = servers(baseline);
  const serversAfter = servers(target);
  const byServer = (a: McpServerRef, b: McpServerRef) => a.path.localeCompare(b.path) || a.name.localeCompare(b.name);
  const pluginsAt = (revision: ComparedRevision) => {
    const refs = new Map<string, PluginComparisonRef>();
    const unreadable = new Set<string>();
    // A Codex overlay beside a root manifest adds settings; that manifest is the plugin's identity.
    const overlay = ".codex-plugin/plugin.json";
    const tracked = new Set(revision.components.map((component) => component.path));
    for (const component of revision.components) {
      if (!component.plugins) continue;
      if (component.path.endsWith(overlay) && tracked.has(`${component.path.slice(0, -overlay.length)}plugin.json`)) {
        continue;
      }
      if (component.plugins.status === "unresolved") {
        unreadable.add(component.path);
        continue;
      }
      for (const plugin of component.plugins.plugins) {
        // A marketplace and a plugin can share a name in one settings file, so the kind is in the key.
        const kind = plugin.state === "marketplace" ? "marketplace" : "plugin";
        refs.set(`${component.path}\0${kind}\0${plugin.name}`, {
          name: plugin.name,
          path: component.path,
          provider: component.provider,
          state: plugin.state,
          ...(plugin.listed ? { listed: plugin.listed } : {}),
        });
      }
    }
    return { refs, unreadable };
  };
  const pluginsBefore = pluginsAt(baseline);
  const pluginsAfter = pluginsAt(target);
  const comparable = (refs: Map<string, PluginComparisonRef>) =>
    new Map(
      [...refs].filter(([, ref]) => !pluginsBefore.unreadable.has(ref.path) && !pluginsAfter.unreadable.has(ref.path)),
    );
  const refsBefore = comparable(pluginsBefore.refs);
  const refsAfter = comparable(pluginsAfter.refs);
  const byPlugin = (a: { name: string; path: string }, b: { name: string; path: string }) =>
    a.path.localeCompare(b.path) || a.name.localeCompare(b.name);
  const listedBefore = listing(baseline);
  const listedAfter = listing(target);
  const deltaTokens = target.estimatedTokens - baseline.estimatedTokens;
  return {
    beforeTokens: baseline.estimatedTokens,
    afterTokens: target.estimatedTokens,
    deltaTokens,
    percentChange: baseline.estimatedTokens === 0 ? null : (deltaTokens / baseline.estimatedTokens) * 100,
    beforeFiles: baseline.components.length,
    afterFiles: target.components.length,
    deltaFiles: target.components.length - baseline.components.length,
    byProvider: groups((component) => component.provider),
    byCategory: groups((component) => component.category),
    skillListing: {
      beforeTokens: listedBefore.tokens,
      afterTokens: listedAfter.tokens,
      deltaTokens: listedAfter.tokens - listedBefore.tokens,
      beforeManifests: listedBefore.manifests,
      afterManifests: listedAfter.manifests,
      beforeUnresolved: listedBefore.unresolved,
      afterUnresolved: listedAfter.unresolved,
    },
    ...(serversBefore.files || serversAfter.files
      ? {
          mcp: {
            beforeServers: serversBefore.refs.size,
            afterServers: serversAfter.refs.size,
            deltaServers: serversAfter.refs.size - serversBefore.refs.size,
            beforeUnresolved: serversBefore.unresolved,
            afterUnresolved: serversAfter.unresolved,
            added: [...serversAfter.refs]
              .flatMap(([key, ref]) => (serversBefore.refs.has(key) ? [] : [ref]))
              .sort(byServer),
            removed: [...serversBefore.refs]
              .flatMap(([key, ref]) => (serversAfter.refs.has(key) ? [] : [ref]))
              .sort(byServer),
          },
        }
      : {}),
    ...(pluginsBefore.refs.size ||
    pluginsAfter.refs.size ||
    pluginsBefore.unreadable.size ||
    pluginsAfter.unreadable.size
      ? {
          plugins: {
            beforePlugins: refsBefore.size,
            afterPlugins: refsAfter.size,
            deltaPlugins: refsAfter.size - refsBefore.size,
            beforeUnresolved: pluginsBefore.unreadable.size,
            afterUnresolved: pluginsAfter.unreadable.size,
            added: [...refsAfter].flatMap(([key, ref]) => (refsBefore.has(key) ? [] : [ref])).sort(byPlugin),
            removed: [...refsBefore].flatMap(([key, ref]) => (refsAfter.has(key) ? [] : [ref])).sort(byPlugin),
            changed: [...refsAfter]
              .flatMap(([key, ref]) => {
                const before = refsBefore.get(key);
                if (!before) return [];
                const same =
                  before.state === ref.state &&
                  before.listed?.local === ref.listed?.local &&
                  before.listed?.external === ref.listed?.external;
                if (same) return [];
                return [
                  {
                    name: ref.name,
                    path: ref.path,
                    provider: ref.provider,
                    before: before.state,
                    after: ref.state,
                    ...(before.listed ? { beforeListed: before.listed } : {}),
                    ...(ref.listed ? { afterListed: ref.listed } : {}),
                  },
                ];
              })
              .sort(byPlugin),
          },
        }
      : {}),
    components,
  };
}
