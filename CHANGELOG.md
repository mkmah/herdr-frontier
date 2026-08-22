# herdr-frontier

## 0.4.1

### Patch Changes

- [#13](https://github.com/mkmah/herdr-frontier/pull/13) [`a734f03`](https://github.com/mkmah/herdr-frontier/commit/a734f0399de5c90e92ede74b9d6f3cf2f4bd464c) - Fix: tolerate to-tickets' bold-template issue markdown so `ready-for-agent` tickets dispatch instead of showing "human turn — not auto-dispatched".
  
  - Field lines (`**Status:**`, `**Labels:**`, `**Blocked by:**`) parse with markdown emphasis and file-wide (outside fenced code blocks) — to-tickets writes them below the body's first line
  - A triage-role value on a `Status:` line migrates onto the labels (lifecycle stays `open`); every coercion records a parse warning, surfaced as a dim `⚠` line in the detail pane — never silent
  - `Blocked by: None — can start immediately` reads as unblocked; titled refs ("03 — Title") contribute their numeric prefix
  - Status rewrites (claim/release/close) now canonicalize an emphasized `Status:` line and migrate any role found on it onto `Labels:`, so a released template ticket stays dispatchable
  - Every `/implement {id}` dispatch now carries the TDD mandate ("Every task must be implemented test-first using the /tdd skill.") on the prompt
  - Enter on a resolved ticket reports "already resolved — nothing to dispatch" (new `already-resolved` reason), distinct from `claimed by …`

## 0.4.0

### Minor Changes

- [#11](https://github.com/mkmah/herdr-frontier/pull/11) [`b7e7941`](https://github.com/mkmah/herdr-frontier/commit/b7e79413ec8910569a173b74cfe80762ac9f33be) - Categories and dependency-tree nodes now fold/unfold. In the list view, `Enter`/`Space` on a selected category — or a click on its header — folds it: issue rows hide, the header keeps its full count, the chevron flips `▾`/`▸`, and the cursor clamps onto the header so it never rests on a hidden issue. In the dependency tree, `Space` on a node folds its whole subtree (a leaf's `Space` is a no-op; `Enter` still dispatches), with the same live chevron before the connector. Fold state is session-only in both views — keyed per effort name in the list, per issue id in the tree — so reloads and the ~2s poll keep your arrangement and only a restart resets it.

- [#11](https://github.com/mkmah/herdr-frontier/pull/11) [`b7e7941`](https://github.com/mkmah/herdr-frontier/commit/b7e79413ec8910569a173b74cfe80762ac9f33be) - The list cursor now walks category header rows like ordinary rows — a whole category can be selected as a unit, its summary (name, count, open, your-turn) paints in the detail pane, the four Confirmable verbs no-op on it, and `t` scopes the dependency tree to that category's whole graph.

## 0.3.1

### Patch Changes

- [#9](https://github.com/mkmah/herdr-frontier/pull/9) [`967094b`](https://github.com/mkmah/herdr-frontier/commit/967094b0a50ed2c067671f8f5dd4b3a542194267) - Restructure the source into the standard layered-frontend layout and switch all
  imports to the `#/` path alias. No runtime behavior changes.
  
  - **Layered modules:** the flat `src/` becomes `components/`, `hooks/`, `lib/`,
    and `services/` (each IO/controller module — tracker, herdr, shell, dispatch,
    run, transcripts, config — keeps its folder at its own depth), with a root
    `App.tsx` composition root and `types.ts`.
  - **Thin App:** `App.tsx` no longer owns the data pipeline, selection, verb
    feedback, or keyboard/mouse surfaces inline — those live in the `hooks/`
    modules (`useHerdrData`, `useSelection`, `useVerbs`, `usePointer`, `useKeys`,
    `useIssueDetail`) and the presentational panes moved to `components/`.
  - **`#/` path alias:** `tsconfig` `paths` maps `#/*` → `./src/*` (no `baseUrl`,
    per the TypeScript 6 deprecation), so every import under the project resolves
    by alias instead of relative hops.

## 0.3.0

### Minor Changes

- [#7](https://github.com/mkmah/herdr-frontier/pull/7) [`67247a4`](https://github.com/mkmah/herdr-frontier/commit/67247a45a17d0b1f3b9488ee8ffceab2015177c1) - Add a confirmation gate in front of every action that spends money or rewrites issue
  state, plus the `[confirm]` config table to suppress it per action.
  
  - **Esc no longer quits — `q` is the only quit key.** Every key that used to act
    directly now opens a centered confirmation dialog first: `Enter` (dispatch),
    `x` (stop the selected run), `s` (start an automated run), and `S` (stop all
    runs). Each dialog names exactly what will run (issue `#id` + title, the run-root
    effort, or the in-flight stop tally), with **Confirm** pre-focused, so an action
    is two keys, not one.
  - **Dialog keys:** `←/→`, `j/k`, and `Tab` move focus between Cancel and Confirm,
    `Enter` activates the focused button, and `Esc`/`q` cancel (never quit). Every
    other key is dead while the dialog is open. Mouse parity: buttons activate on
    click; the dim overlay does nothing. Structural no-ops — nothing selected,
    nothing running — never ask.
  - **`[confirm]` config bypass:** `false` is the only off value for a per-action
    gate (`dispatch`, `release`, `run_start`, `run_stop`), so an empty config keeps
    every gate on and there is no in-dialog "don't ask again". Tables merge
    repo-over-user like every other key.

- [#7](https://github.com/mkmah/herdr-frontier/pull/7) [`67247a4`](https://github.com/mkmah/herdr-frontier/commit/67247a45a17d0b1f3b9488ee8ffceab2015177c1) - Deepen the architecture behind the shell — all internal, the UI and keybindings are
  unchanged:
  
  - **The App shell is a deep module (Card 1).** A signal-free `ShellController` owns the
    Confirmable verbs, their confirmation gate, and the load/poll reconcile pipeline;
    App is a thin render adapter over that seam. `request` decides "ask or go", the
    self-describing dialog carries its trigger (no stored pending action), and `confirm`
    runs the verb. The reconcile folds claim-reconcile + dead-dispatch + attention + run
    steps onto one `agent list` read per poll tick.
  - **The tracker owns its id format (Card 2).** `Issue` records now carry adapter-owned
    `effort` / `num` / `order` facts, parsed once by the local-markdown adapter; no policy
    code parses an id anymore. The frontier and run advance sort on the record's `order`,
    run scoping reads the record's `effort`, the display label comes from the record's
    `num`, and the transcript ingester gets its sibling-transcript path from the provider
    instead of splicing the id.
  - **One attention rulebook (Card 4).** The two "needs a human" predicates — the list's
    ☻ marker and the notification toast — are a single `attention(issue, agentStatus)`
    predicate returning a kind: `notify` raises the toast, `human` shows only the marker.
    The display layer and the notification diff consume the same rule, so the marker and
    toast can never drift.

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
