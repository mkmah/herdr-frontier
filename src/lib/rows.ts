// The flat render list the primary shell paints — grouped by run-root
// (the effort directory), interleaved with group headers. Pure.

import type { Issue } from "#/services/tracker/provider.js";

/** Display rows: status messages and group/issue rows, flattened for rendering. */
export type Row =
  | { kind: "error"; message: string }
  | { kind: "empty" }
  /** The category header row — `folded` is the live chevron state the render
   *  layer paints (`▾` expanded / `▸` folded); `count` always counts ALL of the
   *  category's issues, folded or not. */
  | { kind: "group"; root: string; count: number; folded: boolean }
  | { kind: "issue"; issue: Issue };

export interface RowsState {
  issues: Issue[];
  loaded: boolean;
  error: string | null;
}

/** The summary the detail pane mirrors when a whole category is selected —
 *  the group header's facts (name + full count) plus open/your-turn counts,
 *  so a category selection shows what's inside instead of a blank. */
export interface CategorySummary {
  root: string;
  count: number;
  open: number;
  yourTurn: number;
}

/** The detail-pane summary for one category (effort directory): every issue
 *  under it, of which `open` are still open and `yourTurn` need a human right
 *  now (the caller passes its attention predicate — the shell owns agent
 *  state). `count` mirrors the header: all of the category's issues. */
export function categorySummary(
  issues: Issue[],
  root: string,
  isAttention: (issue: Issue) => boolean,
): CategorySummary {
  const pool = issues.filter((i) => i.effort === root);
  return {
    root,
    count: pool.length,
    open: pool.filter((i) => i.status === "open").length,
    yourTurn: pool.filter((i) => isAttention(i)).length,
  };
}

/** The scrollbox row id a category header carries — stable across folds so the
 *  scrollbox's `scrollChildIntoView` and the pointer's double-click tracker can
 *  name a header without parsing its row (shared by the render and the two
 *  behavior layers). The `group:` prefix keeps the id off the issue-id
 *  namespace (a header id can never collide with an issue id). */
export function groupId(root: string): string {
  return `group:${root}`;
}

/**
 * Build the flat render list: an error row, an empty row, or group headers
 * interleaved with issue rows (sorted by run-root). Each top-level row maps to
 * exactly one element so the scrollbox only ever holds real renderables.
 *
 * The fold-aware derivation (collapsible-categories 02): a category whose root
 * is in `collapsed` keeps its header row (with its full count + folded flag)
 * but drops its issue rows — the visible list IS the navigation pool, so a
 * hidden issue is unreachable by construction. The header's count still counts
 * every one of the category's issues, folded or not.
 */
export function buildRows(state: RowsState, collapsed: ReadonlySet<string> = new Set()): Row[] {
  if (state.error) return [{ kind: "error", message: state.error }];
  if (state.loaded && state.issues.length === 0) return [{ kind: "empty" }];
  const out: Row[] = [];
  let current = "";
  let currentGroup: Extract<Row, { kind: "group" }> | null = null;
  for (const issue of state.issues) {
    const root = issue.effort;
    if (root !== current) {
      current = root;
      currentGroup = { kind: "group", root, count: 0, folded: collapsed.has(root) };
      out.push(currentGroup);
    }
    currentGroup!.count++;
    if (!currentGroup!.folded) out.push({ kind: "issue", issue });
  }
  return out;
}