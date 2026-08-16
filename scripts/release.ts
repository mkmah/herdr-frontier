// changesets `publish` step (ADR 0003): there is no npm package — publishing
// is creating the vX.Y.Z tag and the GitHub Release, with the CHANGELOG
// section for the version as the release notes.
//
// Run by .github/workflows/release.yml via `bun run release` after the
// "ci: Version Packages" PR merges. The tag is created through the Releases
// API, so no git push and no persisted credentials are needed.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const manifest = readFileSync(join(import.meta.dir, "..", "herdr-plugin.toml"), "utf8");
const version = manifest.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
if (!version) {
  console.error('could not find a `version = "..."` line in herdr-plugin.toml');
  process.exit(1);
}

const changelogPath = join(import.meta.dir, "..", "CHANGELOG.md");
let body: string;
try {
  const changelog = readFileSync(changelogPath, "utf8");
  const start = changelog.indexOf(`## ${version}`);
  if (start === -1) {
    // A push with no pending changesets that isn't a Version Packages merge
    // (e.g. docs-only, no changeset added) — nothing to publish.
    console.log(`CHANGELOG.md has no "## ${version}" section — nothing to do`);
    process.exit(0);
  }
  const next = changelog.indexOf("\n## ", start + 1);
  body = changelog.slice(start + `## ${version}`.length, next === -1 ? undefined : next).trim();
} catch {
  console.log("no CHANGELOG.md yet — nothing to do");
  process.exit(0);
}

const tag = `v${version}`;
const prerelease = version.includes("-");

const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error("GITHUB_TOKEN not set");
  process.exit(1);
}

const res = await fetch("https://api.github.com/repos/mkmah/herdr-frontier/releases", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ tag_name: tag, name: tag, body, prerelease }),
});

const text = await res.text();
if (!res.ok) {
  if (res.status === 422 && text.includes("already_exists")) {
    console.log(`release ${tag} already exists — nothing to do`);
  } else {
    console.error(`failed to create release: ${res.status} ${text}`);
    process.exit(1);
  }
} else {
  console.log(`released ${tag}: ${JSON.parse(text).html_url}`);
}
