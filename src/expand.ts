import type { CategoryTotals, FilledRevision, Report, Revision, RevisionSnapshot, SkillGroup } from "./model.js";

/**
 * Restore what a report leaves out when it repeats the previous revision: an absent `firstParent`
 * is the previous revision's `id`, and absent `categoryTotals` are the previous revision's totals,
 * shared by reference. Fields that are present are kept, so filling a filled list changes nothing.
 *
 * The HTML report embeds this function's source beside `expandRevisions`, so it must stay
 * self-contained.
 */
export function fillRevisions(revisions: readonly Revision[]): FilledRevision[] {
  let categoryTotals: CategoryTotals | undefined;
  let previousId: string | null = null;
  return revisions.map((revision) => {
    categoryTotals = revision.categoryTotals ?? categoryTotals;
    if (!categoryTotals) throw new Error("The first revision of a report has no categoryTotals.");
    const firstParent = revision.firstParent === undefined ? previousId : revision.firstParent;
    previousId = revision.id;
    return { ...revision, firstParent, categoryTotals };
  });
}

/**
 * The inverse of `fillRevisions`, applied once when analysis assembles a report: leave out
 * `firstParent` when it is the previous revision's `id`, and `categoryTotals` when every figure
 * equals the previous revision's. The first revision keeps both. Most revisions of a long history
 * touch no recognized file, so this keeps a report's size closer to its number of changes than to
 * its number of revisions.
 */
export function compactRevisions(revisions: readonly FilledRevision[]): Revision[] {
  return revisions.map((revision, index) => {
    const previous = revisions[index - 1];
    if (!previous) return revision;
    // Rebuilt in the stored key order, so a compacted revision reads like a full one.
    const { id, date, firstParent, componentCount, categoryTotals, ...rest } = revision;
    return {
      id,
      date,
      ...(firstParent === previous.id ? {} : { firstParent }),
      componentCount,
      ...(sameCategoryTotals(categoryTotals, previous.categoryTotals) ? {} : { categoryTotals }),
      ...rest,
    };
  });
}

function sameCategoryTotals(a: CategoryTotals, b: CategoryTotals): boolean {
  if (a === b) return true;
  const categories = Object.keys(a) as Array<keyof CategoryTotals>;
  if (categories.length !== Object.keys(b).length) return false;
  return categories.every((category) => {
    const x = a[category];
    const y = b[category];
    return (
      y !== undefined &&
      x.count === y.count &&
      x.bytes === y.bytes &&
      x.estimatedTokens === y.estimatedTokens &&
      x.sourceOnlyCount === y.sourceOnlyCount
    );
  });
}

/**
 * Rebuild every revision's inventory from a report. Starting from an empty inventory, each change
 * drops its `previousPath`, then drops `path` when `component` is null or otherwise places that
 * entry of `report.components` at `path`. Entries are ordered by path, so sorting indexes sorts
 * an inventory. Revisions without changes share the previous revision's arrays. `fillRevisions`
 * first restores each revision's carried-forward `firstParent` and `categoryTotals`.
 *
 * The HTML report embeds this function's source beside `fillRevisions`, the one function it may call.
 */
export function expandRevisions(report: Report): RevisionSnapshot[] {
  const collator = new Intl.Collator();
  const inventory = new Map<string, number>();
  let components: RevisionSnapshot["components"] = [];
  let skillGroups: SkillGroup[] = [];
  return fillRevisions(report.revisions).map((revision) => {
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
            listing: null,
            resourceCount: 0,
            resourceBytes: 0,
          };
          groups.set(component.skill.root, group);
        }
        if (component.skill.role === "manifest") {
          group.manifestPath = component.path;
          group.manifestEstimatedTokens = component.estimatedTokens ?? 0;
          group.listing = component.skill.listing ?? null;
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
