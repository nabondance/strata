// Prints a SHA-256 digest of the sources Strata's build and npm package come
// from: package.json, the lockfile, tsconfig.json, src/, and skills/. The build
// writes it to dist/source-digest.txt, so the npm package records the source it
// was built from. The GitHub Action computes the same digest of its own source
// and uses the npm package only when the two match.
//
// Usage: node scripts/source-digest.mjs [<root>] [--write <file>]
// <root> defaults to the repository this script is in.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const sources = ["package.json", "pnpm-lock.yaml", "tsconfig.json", "src", "skills"];

export function sourceDigest(root) {
  const files = [];
  const walk = (path) => {
    if (statSync(path).isDirectory()) {
      // .DS_Store is never tracked and npm leaves it out of the package.
      for (const name of readdirSync(path)) if (name !== ".DS_Store") walk(join(path, name));
    } else {
      files.push(relative(root, path).split(sep).join("/"));
    }
  };
  for (const source of sources) walk(join(root, source));
  const hash = createHash("sha256");
  for (const file of files.sort()) {
    hash.update(`${file}\0`);
    hash.update(readFileSync(join(root, file)));
    hash.update("\0");
  }
  return `sha256-${hash.digest("hex")}`;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  let root = resolve(import.meta.dirname, "..");
  let output;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--write") {
      output = args[++index];
      if (!output) throw new Error("--write requires a file");
    } else {
      root = resolve(args[index]);
    }
  }
  const digest = sourceDigest(root);
  if (output) writeFileSync(output, `${digest}\n`);
  else console.log(digest);
}
