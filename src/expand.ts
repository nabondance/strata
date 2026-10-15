import type { Report, RevisionSnapshot, SkillGroup } from "./model.js";

/**
 * Rebuild every revision's inventory from a report. Starting from an empty inventory, each change
 * drops its `previousPath`, then drops `path` when `component` is null or otherwise places that
 * entry of `report.components` at `path`. Entries are ordered by path, so sorting indexes sorts
 * an inventory. Revisions without changes share the previous revision's arrays.
 *
 * The HTML report embeds this function's source, so it must stay self-contained.
 */
export function expandRevisions(report: Report): RevisionSnapshot[] {
  const collator = new Intl.Collator();
  const inventory = new Map<string, number>();
  let components: RevisionSnapshot["components"] = [];
  let skillGroups: SkillGroup[] = [];
  return report.revisions.map((revision) => {
    if (revision.changes.length) {
      for (const change of revision.changes) {
        if (change.previousPath !== undefined) inventory.delete(change.previousPath);
        if (change.component === null) inventory.delete(change.path);
        else inventory.set(change.path, change.component);
      }
      components = Array.from(Uint32Array.from(inventory.values()).sort(), (index) => report.components[index]!);
      const groups = new Map<string, SkillGroup>();
      for (const component of components) {
        if (!component.skill) continue;
        let group = groups.get(component.skill.root);
        if (!group) {
          group = {
            root: component.skill.root,
            provider: component.provider,
            ...(component.readers ? { readers: component.readers } : {}),
            manifestPath: null,
            manifestEstimatedTokens: 0,
            resourceCount: 0,
            resourceBytes: 0,
          };
          groups.set(component.skill.root, group);
        }
        if (component.skill.role === "manifest") {
          group.manifestPath = component.path;
          group.manifestEstimatedTokens = component.estimatedTokens ?? 0;
        } else {
          group.resourceCount += 1;
          group.resourceBytes += component.bytes;
        }
      }
      skillGroups = [...groups.values()].sort((a, b) => collator.compare(a.root, b.root));
    }
    return { ...revision, components, skillGroups };
  });
}
