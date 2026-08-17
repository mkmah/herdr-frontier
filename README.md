# herdr-frontier

A **herdr** plugin that shows your issue graph at a glance and advances it for you. It
orchestrates the Matt Pocock skill workflow (`wayfinder` → `grill-with-docs` → `to-spec` →
`to-tickets` → `implement` → `triage`) across a dependency graph of issues, on any tracker
you keep issues in.

Built on [OpenTUI](https://github.com/anomalyco/opentui) with SolidJS, it runs as one herdr
pane: a two-pane list + detail shell, a toggleable dependency tree, live agent state, and a
shared claim mutex so manual and automated launches never double-start an issue.

## Trackers

- **local-markdown** — `.scratch/<feature>/issues/` — built today.
- **beads / GitHub / Jira / Linear** — designed-for behind the same `TrackerProvider`
  interface (ADR-0001); not built yet. Adding one is a new adapter + label-map.

## Install

You need [herdr](https://herdr.dev) 0.8.0 or later. Bun is required only at install time
(the plugin compiles itself on your machine); the resulting binary runs with no Bun.

```bash
herdr plugin install mkmah/herdr-frontier
```

> If the pane opens and closes instantly, reinstall (the first 0.1.0 build shipped a
> `bunfig.toml` that the compiled binary re-reads and dies on — fixed in the next
> release via `herdr plugin update`).

In any herdr workspace that hosts issues under its own `.scratch/<feature>/issues/`, open
the pane (the pane resolves the workspace root from herdr's context — it runs from the
installed plugin checkout, not your repo):

```bash
herdr plugin pane open --plugin herdr-frontier --entrypoint issues --placement split --focus
```

### Open it in a tab with a keybinding

The manifest ships two actions — `open` (split, the command above) and `open-tab`
(dedicated tab) — either of which herdr can map onto a key. Both name what they
create: `open` renames the split pane to `Issues`, and `open-tab` names the new
tab `Issues` (herdr numbers plugin-pane tabs by default and would otherwise label
them "1, 2, 3…"; `plugin.pane.open` exposes no label parameter, so each action
captures the id from its own open response and renames it). With a
`[keys] prefix` of `ctrl+a`, add this to `~/.config/herdr/config.toml` and run
`herdr server reload-config`:

```toml
# open the frontier issue list in its own tab
[[keys.command]]
key = "prefix+f"
type = "plugin_action"
command = "herdr-frontier.open-tab"
description = "Open herdr-frontier issues in a tab"

# …or as a split in the current tab
[[keys.command]]
key = "prefix+shift+f"
type = "plugin_action"
command = "herdr-frontier.open"
description = "Open herdr-frontier issues (split)"
```

`prefix+f` / `prefix+shift+f` are the author's own bindings — pick any key your
config doesn't already use (`herdr config check` flags conflicts, and `prefix+?`
in herdr shows the live keymap). The actions are interchangeable: bind either
action to whichever key you prefer.

## Quick start

Create a couple of issues so the pane has something to show:

```md
# .scratch/demo/issues/01-first.md

Title: First issue
Status: open
Labels: ready-for-agent
Blocked by: —
```

Open the pane, `Tab` to the list, `j`/`k` to move, `Enter` to dispatch an issue to an agent
pane, `s` to start an automated run bound to the current effort.

## Ways to work

| Key            | What it does                                      |
| -------------- | ------------------------------------------------- |
| `Tab`          | Move focus between the list and the detail pane   |
| `j` / `k`      | Move the selection                                |
| `Enter`        | Dispatch the selected issue to an agent pane      |
| `s`            | Start an automated run bound to the effort        |
| `S`            | Stop all running runs                             |
| `x`            | Stop the selected run's agent and reopen its issue|
| `t`            | Toggle the dependency-tree view                   |
| `r`            | Reload the issue list                             |
| `q`            | Quit                                              |

Mouse works too: click selects, double-click dispatches, wheel moves the cursor.

## Configuration

Optional `herdr-frontier.toml` in two layers, merged repo-over-user (user:
`~/.config/herdr/plugins/config/herdr-frontier.toml`, repo: `<repoRoot>/herdr-frontier.toml`):

```toml
[profiles.grilling]  kind = "claude"   args = ["-m", "sonnet"]
[profiles.research]  kind = "claude"
[profiles.implement] kind = "opencode" args = ["-m", "claude-sonnet-4-5"]
[profiles.prototype] kind = "pi"
[default_profile]    kind = "opencode"
[transcripts]        opencode = "sed -n '1,3p'"
```

Profiles bind an agent + model to each task type; `default_profile` covers the rest. The
`transcripts:` block maps an agent kind to an extraction command run over a finished run's
output, ingested back into the tracker as the issue's resolution.

## License

[MIT](./LICENSE)
