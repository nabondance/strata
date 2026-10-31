import type { Report } from "./model.js";

function aliases(values: Iterable<string>, prefix: string): Map<string, string> {
  return new Map(
    [...new Set(values)].sort().map((value, index) => [value, `${prefix}-${String(index + 1).padStart(5, "0")}`]),
  );
}

/** Return a redacted copy with identifiers replaced by aliases. The input report is left untouched. */
export function redactReport(report: Report): Report {
  // Every path a change mentions belongs to some file version, so the component table has them all.
  // An import can name a path no file version has, such as a package name or a symlink, so import
  // targets and the files symlinks lead to are aliased with the same map.
  const paths = aliases(
    report.components.flatMap((component) => [
      component.path,
      ...(component.imports ?? []).flatMap(({ target, symlinkTarget }) => [
        ...(target === null ? [] : [target]),
        ...(symlinkTarget === undefined ? [] : [symlinkTarget]),
      ]),
    ]),
    "file",
  );
  const skillRoots = aliases(
    report.components.flatMap((component) => (component.skill ? [component.skill.root] : [])),
    "skill",
  );
  const servers = aliases(
    report.components.flatMap((component) =>
      component.mcp?.status === "listed" ? component.mcp.servers.map((server) => server.name) : [],
    ),
    "server",
  );
  const blobs = aliases(
    report.components.map((component) => component.blob),
    "blob",
  );
  const submodules = aliases(
    (report.submodules ?? []).map((submodule) => submodule.path),
    "submodule",
  );
  const revisions = new Map(
    report.revisions.map((revision, index) => [revision.id, `revision-${String(index + 1).padStart(5, "0")}`]),
  );
  const outsideParents = aliases(
    report.revisions.flatMap((revision) =>
      revision.firstParent && !revisions.has(revision.firstParent) ? [revision.firstParent] : [],
    ),
    "outside-parent",
  );
  return {
    ...report,
    repository: "redacted repository",
    branch: "redacted branch",
    privacy: { mode: "shareable" },
    ...(report.submodules
      ? { submodules: report.submodules.map((submodule) => ({ ...submodule, path: submodules.get(submodule.path)! })) }
      : {}),
    components: report.components.map((component) => ({
      ...component,
      path: paths.get(component.path)!,
      blob: blobs.get(component.blob)!,
      ...(component.skill ? { skill: { ...component.skill, root: skillRoots.get(component.skill.root)! } } : {}),
      ...(component.mcp?.status === "listed"
        ? {
            mcp: {
              ...component.mcp,
              servers: component.mcp.servers.map((server) => ({ ...server, name: servers.get(server.name)! })),
            },
          }
        : {}),
      ...(component.imports
        ? {
            imports: component.imports.map((entry) => ({
              ...entry,
              target: entry.target === null ? null : paths.get(entry.target)!,
              ...(entry.symlinkTarget === undefined ? {} : { symlinkTarget: paths.get(entry.symlinkTarget)! }),
            })),
          }
        : {}),
    })),
    revisions: report.revisions.map((revision) => ({
      ...revision,
      id: revisions.get(revision.id)!,
      firstParent: revision.firstParent
        ? (revisions.get(revision.firstParent) ?? outsideParents.get(revision.firstParent)!)
        : null,
      changes: revision.changes.map((change) => ({
        ...change,
        path: paths.get(change.path)!,
        ...(change.previousPath ? { previousPath: paths.get(change.previousPath)! } : {}),
      })),
    })),
  };
}
