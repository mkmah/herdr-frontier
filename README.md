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
herdr plugin install <owner>/herdr-frontier
```

In a repo whose issues live under `.scratch/<feature>/issues/`:

```bash
herdr plugin pane open --plugin herdr-frontier --entrypoint issues --placement split --focus
```

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