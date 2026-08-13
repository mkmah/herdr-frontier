# Tracker-provider interface

**Status:** accepted

herdr-beads must orchestrate tickets across multiple trackers (local-markdown now;
beads/GitHub/Jira/Linear later) without the orchestrator knowing which tracker is behind
it. We decide the shape of that seam: one async `TrackerProvider` interface in `src/tracker/`,
with one adapter per tracker, behind which all tracker-specific complexity hides. The
orchestrator speaks a single domain vocabulary — `Issue` records and canonical labels — and
never downcasts to a backend.

## Decision

A **deep, narrow interface** — 7 verbs — where the read side collapses into one materialized
record and only the write side stays factored into distinct operations.

```ts
// src/tracker/provider.ts
export type IssueStatus = 'open' | 'claimed' | 'resolved';
export type IssueType   = 'research' | 'prototype' | 'grilling' | 'task';

// Low-res record — enough to compute the frontier, no heavy text.
export interface Issue {
  id: string;                  // opaque, unique within THIS provider.
                               // local-markdown: repo-relative file path
                               // beads: native id; GitHub: number; Jira: key; Linear: UUID
  title: string;
  status: IssueStatus;
  type: IssueType;
  labels: string[];            // canonical vocab: 5 triage roles + wayfinder:*
  assignee: string | null;     // claim owner; null = unclaimed
  blockedBy: string[];         // ids this issue waits on
}

// Zoom record — full body + history, only from readIssue.
export interface IssueDetail extends Issue {
  body: string;
  comments: Comment[];
}
export interface Comment { author?: string; body: string }

export interface IssueFilter { status?: IssueStatus; labels?: string[]; title?: string }

export interface TrackerProvider {
  listIssues(filter?: IssueFilter): Promise<Issue[]>;            // low-res; no bodies
  readIssue(id: string): Promise<IssueDetail>;                  // zoom one
  claim(id: string): Promise<Issue>;                            // mutex intent
  updateLabels(id: string, add?: string[], remove?: string[]): Promise<Issue>;
  close(id: string, resolution: string): Promise<Issue>;        // resolve + post answer
  comment(id: string, body: string): Promise<Issue>;            // non-terminal talk
  addBlocking(id: string, blockerIds: string[]): Promise<Issue>; // dep edge
}
```

Errors are typed and thrown, each documented on the verb it can arise from:
`IssueNotFound`, `LabelNotInMap`, `BlockingNotSupported`.

## Key trade-offs (each was a real decision)

- **`query-frontier` is demoted out of the provider.** No tracker has a native
  "open ∧ unblocked ∧ unclaimed" concept (research: ticket 03); every tracker would fake it
  the same way. The provider exposes a simple `listIssues`; the orchestrator computes the
  frontier by filtering. Frontier is *policy* (which issues are claimable now), not a
  *storage* fact, so it lives in the one place that cares — the orchestrator — and every
  adapter stays simpler.
- **Read-verbs collapse into the `Issue` record.** `labels`, `blocking`, `status`, `type`,
  `assignee` are fields on an issue, not separate capabilities. Only write-verbs stay
  distinct. This is the depth win: all read-complexity hides behind one materialized record.
- **List/zoom body split.** `listIssues` returns `Issue` without `body`/`comments`; only
  `readIssue` returns full `IssueDetail`. Mirrors how a wayfinder map is actually read
  (scan low-res to find the frontier, then zoom one issue), and keeps `listIssues` cheap on
  remote trackers (one paginated fetch returns status+labels+assignee+relations).
- **`claim` is first-class.** On every remote tracker, assignee = claim with no server-enforced
  mutex (ticket 03); only local-markdown serializes. `claim` expresses mutex *intent* and
  mutates state on every tracker, so it earns a named verb. Cross-session coordination itself
  stays orchestrator-level.
- **`close` ⊕ `post-resolution` merged** into `close(id, resolution)`: set terminal state and
  attach the answer in one call. `comment` stays separate (non-terminal conversation).
- **`id` is opaque per-provider.** The orchestrator never parses it; `{id}`→path/dispatch
  resolution stays a plugin responsibility (per map Notes).

## Local-markdown label model (Option C)

local-markdown has no first-class `labels[]`. We add a canonical **`Labels:`** line near the
top of each issue file carrying the 5 triage roles (`needs-triage` / `needs-info` /
`ready-for-agent` / `ready-for-human` / `wontfix`) plus the `wayfinder:*` namespace,
comma-separated. The provider reads **only** `Labels:`; `Status:` (lifecycle) and `Type:`
(ticket-type) stay separate for human readability and are not re-parsed for labels. A missing
`Labels:` line reads as `needs-triage` (matches the map's unlabeled → needs-triage rule).

## Label-vocabulary reconciliation

The 5 triage roles + `wayfinder:*` are herdr-beads's **canonical vocabulary** and are the only
labels the orchestrator ever sees. Each adapter carries a **label-map** config translating
canonical ↔ native strings (a Jira "ready-for-agent" might be spelled `rf-agent`); the adapter
maps on read and write. Remote trackers' native `labels[]` are an adapter-internal detail.

## Considered options

- _Keep `query-frontier` in the provider._ Rejected: duplicates the client-side compound in
  every adapter and pushes orchestration policy past the seam.
- _Generic `set-assignee` instead of `claim`._ Rejected: loses the named mutex intent that the
  shared manual/automated claim path (map #5) depends on.
- _Always return full bodies from `listIssues`._ Rejected: pays for text the orchestrator
  usually discards; heavy on remote trackers.
- _Synthesize local-markdown labels from `Status:`/`Type:` (Option B)._ Rejected: still can't
  represent the 5 triage roles and couples the provider to drifting layout heuristics.

## Consequences

- The orchestrator depends only on `TrackerProvider`; adding a tracker is one new adapter, no
  orchestrator change.
- Frontier recomputation is O(open issues) per scan on remote trackers — acceptable at
  wayfinder-scale (the reference plugin polls ~2s). If that ever bites, `listIssues` can grow a
  smarter server-side filter without changing the verb set.
- local-markdown issue files gain a `Labels:` line (format change, applied to new issues; the
  missing-line ⇒ `needs-triage` rule keeps old files valid).
