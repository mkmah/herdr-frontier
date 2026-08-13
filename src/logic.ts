// Pure presentation logic for the read-only Issue list (issue 09).
//
// Extracted from the Solid component so the interesting behaviour — grouping
// by run-root, triage classification, cursor wrapping — is unit-testable
// without the OpenTUI test harness (whose server renderer is one-shot and
// non-reactive). The component is a thin render layer over these functions.

import type { Issue } from "./tracker/provider.js";

/** Display rows: status messages and group/issue rows, flattened for rendering. */
export type Row =
  | { kind: "error"; message: string }
  | { kind: "empty" }
  | { kind: "group"; root: string; count: number }
  | { kind: "issue"; issue: Issue };

/**
 * The effort an issue belongs to: the `<effort>` directory in its repo-relative
 * id (`.scratch/<effort>/issues/<file>.md`). The issue groups the list "by
 * run-root"; on this substrate that grouping key is the effort directory.
 * (CONTEXT.md reserves "run-root" for the root issue a run is bound to, so we
 * don't borrow the term for the directory.)
 */
export function effortOf(id: string): string {
  const parts = id.split("/");
  return parts[1] ?? "(ungrouped)";
}

/** Short label for an issue: the numeric prefix from its filename, else id tail. */
export function issueNum(id: string): string {
  const file = id.split("/").pop() ?? id;
  const m = file.match(/^(\d+)/);
  return m ? `#${m[1]}` : `#${file.replace(/\.md$/, "")}`;
}

/** The triage role label for an issue (first non-wayfinder label, else needs-triage). */
export function triageOf(issue: Issue): string {
  return issue.labels.find((l) => !l.startsWith("wayfinder:")) ?? "needs-triage";
}

/** Sort issues by run-root then title (stable display order across reloads). */
export function sortIssues(issues: Issue[]): Issue[] {
  return [...issues].sort((a, b) =>
    (effortOf(a.id) + a.title).localeCompare(effortOf(b.id) + b.title),
  );
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
    const root = effortOf(issue.id);
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
 * is matched as a full id first, else by its numeric prefix — but only against
 * issues in the same effort directory, so `"05"` in two efforts can't resolve
 * each other's blockers. An id that resolves to nothing is unresolved.
 */
export function blockerResolved(blockerId: string, issue: Issue, issues: Issue[]): boolean {
  const exact = issues.find((i) => i.id === blockerId);
  if (exact) return exact.status === "resolved";
  const num = issueNum(blockerId);
  const effort = effortOf(issue.id);
  return issues.some(
    (i) => i.status === "resolved" && effortOf(i.id) === effort && issueNum(i.id) === num,
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
