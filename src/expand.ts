import type { CategoryTotals, FilledRevision, Report, Revision, RevisionSnapshot, SkillGroup } from "./model.js";

/**
 * Restore what a report leaves out when it repeats the previous revision. An absent `firstParent`
 * is the previous revision's `id`; absent `categoryTotals` and `providerTokenTotals` are the
 * previous revision's, shared by reference; an absent `componentCount`, `estimatedTokens`,
 * `skillListingTokens`, or `skillListingUnresolved` is the previous revision's value; and absent
 * `changes` are none. Fields that are present are kept, so filling a filled list changes nothing.
 *
 * The HTML report embeds this function's source beside `expandRevisions`, so it must stay
 * self-contained.
 */
export function fillRevisions(revisions: readonly Revision[]): FilledRevision[] {
  let previous: FilledRevision | undefined;
  return revisions.map((revision) => {
    const categoryTotals = revision.categoryTotals ?? previous?.categoryTotals;
    if (!categoryTotals) throw new Error("The first revision of a report has no categoryTotals.");
    const providerTokenTotals = revision.providerTokenTotals ?? previous?.providerTokenTotals;
    const filled: FilledRevision = {
      ...revision,
      firstParent: revision.firstParent === undefined ? (previous?.id ?? null) : revision.firstParent,
      componentCount: revision.componentCount ?? previous?.componentCount ?? 0,
      categoryTotals,
      estimatedTokens: revision.estimatedTokens ?? previous?.estimatedTokens ?? 0,
      skillListingTokens: revision.skillListingTokens ?? previous?.skillListingTokens ?? 0,
      skillListingUnresolved: revision.skillListingUnresolved ?? previous?.skillListingUnresolved ?? 0,
      changes: revision.changes ?? [],
      ...(providerTokenTotals ? { providerTokenTotals } : {}),
    };
    previous = filled;
    return filled;
  });
}

/**
 * The inverse of `fillRevisions`, applied once when analysis assembles a report: leave out each
 * field `fillRevisions` carries forward when it repeats the previous revision, and `changes` when
 * there are none. The first and the last revision keep every field, so a reader of the latest
 * totals needs no filling. Most revisions of a long history touch no recognized file, so this keeps
 * a report's size closer to its number of changes than to its number of revisions.
 */
export function compactRevisions(revisions: readonly FilledRevision[]): Revision[] {
  const last = revisions.length - 1;
  return revisions.map((revision, index) => {
    const previous = revisions[index - 1];
    if (!previous || index === last) return revision;
    // Rebuilt in the stored key order, so a compacted revision reads like a full one.
    const {
      id,
      date,
      firstParent,
      componentCount,
      categoryTotals,
      estimatedTokens,
      skillListingTokens,
      skillListingUnresolved,
      changes,
      providerTokenTotals,
      ...rest
    } = revision;
    return {
      id,
      date,
      ...(firstParent === previous.id ? {} : { firstParent }),
      ...(componentCount === previous.componentCount ? {} : { componentCount }),
      ...(sameTotals(categoryTotals, previous.categoryTotals) ? {} : { categoryTotals }),
      ...(estimatedTokens === previous.estimatedTokens ? {} : { estimatedTokens }),
      ...(skillListingTokens === previous.skillListingTokens ? {} : { skillListingTokens }),
      ...(skillListingUnresolved === previous.skillListingUnresolved ? {} : { skillListingUnresolved }),
      ...(changes.length ? { changes } : {}),
      ...(providerTokenTotals === undefined || sameFigures(providerTokenTotals, previous.providerTokenTotals)
        ? {}
        : { providerTokenTotals }),
      ...rest,
    };
  });
}

function sameTotals(a: CategoryTotals, b: CategoryTotals): boolean {
  if (a === b) return true;
  const categories = Object.keys(a) as Array<keyof CategoryTotals>;
  if (categories.length !== Object.keys(b).length) return false;
  // Compare every figure a category carries, so a field added later is never dropped from a compacted report.
  return categories.every((category) => sameFigures(a[category], b[category]));
}

function sameFigures(a: object | undefined, b: object | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const fields = Object.keys(x);
  return fields.length === Object.keys(y).length && fields.every((field) => x[field] === y[field]);
}

/**
 * Rebuild every revision's inventory from a report. Starting from an empty inventory, each change
 * drops its `previousPath`, then drops `path` when `component` is null or otherwise places that
 * entry of `report.components` at `path`. Entries are ordered by path, so sorting indexes sorts
 * an inventory. Revisions without changes share the previous revision's arrays. `fillRevisions`
 * first restores each revision's carried-forward fields.
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
