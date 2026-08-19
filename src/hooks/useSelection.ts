// useSelection — the view + cursor state shared by the two panes and every
// selection-driven verb (architecture review 2026-08, layered-frontend layout):
// the primary/secondary view switch (`t`), the list cursor over the grouped
// rows, the tree cursor over the flattened forward-forest rows (issue 15), the
// pane focus (border reflects it), and the derived glossary the rest of the
// shell reads (`selected`, `shown`, `treeEffort`…). Also owns the two panes'
// scrollbox refs and the auto-scroll-into-view effects (issue 15 / 16).
//
// Extracted from App.tsx so the composition root stays a thin wire-up of hooks.

import { createMemo, createSignal, createEffect } from "solid-js";
import type { Issue } from "#/services/tracker/provider.js";
import type { Focus } from "#/lib/display.js";
import type { AppView } from "#/types.js";
import { buildRows, categorySummary, type CategorySummary } from "#/lib/rows.js";
import { moveCursor } from "#/lib/format.js";
import { buildForest, flattenForest } from "#/lib/tree.js";

export function useSelection(args: {
  issues: () => Issue[];
  loaded: () => boolean;
  error: () => string | null;
  initialView?: AppView;
  /** The shell's attention predicate (`attention(i, agent) !== null`) — the
   *  category summary's your-turn count needs live agent state, which the
   *  selection layer doesn't own. */
  isAttention: (issue: Issue) => boolean;
  /** Initial list cursor (test seam — the one-shot renderer can't move it). */
  initialCursor?: number;
}) {
  const [view, setView] = createSignal<AppView>(args.initialView ?? "list");
  const [focus, setFocus] = createSignal<Focus>("list");
  const [cursor, setCursor] = createSignal(args.initialCursor ?? 0);
  const [treeCursor, setTreeCursor] = createSignal(0);
  // Scrollbox refs — auto-scroll the cursor row into view: the list pane's on
  // cursor movement, the tree's on tree-cursor movement (issue 15 / 16).
  let listScroll: any = null;
  let treeScroll: any = null;

  const rows = createMemo(() => buildRows({ issues: args.issues(), loaded: args.loaded(), error: args.error() }));
  // The cursor indexes the visible row list (headers + issues interleaved), so
  // it rests on category headers like ordinary rows. A header's row yields the
  // whole-category selection — no issue. The selection hook owns this
  // re-indexed cursor; every downstream consumer reads `selected()` /
  // `selectedCategory()` / `treeEffort`, never the raw cursor.
  const selectedRow = () => rows()[cursor()];
  const listSelected = () => {
    const row = selectedRow();
    return row?.kind === "issue" ? row.issue : undefined;
  };
  // The category under the cursor — the whole-category selection, distinct from
  // an issue selection. `selected()` stays issue-or-undefined, so every verb and
  // the detail pane's issue branch see "no issue"; this accessor feeds the
  // summary the detail pane mirrors and the tree scoping.
  const selectedCategory = createMemo<CategorySummary | null>(() => {
    // The whole-category selection lives only in the list view — in the tree
    // view the detail pane mirrors the tree-selected node, and the list row
    // under the cursor still scopes the pool (treeEffort) but selects nothing.
    if (view() === "tree") return null;
    const row = selectedRow();
    if (!row || row.kind !== "group") return null;
    return categorySummary(args.issues(), row.root, args.isAttention);
  });
  // The tree view's pool: the issues of the list-selected row's effort
  // directory (the run-root's graph lives in `.scratch/<effort>/issues/`;
  // issues.ts reserves "run-root" for the root *issue*, so this is the effort
  // dir, not the root). Rooted on the list cursor, so toggling in and out of
  // the tree never chases the tree cursor around. A category selection scopes
  // the pool to that whole category's graph.
  const treeEffort = createMemo(() => {
    const row = selectedRow();
    if (!row || row.kind === "error" || row.kind === "empty") return "";
    return row.kind === "group" ? row.root : row.issue.effort;
  });
  const treePool = createMemo(() => args.issues().filter((i) => i.effort === treeEffort()));
  const treeRows = createMemo(() => flattenForest(buildForest(treePool())));
  const treeSelected = () => treeRows()[treeCursor()]?.issue;
  // The currently selected issue — view-aware, shared by the detail pane, the
  // dispatch/release/run verbs, and the footer. In the list view it is the
  // list cursor; in the tree view the tree cursor over the forest rows. A
  // category selection yields undefined here (no issue) — the verbs no-op on it
  // exactly as they do on an empty selection.
  const selected = () => (view() === "tree" ? treeSelected() : listSelected());
  // The issues the header's counters describe — all of them in the list view,
  // the tree pool's run-root scope in the tree view.
  const shown = () => (view() === "tree" ? treePool() : args.issues());

  function move(dir: number) {
    setCursor((c) => moveCursor(c, dir, rows().length));
  }

  // The tree view's cursor moves over the flattened forest rows (issue 15).
  function treeMove(dir: number) {
    setTreeCursor((c) => moveCursor(c, dir, treeRows().length));
  }

  // `t` toggles between the primary list and the dependency tree (issue 15).
  // Entering the tree starts at its first row; the list cursor is untouched so
  // returning lands back where you were.
  function toggleView() {
    const next = view() === "list" ? "tree" : "list";
    setView(next);
    if (next === "tree") setTreeCursor(0);
  }

  /** Back to the top of both lists (a fresh load's `r` starts at row 0). */
  function resetCursors() {
    setCursor(0);
    setTreeCursor(0);
  }

  function selectById(id: string) {
    // id is always an issue id (the pointer never selects a header yet); map it
    // onto the visible row list — headers now occupy row indexes too, so an
    // issue's flat-array index would point at the wrong row.
    const idx = rows().findIndex((r) => r.kind === "issue" && r.issue.id === id);
    if (idx >= 0) setCursor(idx);
  }

  function selectTreeById(id: string) {
    const idx = treeRows().findIndex((r) => r.issue.id === id);
    if (idx >= 0) setTreeCursor(idx);
  }

  // Keep the tree cursor inside the (possibly shrinking) forest as the poll
  // refresh changes the rows, and auto-scroll the cursor row into view.
  createEffect(() => {
    const n = treeRows().length;
    setTreeCursor((c) => Math.min(c, Math.max(0, n - 1)));
  });
  // Auto-scroll the tree cursor into view (issue 15). Reads the row *and* its
  // depth so a poll that keeps the selected id but shifts its row re-scrolls.
  createEffect(() => {
    const row = treeRows()[treeCursor()];
    if (row && treeScroll) {
      try {
        treeScroll.scrollChildIntoView(row.issue.id);
      } catch {
        // best-effort — a scrollbox quirk must not break cursor movement
      }
    }
  });
  // Auto-scroll the list cursor into view (issue 16) — the list pane's rows
  // can outgrow the pane, so the cursor follows selection, wheel, and mouse.
  // Group headers carry a stable `group:<root>` id so a category selection
  // scrolls its header into view too.
  createEffect(() => {
    const row = rows()[cursor()];
    if (!row || !listScroll) return;
    const id = row.kind === "issue" ? row.issue.id : row.kind === "group" ? `group:${row.root}` : null;
    if (id) {
      try {
        listScroll.scrollChildIntoView(id);
      } catch {
        // best-effort — a scrollbox quirk must not break cursor movement
      }
    }
  });

  return {
    view,
    focus,
    setFocus,
    rows,
    cursor,
    treeCursor,
    selected,
    selectedCategory,
    shown,
    treeEffort,
    treePool,
    treeRows,
    move,
    treeMove,
    toggleView,
    resetCursors,
    selectById,
    selectTreeById,
    listScrollRef: (el: any) => (listScroll = el),
    treeScrollRef: (el: any) => (treeScroll = el),
  };
}