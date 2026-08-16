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
- **`@semantic-release/git` keeps pushing the version commit** to `main`.
  `GITHUB_TOKEN` can never bypass branch protection, so the release job
  authenticates with a fine-grained PAT (`contents` R/W, this repo only) owned
  by the bypass actor, stored as `RELEASE_PAT`.
- **The PAT lives in a `release` environment** whose deployment-branch policy
  is `main` only. The release workflow is `workflow_dispatch` only, so the
  secret is unreachable from fork PRs (never receive secrets), branch pushes
  (environment policy), or any automatic trigger.
- **Every checkout sets `persist-credentials: false`** except none — release
  authenticates via `GH_TOKEN` env, not persisted git credentials, so a
  compromised dependency cannot exfiltrate a usable credential from disk.
- **zizmor scans all workflows** on every push and PR (pinned-SHA actions
  only; template injection and excessive permissions are findings).
- **Least-privilege permissions everywhere**: `permissions: {}` or
  `contents: read` top-level, job-level escalation only where needed
  (release: `contents: write`). Issue/PR comment scopes were dropped when the
  plugin's comments were disabled.

## Key trade-offs

- **PAT over changesets/PR-bumps.** TanStack lands version bumps via a bot PR
  (changesets) and needs no credential at all. We keep semantic-release's
  zero-touch conventional-commit inference instead; the cost is one long-lived
  secret, contained by environment scoping + dispatch-only triggering +
  fine-grained scope (worst case: content write to this one repo, which is
  recoverable from git history).
- **Bypass actor over no-bypass.** Requiring PRs with no bypass would break
  the release push; alternatives (GitHub App, deploy key) add moving parts
  without removing a secret from the equation for a solo repo.

## Consequences

- Direct pushes to `main` by the owner still work (bypass) but show as
  bypassed in the audit log; everything else merges through PRs gated on CI.
- Before the first release after this ADR, `RELEASE_PAT` must exist in the
  `release` environment or the dispatch fails fast at semantic-release.
- Adding a new workflow that writes to `main` requires rethinking the bypass
  design; adding a new required check means updating the ruleset.
