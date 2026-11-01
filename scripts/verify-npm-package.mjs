// Checks that the installed context-strata package was built by this
// repository's publish workflow from the release tag, using the output of
// `npm audit signatures --json --include-attestations`. npm has verified the
// signatures and attestations by then; this requires a SLSA provenance
// attestation and checks what it names: the repository, the workflow, the
// tag, and the tarball that was installed. Only then can the package's
// dist/source-digest.txt be trusted to describe the source it was built from.
//
// Usage: node scripts/verify-npm-package.mjs <audit.json> <package-lock.json> <version>
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repository = "https://github.com/nabondance/strata";
const workflow = ".github/workflows/publish.yml";

export function packageProblem(audit, lock, version) {
  if (audit.invalid?.length || audit.missing?.length)
    return "some installed packages have invalid or missing signatures";
  const entry = audit.verified?.find((item) => item.name === "context-strata" && item.version === version);
  if (!entry) return `context-strata@${version} is not among the verified packages`;
  const statements = (entry.attestationBundles ?? []).map((bundle) => {
    try {
      return JSON.parse(Buffer.from(bundle.bundle.dsseEnvelope.payload, "base64").toString("utf8"));
    } catch {
      return null;
    }
  });
  const provenance = statements.find((statement) => statement?.predicateType === "https://slsa.dev/provenance/v1");
  if (!provenance) return `context-strata@${version} has no provenance attestation`;
  const source = provenance.predicate?.buildDefinition?.externalParameters?.workflow ?? {};
  if (source.repository !== repository || source.path !== workflow || source.ref !== `refs/tags/v${version}`) {
    return `context-strata@${version} was not built by ${workflow} in ${repository} at v${version}`;
  }
  // npm keys the package by its path, relative when the prefix is reached through a symlink.
  const [, locked] =
    Object.entries(lock.packages ?? {}).find(
      ([path]) => path === "node_modules/context-strata" || path.endsWith("/node_modules/context-strata"),
    ) ?? [];
  const integrity = locked?.integrity ?? "";
  const installed = integrity.startsWith("sha512-") ? Buffer.from(integrity.slice(7), "base64").toString("hex") : "";
  const attested = (provenance.subject ?? []).map((subject) => subject.digest?.sha512);
  if (!installed || !attested.includes(installed)) return "the installed tarball is not the one the provenance names";
  return null;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const [auditPath, lockPath, version] = process.argv.slice(2);
  const problem = packageProblem(
    JSON.parse(readFileSync(auditPath, "utf8")),
    JSON.parse(readFileSync(lockPath, "utf8")),
    version,
  );
  if (problem) {
    console.log(problem);
    process.exit(1);
  }
}
