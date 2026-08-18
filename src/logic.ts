// Pure presentation logic for the read-only Issue list (issue 09).
//
// Extracted from the Solid component so the interesting behaviour — grouping
// by run-root, triage classification, cursor wrapping — is unit-testable
// without the OpenTUI test harness (whose server renderer is one-shot and
// non-reactive). The component is a thin render layer over these functions.

import type { Issue } from "./tracker/provider.js";
import type { AgentStatus } from "./herdr-client.js";

/** Display rows: status messages and group/issue rows, flattened for rendering. */
export type Row =
  | { kind: "error"; message: string }
  | { kind: "empty" }
  | { kind: "group"; root: string; count: number }
  | { kind: "issue"; issue: Issue };

// --- attention rulebook (Card 4) -------------------------------------------
// The single shared definition of "needs a human" — label state (the triage
// role) PLUS agent state (a blocked dispatched agent). One predicate, consumed
// by both the display layer (the ☻ marker) and the notification diff (the
// toast); they differ by the returned kind, never by a separate membership test.

/** The canonical labels that mean "a human must look at this" (CONTEXT.md: attention). */
export const HUMAN_ROLES: ReadonlySet<string> = new Set(["ready-for-human", "needs-info", "needs-triage"]);

/** The human labels that also raise a herdr notification (issue 13). */
const NOTIFY_LABELS: ReadonlySet<string> = new Set(["ready-for-human"]);

/**
 * What an issue needs from a human right now:
 *  - `"notify"` — a `ready-for-human` triage role, or a dispatched agent that
 *    went `blocked`: shows the pulsing ☻ marker AND raises the toast
 *    (CONTEXT.md: Attention lane — label state PLUS agent state).
 *  - `"human"` — the inline ☻ marker only (`needs-info` / `needs-triage` are
 *    attention-lane but never raise a notification, spec.md:234).
 *  - `null` — no human needed.
 *
 * `issue` is null when only an agent state is in hand (an issue id without its
 * record, e.g. an orphan pane); the blocked path still fires.
 */
export function attention(issue: Issue | null, agentStatus?: AgentStatus): "human" | "notify" | null {
  if (agentStatus === "blocked") return "notify";
  if (!issue) return null;
  const label = triageOf(issue);
  if (NOTIFY_LABELS.has(label)) return "notify";
  if (HUMAN_ROLES.has(label)) return "human";
  return null;
}

/** The row's short `#id` label — read from the record's adapter-owned `num`,
 *  never parsed here (Card 2). */
export function issueLabel(issue: Issue): string {
  return `#${issue.num}`;
}

/**
 * Match a tracker-supplied blocker ref (a full id or a bare numeric prefix like
 * `"05"`) to its short `#label`. Refs arrive from the tracker as raw strings,
 * so this one id-format rule lives on the policy side — the adapter could fully
 * resolve refs at parse time (a future seam test); policy still compares by
 * label.
 */
export function refLabel(ref: string): string {
  const file = ref.split("/").pop() ?? ref;
  const digits = file.match(/^(\d+)/)?.[1];
  return digits ? `#${digits}` : `#${file.replace(/\.md$/, "")}`;
}

/** The triage role label for an issue (first non-wayfinder label, else needs-triage). */
export function triageOf(issue: Issue): string {
  return issue.labels.find((l) => !l.startsWith("wayfinder:")) ?? "needs-triage";
}

/** Sort issues by run-root then title (stable display order across reloads). */
export function sortIssues(issues: Issue[]): Issue[] {
  return [...issues].sort((a, b) => (a.effort + a.title).localeCompare(b.effort + b.title));
}

export interface RowsState {
  issues: Issue[];
  loaded: boolean;
  error: string | null;
}

/**
 * Build the flat render list: an error row, an empty row, or group headers
 * interleaved with issue rows (sorted by run-root). Each top-level row maps to
 * exactly one element so the scrollbox only ever holds real renderables.
 */
export function buildRows(state: RowsState): Row[] {
  if (state.error) return [{ kind: "error", message: state.error }];
  if (state.loaded && state.issues.length === 0) return [{ kind: "empty" }];
  const out: Row[] = [];
  let current = "";
  let currentGroup: Extract<Row, { kind: "group" }> | null = null;
  for (const issue of state.issues) {
    const root = issue.effort;
    if (root !== current) {
      current = root;
      currentGroup = { kind: "group", root, count: 0 };
      out.push(currentGroup);
    }
    currentGroup!.count++;
    out.push({ kind: "issue", issue });
  }
  return out;
}

/**
 * Is a blockedBy id resolved for `issue`, per the loaded issue set? A blocker id
 * is matched as a full id first, else by its `refLabel` — but only against
 * issues in the same effort directory, so `"05"` in two efforts can't resolve
 * each other's blockers. An id that resolves to nothing is unresolved.
 */
export function blockerResolved(blockerId: string, issue: Issue, issues: Issue[]): boolean {
  const exact = issues.find((i) => i.id === blockerId);
  if (exact) return exact.status === "resolved";
  const num = refLabel(blockerId);
  return issues.some(
    (i) => i.status === "resolved" && i.effort === issue.effort && issueLabel(i) === num,
  );
}

/** Move a cursor by `dir` over `count` items, clamped and wrapping. */
export function moveCursor(cursor: number, dir: number, count: number): number {
  if (count <= 0) return 0;
  return ((cursor + dir) % count + count) % count;
}

export function trunc(s: string, n: number): string {
  if (n <= 0) return "";
  return s.length <= n ? s : n <= 1 ? "…" : s.slice(0, n - 1) + "…";
}

/**
 * The width budget left for a row's title after every non-collapsing segment
 * is reserved at full width (issue 16). `innerW` is the pane's inner content
 * width (border + row padding already removed); the segments a row must never
 * let squeeze — the state glyph (+ its trailing space), `#id`, tasks ratio, and
 * age (each with its leading space), plus the tree's branch connector and depth
 * padding — are all flexShrink:0, so the only thing that gives is the title,
 * truncated to this budget. The budget is floored at 0: a narrow pane truncates
 * the title to nothing rather than wrap the row to a second line.
 */
export interface RowTitleBudgetInput {
  innerW: number;
  /** Length of the tree branch connector (`"└─ "` = 3), 0 for the list. */
  branchLen: number;
  /** Rendered `#id` length (e.g. `"#09"` = 3). */
  idLen: number;
  /** Rendered tasks ratio length (`"2/4"` = 3), 0 when the issue has no tasks. */
  tasksLen: number;
  /** Rendered age length (`"5h"` = 2), 0 when the issue has no updatedAt. */
  ageLen: number;
  /** Tree depth: the row's left padding grows by `depth * 2`. */
  depth: number;
}

export function rowTitleBudget(b: RowTitleBudgetInput): number {
  const fixed =
    2 + // state glyph + its trailing space
    b.idLen +
    2 + // the two spaces before the title
    (b.tasksLen ? b.tasksLen + 1 : 0) + // tasks ratio + its leading space
    (b.ageLen ? b.ageLen + 1 : 0) + // age + its leading space
    b.branchLen;
  return Math.max(0, b.innerW - fixed - b.depth * 2);
}
