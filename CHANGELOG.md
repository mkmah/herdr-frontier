# herdr-frontier

## 0.2.0

### Minor Changes

- [#5](https://github.com/mkmah/herdr-frontier/pull/5) [`0cb59e6`](https://github.com/mkmah/herdr-frontier/commit/0cb59e6e10df1821a17c20c7108d5f818f51f186) - Release the first installable build that actually keeps the pane open and makes it
  usable:
  
  - **Pane no longer closes instantly after `herdr plugin pane open`.** The compiled
    binary re-read the repo's shipped `bunfig.toml` from its cwd (herdr runs panes from
    the installed plugin root) and died at startup with `error: preload not found
    "@opentui/solid/preload"`, so herdr closed the pane. The preload no longer ships in a
    `bunfig.toml` (removed; dev passes it via `bun run --preload @opentui/solid/preload`).
  - **The pane reads your repo, not the plugin checkout.** It now resolves the host
    workspace's root from `HERDR_PLUGIN_CONTEXT_JSON` (falling back to `process.cwd()`
    for standalone runs), so the issue list uses your repo's `.scratch/` even though herdr
    runs panes from the installed plugin root.
  - **Two actions with stable labels.** `open` (split) renames the pane to `Issues`, and
    the new `open-tab` action opens the issue list in a dedicated tab named `Issues`
    (`plugin.pane.open` exposes no label parameter, so each action captures the created id
    from its own open response and renames it via `pane rename` / `tab rename`). Bind them
    to keys with `[[keys.command]] … type = "plugin_action" command = "herdr-frontier.open-tab"`.

## 0.1.0

### Minor Changes

- [`1484ea9`](https://github.com/mkmah/herdr-frontier/commit/1484ea96e3043e49bd64294cf1e2141e3dd142c4) - Switch from semantic-release to Changesets. Release notes are now written at
  PR time in `.changeset/*.md`; merging the bot's "ci: Version Packages" PR
  creates the tag and GitHub Release. No release token is stored in the repo
  (the workflow uses plain `GITHUB_TOKEN`).
