# Supply-chain hardening & branch protection

**Status:** accepted

The repo is public and installed by third parties via `herdr plugin install`
(their machines execute our `[[build]]` steps). Modeled on TanStack/ai's
pipeline, we harden CI against the shai-hulud class of attacks (compromised
dependency steals workflow credentials; workflow template injection) and lock
`main` behind a ruleset.

## Decision

- **`main` is protected by a ruleset**: no force pushes, no deletion, changes
  via PR only, required status checks (`test (linux)`, `test (macos)`,
  `typecheck (linux)`, `zizmor`) with strict up-to-date policy. The only bypass
  actor is mkmah.
- **Releases use Changesets, not semantic-release** (supersedes the PAT design
  first recorded here). A PR ships with a `.changeset/*.md` declaring its bump
  and release note. On merge, `changesets/action` opens a single "ci: Version
  Packages" PR; **merging that PR is the release act**. On the resulting push,
  the action runs `bun run release`, which tags `vX.Y.Z` and creates the GitHub
  Release from the CHANGELOG section via the API.
- **No long-lived release credential exists.** CI never pushes to `main` — the
  version bump arrives by PR — so the ephemeral `GITHUB_TOKEN` is enough and
  the `release` environment / `RELEASE_PAT` / bypass-for-release design was
  dropped.
- **`persist-credentials: false`** on every checkout except the release job's,
  where changesets pushes the version branch with the (ephemeral
  `GITHUB_TOKEN`) checkout credential — the TanStack trade-off.
- **zizmor scans all workflows** on every push and PR (pinned-SHA actions
  only; template injection and excessive permissions are findings).
- **Least-privilege permissions everywhere**: `contents: read` (or `{}`)
  top-level, job-level escalation only where needed (release: `contents:
  write` + `pull-requests: write`). No `id-token: write` — there is no npm
  publishing, so no OIDC.
- **Dependabot runs with a 7-day cooldown** (both ecosystems): a poisoned
  publish gets yanked or reported before we open an update PR on it.
- **Prerelease channels** (`alpha`/`beta`/`rc` branches) trigger the same
  release workflow; `changeset pre enter <channel>` produces
  `0.x.y-channel.N` versions, which `scripts/release.ts` marks as prereleases.
  The ruleset covers these branches too.

## Key trade-offs

- **Changesets over semantic-release.** Release intent is declared at PR time
  by the author instead of parsed from commit messages. Cost: one extra file
  per PR; benefit: no write credential, no commit-message convention to
  enforce, and human-readable release notes.
- **The Version Packages PR carries no CI checks** — PRs opened with
  `GITHUB_TOKEN` trigger no `pull_request` workflows, so its required checks
  never appear and it is merged by the owner via the ruleset bypass. Acceptable
  because its content is machine-generated (version fields + CHANGELOG) from
  already-CI-passing commits.
- **Bypass actor over no-bypass.** The owner needs the bypass for the Version
  Packages PR; everything else merges through gated PRs.

## Consequences

- Before merging any PR that changes behavior, add a changeset — otherwise the
  change ships silently with the next version bump.
- Releasing = merge the "ci: Version Packages" PR; nothing else to click. The
  publish run creates the tag + GitHub Release.
- Adding a new workflow that writes to `main` requires rethinking the bypass
  design; adding a new required check means updating the ruleset.
