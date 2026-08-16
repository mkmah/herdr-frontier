// semantic-release `prepareCmd`: write ${nextRelease.version} into
// herdr-plugin.toml. Product version lives only in the manifest — package.json
// stays private with no version field.
//
// Run by release.config.js: bun scripts/prepare-release.ts <version>

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const version = process.argv[2];
if (!version) {
  console.error("usage: bun scripts/prepare-release.ts <version>");
  process.exit(1);
}

const manifestPath = join(import.meta.dir, "..", "herdr-plugin.toml");
const manifest = readFileSync(manifestPath, "utf8");
const updated = manifest.replace(
  /^(version\s*=\s*")[^"]+(")/m,
  (_m, head: string, tail: string) => `${head}${version}${tail}`,
);

if (updated === manifest) {
  console.error("could not find a `version = \"...\"` line in herdr-plugin.toml");
  process.exit(1);
}

writeFileSync(manifestPath, updated);
console.log(`herdr-plugin.toml version -> ${version}`);