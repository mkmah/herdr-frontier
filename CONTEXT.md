# herdr-frontier

A `herdr` plugin (OpenTUI/Solid render layer) that orchestrates the Matt Pocock skill
workflow across a dependency graph of issues, on a multi-tracker substrate.

## Distribution & release

Installed via `herdr plugin install mkmah/herdr-frontier`, which runs the `[[build]]`
steps (preflight → production install → compile) on the user's machine; the compiled
binary needs no Bun at runtime. Version lives only in `herdr-plugin.toml`, bumped by
semantic-release from conventional commits. See ADR-0002.

## Language

**Issue**:
A single unit of trackable work — a ticket, task, or decision — uniquely identified within a tracker provider.
_Avoid_: Ticket (the domain record crossing the provider seam is `Issue`; "ticket" lingers in prose and the wayfinder skill but means the same thing), Card, Item.

**Tracker provider**:
The deep module (`TrackerProvider` interface, one adapter per tracker) behind which all tracker-specific access hides. The orchestrator speaks only its domain vocabulary and never knows which tracker (local-markdown, beads, GitHub, Jira, Linear) is behind it.
_Avoid_: Backend, Source, Integration.

**Adapter**:
A concrete implementation of `TrackerProvider` for one tracker (e.g. the local-markdown adapter). Tracker-specific details — file parsing, native label strings, link directions — live here and never cross the seam.
_Avoid_: Connector, Driver.

**Frontier**:
The set of issues that are claimable right now: `open ∧ unclaimed ∧ all-blockers-resolved`. Not a tracker concept — computed by the orchestrator by filtering `listIssues`.
_Avoid_: Queue, Backlog, Ready list.

**Claim**:
The mutex intent that marks an issue as taken so concurrent dispatchers (manual or automated) don't double-launch it. First-class provider verb; the cross-session coordination around it is orchestrator-level.
_Avoid_: Assign (assignee is how a tracker records a claim, not the intent itself), Lock.

**Label-map**:
Per-adapter config translating the canonical label vocabulary (the 5 triage roles + `wayfinder:*`) to and from a tracker's native label strings. The orchestrator only ever sees canonical labels.
_Avoid_: Label table, Translation.

**Run**:
A controller bound to a run-root that walks the dependency graph, spawning each issue as its blockers clear. Distinct from manual single-issue launch.
_Avoid_: Job, Pipeline.

**Run-root**:
The root issue a run is bound to — a `wayfinder:map`, a spec, or a to-tickets set — from which the run walks the graph.
_Avoid_: Entry point, Seed.

**Dispatch**:
The act of sending one issue to one herdr pane via the right agent+model for its task type.
_Avoid_: Launch (launch is the herdr mechanism; dispatch is the policy that picks the agent/model).

**Profile**:
A `{ kind, args }` agent configuration bound per task-type (grilling / research / implement / prototype), with model passed in raw `args`. Precedence: repo > user.
_Avoid_: Config, Agent template.

**Attention lane**:
The single cross-tracker "your turn" view — label state plus agent state — that surfaces `ready-for-human` and agent-`blocked` issues.
_Avoid_: Inbox, Notification feed.

**Transcript**:
A finished run's output, ingested back into the tracker as resolution/notes via a plugin-defined extractor over herdr snapshots (herdr exposes no extractor contract of its own).
_Avoid_: Log, Output dump.

**Confirmable action**:
An action that spawns or kills a herdr agent or rewrites issue status, so it requires a confirmation gate before it executes — dispatch, release, run-start, and run-stop. Navigation, reload, and quit never confirm. The gate is the default (Confirm is the pre-focused button, Esc cancels); it is bypassable per action by a `[confirm]` config table (repo over user precedence), never by an in-modal toggle.
_Avoid_: Destructive action, Confirmation prompt.
