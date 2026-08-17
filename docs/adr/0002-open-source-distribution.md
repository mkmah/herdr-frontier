# Open-source distribution & release model

**Status:** accepted

herdr-frontier (renamed from herdr-beads when it went multi-tracker) is published as an
open-source herdr plugin installable via `herdr plugin install OWNER/herdr-frontier`. We
decide how it ships: a self-contained compiled binary, a version that lives only in
`herdr-plugin.toml`, and GitHub-based install rather than npm.

## Decision

- **Distribution = GitHub `[[build]]`.** `herdr plugin install` clones the repo and runs the
  manifest's `[[build]]` steps on the user's machine: `preflight.sh` (Bun >= 1.3 check) →
  `bun install --production --frozen-lockfile` → `scripts/build.ts`, which compiles the
  OpenTUI/Solid render layer into a single `bin/herdr-frontier` binary. The pane runs that
  binary directly. **Bun is needed only at install time** — the compiled binary embeds it.
- **The build must apply the Solid JSX transform at build time**, not runtime. `scripts/build.ts`
  passes `createSolidTransformPlugin()` from `@opentui/solid/bun-plugin` to `Bun.build({ compile: true })`.
  The preload is *not* allowed to ship in a `bunfig.toml`: compiled binaries read `bunfig.toml`
  from their cwd, and herdr runs panes with the **plugin root** as cwd — a shipped
  `bunfig.toml` makes the pane die instantly at runtime with
  `error: preload not found "@opentui/solid/preload"` (exit 1 → herdr closes the pane).
  Dev passes the preload explicitly instead: `bun run --preload @opentui/solid/preload`.
- **The pane resolves the workspace root from herdr context, not cwd.** herdr's plugin-pane
  contract is that runtime commands run with the plugin directory as cwd (see plugins docs),
  so `process.cwd()` would scan the plugin's own checkout for `.scratch/*/issues/` and show
  nothing. Instead the pane reads `HERDR_PLUGIN_CONTEXT_JSON` (`workspace_cwd`, or
  `focused_pane_cwd` as fallback) — the repo the pane was opened against. Standalone dev
  (`bun run src/index.tsx`, cwd) is unchanged.
- **Version lives only in `herdr-plugin.toml`.** package.json stays `private` —
  there is no npm package. Changesets bump the package.json version, the
  `version` script syncs it into the manifest, and releases are GitHub Releases
  with notes only, no binary assets (per-OS binaries are built by each user's
  install). *(Amended by ADR-0003: release automation moved from
  semantic-release to changesets.)*
- **License MIT**, copyright mkmah, 2026.

## Key trade-offs

- **GitHub-install over npm.** The plugin is a herdr plugin, not a library; herdr's native
  install path is `OWNER/REPO`. npm would add a registry + publishing step with no install
  benefit. The reference (`herdr-workflows`) uses the same model.
- **Compiled binary over source-run.** Source-run (`command = ["bun", "run", "src/index.tsx"]`)
  needs Bun on every user's machine at every run and re-resolves deps. A compiled binary is
  self-contained — but it does mean the 73 MB binary is built once per user at install, and the
  Solid transform must be baked at build time (the build-script complexity above).
- **Manifest-only version over package.json version.** One source of truth, no npm; matches the
  reference. Cost: `npm` tooling that expects a package.json version won't see one.
- **semantic-release over manual bumps.** Automatic `vX.Y.Z` tags from conventional commits —
  at the cost of forcing conventional commit messages on every merge (breaking pre-1.0 bumps
  minor, never 1.0.0).

## Consequences

- Contributors clone and build with Bun; end users install via herdr and never touch Bun again.
- A new tracker adapter is one new file under `src/tracker/` + a label-map; distribution is
  unaffected (the binary already embeds it).
- The repo's `.scratch/` tracker history is gitignored and stays private; public issues live in
  GitHub Issues (bug / feature / tracker-adapter templates).