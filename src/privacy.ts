import type { Report } from "./analyze.js";

function aliases(values: Iterable<string>, prefix: string): Map<string, string> {
  return new Map([...new Set(values)].sort().map((value, index) => [
    value, `${prefix}-${String(index + 1).padStart(5, "0")}`,
  ]));
}

export function redactReport(report: Report): Report {
  const paths = aliases(report.revisions.flatMap((revision) => [
    ...revision.components.map((component) => component.path),
    ...revision.changes.flatMap((change) => change.previousPath ? [change.previousPath] : []),
  ]), "file");
  const skillRoots = aliases(report.revisions.flatMap((revision) =>
    revision.skillGroups.map((group) => group.root)), "skill");
  const blobs = aliases(report.revisions.flatMap((revision) =>
    revision.components.map((component) => component.blob)), "blob");
  const revisions = new Map(report.revisions.map((revision, index) => [
    revision.id, `revision-${String(index + 1).padStart(5, "0")}`,
  ]));
  const outsideParents = aliases(report.revisions.flatMap((revision) =>
    revision.firstParent && !revisions.has(revision.firstParent) ? [revision.firstParent] : []), "outside-parent");
  const redacted = structuredClone(report);
  redacted.repository = "redacted repository";
  redacted.branch = "redacted branch";
  redacted.privacy = { mode: "shareable" };
  for (const revision of redacted.revisions) {
    revision.id = revisions.get(revision.id)!;
    if (revision.firstParent) {
      revision.firstParent = revisions.get(revision.firstParent) ?? outsideParents.get(revision.firstParent)!;
    }
    for (const component of revision.components) {
      component.path = paths.get(component.path)!;
      component.blob = blobs.get(component.blob)!;
      if (component.skill) component.skill.root = skillRoots.get(component.skill.root)!;
    }
    for (const group of revision.skillGroups) {
      group.root = skillRoots.get(group.root)!;
      if (group.manifestPath) group.manifestPath = paths.get(group.manifestPath)!;
    }
    for (const change of revision.changes) {
      change.path = paths.get(change.path)!;
      if (change.previousPath) change.previousPath = paths.get(change.previousPath)!;
    }
  }
  return redacted;
}
