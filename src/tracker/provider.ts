// Tracker-provider interface — the deep, narrow seam (ADR-0001).
//
// One async `TrackerProvider` interface, one adapter per tracker, behind which
// all tracker-specific complexity hides. The orchestrator speaks only this
// domain vocabulary (`Issue` records + canonical labels) and never downcasts
// to a backend. The read side collapses into one materialized record; only the
// write side stays factored into distinct verbs.

/** Lifecycle of an issue. */
export type IssueStatus = "open" | "claimed" | "resolved";

/** The kind of work an issue represents. */
export type IssueType = "research" | "prototype" | "grilling" | "task";

/**
 * Low-res record — enough to compute the frontier, no heavy text.
 * `id` is opaque and unique within THIS provider:
 *   - local-markdown: repo-relative file path
 *   - beads: native id; GitHub: number; Jira: key; Linear: UUID
 */
export interface Issue {
  id: string;
  /** The effort directory this issue belongs to — the grouping key the list's
   *  run-root headers are built from. Adapter-owned: the tracker parses its own
   *  id format once and fills this; policy never parses the id (ADR-0001). */
  effort: string;
  /** The issue's short-id label WITHOUT the `#` (the filename's numeric prefix,
   *  e.g. `"09"`, else the filename stem) — the `#id` rows show and the key
   *  blocker refs match against. Adapter-owned. */
  num: string;
  /** The numeric sort order — the numeric prefix of the id's filename as a
   *  number, or `Number.MAX_SAFE_INTEGER` when there is none (sorts last).
   *  The frontier's stable first-by-number order. Adapter-owned. */
  order: number;
  title: string;
  status: IssueStatus;
  type: IssueType;
  /** Canonical vocab: the 5 triage roles + `wayfinder:*`. */
  labels: string[];
  /** Claim owner; null = unclaimed. */
  assignee: string | null;
  /** ids this issue waits on. */
  blockedBy: string[];
  /** Sub-task tally for the row's progress column (ghui-style display). */
  tasks?: TaskTally;
  /** Last-modified epoch ms — drives the row/detail age column. */
  updatedAt?: number;
}

/** Count of done vs total sub-tasks on an issue (e.g. markdown checkboxes). */
export interface TaskTally {
  done: number;
  total: number;
}

/** Zoom record — full body + history, only from `readIssue`. */
export interface IssueDetail extends Issue {
  body: string;
  comments: Comment[];
}

export interface Comment {
  author?: string;
  body: string;
}

export interface IssueFilter {
  status?: IssueStatus;
  /** Canonical labels; an issue matches if it carries ALL of them. */
  labels?: string[];
  /** Substring match against the title. */
  title?: string;
}

/**
 * 7 verbs. The read side (`listIssues` / `readIssue`) is one materialized
 * record; the write side stays factored. Errors are typed and thrown — each is
 * documented on the verb that can raise it.
 */
export interface TrackerProvider {
  /** Low-res; no bodies. */
  listIssues(filter?: IssueFilter): Promise<Issue[]>;
  /** Zoom one. Throws {@link IssueNotFound}. */
  readIssue(id: string): Promise<IssueDetail>;
  /** Mutex intent. */
  claim(id: string): Promise<Issue>;
  /** Release a claim — the inverse of {@link claim}: reset status to `open`
   *  (idempotent on an already-open issue). Used to stop/reopen in-flight work. */
  release(id: string): Promise<Issue>;
  /** Throws {@link LabelNotInMap} when a label is not in the adapter's map. */
  updateLabels(id: string, add?: string[], remove?: string[]): Promise<Issue>;
  /** Resolve + post answer in one call. */
  close(id: string, resolution: string): Promise<Issue>;
  /** Non-terminal talk. */
  comment(id: string, body: string): Promise<Issue>;
  /** Dep edge. Throws {@link BlockingNotSupported}. */
  addBlocking(id: string, blockerIds: string[]): Promise<Issue>;
}

/** `readIssue` on an id no record exists for. */
export class IssueNotFound extends Error {
  constructor(public readonly id: string) {
    super(`Issue not found: ${id}`);
    this.name = "IssueNotFound";
  }
}

/** `claim` on an issue that is not open (already claimed by another dispatcher). */
export class AlreadyClaimed extends Error {
  constructor(
    public readonly id: string,
    public readonly status: IssueStatus,
  ) {
    super(`Issue already claimed: ${id} (status: ${status})`);
    this.name = "AlreadyClaimed";
  }
}

/** `claim`'s exclusive lock could not be acquired in time (contended/stale). */
export class ClaimBusy extends Error {
  constructor(public readonly id: string) {
    super(`Claim mutex busy: ${id}`);
    this.name = "ClaimBusy";
  }
}

/** A canonical label has no mapping in the adapter's label-map. */
export class LabelNotInMap extends Error {
  constructor(public readonly label: string) {
    super(`Label not in label-map: ${label}`);
    this.name = "LabelNotInMap";
  }
}

/** The adapter cannot represent blocking edges (e.g. a tracker with no deps). */
export class BlockingNotSupported extends Error {
  constructor() {
    super("Blocking not supported by this tracker");
    this.name = "BlockingNotSupported";
  }
}
