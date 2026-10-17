import { type Classification, categories, classify } from "./adapters.js";
import { blobSizes, readBlobs } from "./git.js";
import type { Measurer } from "./measurement.js";
import type { CategoryTotals, Component, Revision } from "./model.js";
import type { SkillListing } from "./skill-listing.js";

export interface TrackedFile {
  path: string;
  blob: string;
  classification: Classification;
}

export interface BlobMeasurement {
  bytes: number;
  tokens: number | null;
}

const collator = new Intl.Collator();

export function byPath<T extends { path: string }>(a: T, b: T): number {
  return collator.compare(a.path, b.path);
}

/** Only regular files on recognized paths are tracked; symlinks and submodules are skipped. */
export function trackedFile(mode: string, blob: string, path: string): TrackedFile | null {
  if (mode !== "100644" && mode !== "100755") return null;
  const classification = classify(path);
  return classification ? { path, blob, classification } : null;
}

/**
 * Measure each distinct blob once. Sizes come from object headers; content is read only for
 * instructional text when the measurement needs it.
 */
export function measureBlobs(
  repo: string,
  files: Iterable<TrackedFile>,
  measurer: Measurer,
): Map<string, BlobMeasurement> {
  const instructionalPath = new Map<string, string>();
  const blobs = new Set<string>();
  for (const file of files) {
    blobs.add(file.blob);
    if (file.classification.instructionalText && !instructionalPath.has(file.blob))
      instructionalPath.set(file.blob, file.path);
  }
  const sizes = blobSizes(repo, [...blobs]);
  const measured = new Map<string, BlobMeasurement>();
  for (const [blob, bytes] of sizes) {
    measured.set(blob, {
      bytes,
      tokens: measurer.countFromSize && instructionalPath.has(blob) ? measurer.countFromSize(bytes) : null,
    });
  }
  if (!measurer.countFromSize) {
    for (const [blob, body] of readBlobs(repo, [...instructionalPath.keys()], (blob) => sizes.get(blob) ?? 0)) {
      try {
        measured.get(blob)!.tokens = measurer.count(body);
      } catch (error) {
        throw new Error(
          `Could not count instructional blob ${blob} at ${instructionalPath.get(blob)}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  return measured;
}

export function toComponent(
  file: TrackedFile,
  measured: BlobMeasurement,
  providerTokenCounts?: Component["providerTokenCounts"],
  listing?: SkillListing,
): Component {
  const { classification } = file;
  return {
    path: file.path,
    blob: file.blob,
    provider: classification.provider,
    ...(classification.readers ? { readers: classification.readers } : {}),
    ...(classification.contextFile ? { contextFile: classification.contextFile } : {}),
    category: classification.category,
    bytes: measured.bytes,
    estimatedTokens: classification.instructionalText ? measured.tokens : null,
    ...(providerTokenCounts && Object.keys(providerTokenCounts).length ? { providerTokenCounts } : {}),
    ...(classification.skillRoot && classification.skillRole
      ? {
          skill: {
            root: classification.skillRoot,
            role: classification.skillRole,
            ...(listing && classification.skillRole === "manifest" ? { listing } : {}),
          },
        }
      : {}),
  };
}

/** Derive a revision's totals from its components, so they are never maintained as separate facts. */
export function summarize(
  components: Iterable<Component>,
): Pick<
  Revision,
  "componentCount" | "categoryTotals" | "estimatedTokens" | "skillListingTokens" | "skillListingUnresolved"
> {
  const categoryTotals = Object.fromEntries(
    categories.map((category) => [category, { count: 0, bytes: 0, estimatedTokens: 0, sourceOnlyCount: 0 }]),
  ) as CategoryTotals;
  let componentCount = 0;
  let estimatedTokens = 0;
  let skillListingTokens = 0;
  let skillListingUnresolved = 0;
  for (const component of components) {
    const total = categoryTotals[component.category];
    componentCount += 1;
    total.count += 1;
    total.bytes += component.bytes;
    total.estimatedTokens += component.estimatedTokens ?? 0;
    estimatedTokens += component.estimatedTokens ?? 0;
    if (component.estimatedTokens === null) total.sourceOnlyCount += 1;
    skillListingTokens += component.skill?.listing?.tokens ?? 0;
    if (component.skill?.listing?.status === "unresolved") skillListingUnresolved += 1;
  }
  return { componentCount, categoryTotals, estimatedTokens, skillListingTokens, skillListingUnresolved };
}
