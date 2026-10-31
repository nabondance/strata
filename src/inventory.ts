import { type Classification, categories, classify, type UpFront } from "./adapters.js";
import type { ContentUse } from "./content-pass.js";
import type { Measurer } from "./measurement.js";
import type { CategoryTotals, ClaudeImport, Component, FilledRevision, McpServers } from "./model.js";
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

/** The key of one file version, a path and the blob stored there, as analysis maps measure them. */
export const versionKey = (path: string, blob: string) => `${path}\0${blob}`;

export function byPath<T extends { path: string }>(a: T, b: T): number {
  return collator.compare(a.path, b.path);
}

/** Only regular files on recognized paths are tracked; symlinks and submodules are skipped. */
export function trackedFile(mode: string, blob: string, path: string): TrackedFile | null {
  if (mode !== "100644" && mode !== "100755") return null;
  const classification = classify(path);
  return classification ? { path, blob, classification } : null;
}

/** Counts the tokens of each distinct instructional blob, for a measurer that needs the text. */
export class TokenCounts implements ContentUse {
  readonly counts = new Map<string, number>();

  constructor(private readonly measurer: Measurer) {}

  wants(file: TrackedFile): boolean {
    return Boolean(
      file.classification.instructionalText && !this.measurer.countFromSize && !this.counts.has(file.blob),
    );
  }

  read(blob: string, body: Buffer, files: TrackedFile[]): void {
    if (this.counts.has(blob)) return;
    try {
      this.counts.set(blob, this.measurer.count(body));
    } catch (error) {
      throw new Error(
        `Could not count instructional blob ${blob} at ${files[0]!.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/** Each distinct blob among the files, in the order first seen. */
export const distinctBlobs = (files: Iterable<TrackedFile>): string[] => [
  ...new Set(Array.from(files, (file) => file.blob)),
];

/**
 * Measure each distinct blob once. Sizes come from object headers. Tokens come from the size when
 * the measurer allows it, and otherwise from `tokens`, which the shared content pass filled.
 */
export function measureBlobs(
  files: Iterable<TrackedFile>,
  sizes: Map<string, number>,
  measurer: Measurer,
  tokens: TokenCounts,
): Map<string, BlobMeasurement> {
  const instructional = new Set<string>();
  for (const file of files) if (file.classification.instructionalText) instructional.add(file.blob);
  const measured = new Map<string, BlobMeasurement>();
  for (const [blob, bytes] of sizes) {
    measured.set(blob, {
      bytes,
      tokens: !instructional.has(blob)
        ? null
        : measurer.countFromSize
          ? measurer.countFromSize(bytes)
          : tokens.counts.get(blob)!,
    });
  }
  return measured;
}

export function toComponent(
  file: TrackedFile,
  measured: BlobMeasurement,
  providerTokenCounts?: Component["providerTokenCounts"],
  listing?: SkillListing,
  imports?: ClaudeImport[],
  ruleUpFront?: UpFront,
  mcp?: McpServers,
): Component {
  const { classification } = file;
  const upFront = classification.upFront ?? ruleUpFront;
  return {
    path: file.path,
    blob: file.blob,
    provider: classification.provider,
    ...(classification.readers ? { readers: classification.readers } : {}),
    ...(classification.contextFile ? { contextFile: classification.contextFile } : {}),
    category: classification.category,
    ...(classification.legacy ? { legacy: true as const } : {}),
    ...(classification.imported ? { imported: true as const } : {}),
    ...(imports?.length ? { imports, ...(classification.importRoot ? { importRoot: true as const } : {}) } : {}),
    ...(upFront ? { upFront } : {}),
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
    ...(mcp ? { mcp } : {}),
  };
}

/** Derive a revision's totals from its components, so they are never maintained as separate facts. */
export function summarize(
  components: Iterable<Component>,
): Pick<
  FilledRevision,
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
