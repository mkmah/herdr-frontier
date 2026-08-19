// The flat render list the primary shell paints — grouped by run-root
// (the effort directory), interleaved with group headers. Pure.

import type { Issue } from "#/services/tracker/provider.js";

/** Display rows: status messages and group/issue rows, flattened for rendering. */
export type Row =
  | { kind: "error"; message: string }
  | { kind: "empty" }
  | { kind: "group"; root: string; count: number }
  | { kind: "issue"; issue: Issue };

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