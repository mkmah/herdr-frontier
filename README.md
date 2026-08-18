# herdr-frontier

A **herdr** plugin that shows your issue graph at a glance and advances it for you. It
orchestrates the Matt Pocock skill workflow (`wayfinder` → `grill-with-docs` → `to-spec` →
`to-tickets` → `implement` → `triage`) across a dependency graph of issues, on any tracker
you keep issues in.

Built on [OpenTUI](https://github.com/anomalyco/opentui) with SolidJS, it runs as one herdr
pane: a two-pane list + detail shell, a toggleable dependency tree, live agent state, a
shared claim mutex so manual and automated launches never double-start an issue, and a
confirmation gate so no agent starts or run is torn down on a single keystroke.

## Trackers

- **local-markdown** — `.scratch/<feature>/issues/` — built today.
- **beads / GitHub / Jira / Linear** — designed-for behind the same `TrackerProvider`
  interface (ADR-0001); not built yet. Adding one is a new adapter + label-map.

## Install

You need [herdr](https://herdr.dev) 0.8.0 or later. Bun is required only at install time
(the plugin compiles itself on your machine); the resulting binary runs with no Bun.

```bash
herdr plugin install mkmah/herdr-frontier --ref v0.2.0
```

> The `--ref` pins the checkout to a git tag, so an install is always a known-good
> revision. To pull a fix or feature, reinstall the tags set (the plugin id is
> unchanged, so your `herdr-frontier` keybindings in `config.toml` keep working).
> If the pane opened and closed instantly on the first 0.1.0 build, that was a
> shipped `bunfig.toml` the compiled binary re-reads and dies on — update to the
> fixed release:
>
> ```bash
> herdr plugin uninstall herdr-frontier
> herdr plugin install mkmah/herdr-frontier --ref v0.2.0
> ```

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
pane, `s` to start an automated run bound to the current effort. Each of those acts first
confirms — nothing spawns an agent on a single keypress (see below).

## Ways to work

| Key            | What it does                                      |
| -------------- | ------------------------------------------------- |
| `Tab`          | Move focus between the list and the detail pane   |
| `j` / `k`      | Move the selection                                |
| `Enter`        | Confirm-and-dispatch the selected issue           |
| `s`            | Confirm-and-start an automated run                |
| `S`            | Confirm-and-stop all running runs                 |
| `x`            | Confirm-and-stop the selected run                |
| `t`            | Toggle the dependency-tree view                   |
| `r`            | Reload the issue list                             |
| `q`            | Quit (the only quit key — `Esc` never quits)      |

`Enter`, `x`, `s`, and `S` are **Confirmable actions**: before anything runs, each opens a
centered confirmation dialog naming exactly what will happen (which issue, which effort's
run, how many runs will stop), with **Confirm** pre-focused. An action is two keys, not one:

| Modal key                     | What it does                              |
| ----------------------------- | ----------------------------------------- |
| `Enter`                       | Activate the focused button               |
| `←` / `→`, `j` / `k`, `Tab`   | Move focus between Cancel and Confirm     |
| `Esc` / `q`                   | Cancel — never quit                       |

While the dialog is open every other key is dead (swallowed), and clicking a button
activates it while clicking the dim overlay does nothing. Suppress a gate per action with
the `[confirm]` config table below; a structural no-op — nothing selected, nothing running —
never asks.

Mouse works too: click selects, double-click dispatches (through the same confirmation as
`Enter`), wheel moves the cursor.

## Configuration

Optional `herdr-frontier.toml` in two layers, merged repo-over-user (user:
`~/.config/herdr/plugins/config/herdr-frontier.toml`, repo: `<repoRoot>/herdr-frontier.toml`):

```toml
[profiles.grilling]
kind             = "claude"
args             = ["-m", "sonnet"]
[profiles.research]
kind             = "claude"
[profiles.implement]
kind             = "opencode"
args             = ["-m", "claude-sonnet-4-5"]
[profiles.prototype]
kind             = "pi"
[default_profile]
kind             = "opencode"
[transcripts]
opencode         = "sed -n '1,3p'"

[confirm]
dispatch         = false
release          = false
run_start        = false
run_stop         = false
```

Profiles bind an agent + model to each task type; `default_profile` covers the rest. The
`transcripts:` block maps an agent kind to an extraction command run over a finished run's
output, ingested back into the tracker as the issue's resolution.

`[confirm]` sits in front of the four Confirmable actions: a per-action `false` skips that
action's confirmation dialog (a structural no-op already never asks). `false` is the only
"off" value — absent and `true` both mean confirm, so a config with no `[confirm]` table
keeps every gate on, and there is no in-dialog bypass: config is the only way to suppress a
gate. Tables merge repo-over-user exactly like the keys above, and edits apply at the next
launch.

## License

[MIT](./LICENSE)
