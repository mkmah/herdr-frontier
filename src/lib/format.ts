// Pure UI math that the render layer feeds its rows: cursor wrapping, title
// truncation, and the width budget a row's title may occupy. No IO, no render —
// the derivations the list/tree panes unit-test without the OpenTUI harness.

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