// `bun run version` second half (run by changesets/action): `changeset version`
// bumps package.json, then this copies that version into herdr-plugin.toml so
// the product version (ADR 0002) and the changeset bump stay in lockstep.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"));
const version: string | undefined = pkg.version;
if (!version) {
  console.error("package.json has no version field");
  process.exit(1);
}

const manifestPath = join(import.meta.dir, "..", "herdr-plugin.toml");
const manifest = readFileSync(manifestPath, "utf8");
const current = manifest.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
if (!current) {
  console.error('could not find a `version = "..."` line in herdr-plugin.toml');
  process.exit(1);
}

if (current === version) {
  console.log(`herdr-plugin.toml already at ${version}`);
} else {
  const updated = manifest.replace(
    /^(version\s*=\s*")[^"]+(")/m,
    (_m, head: string, tail: string) => `${head}${version}${tail}`,
  );
  writeFileSync(manifestPath, updated);
  console.log(`herdr-plugin.toml version -> ${version}`);
}
