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
import { buildRows } from "#/lib/rows.js";
import { moveCursor } from "#/lib/format.js";
import { buildForest, flattenForest } from "#/lib/tree.js";

export function useSelection(args: {
  issues: () => Issue[];
  loaded: () => boolean;
  error: () => string | null;
  initialView?: AppView;
}) {
  const [view, setView] = createSignal<AppView>(args.initialView ?? "list");
  const [focus, setFocus] = createSignal<Focus>("list");
  const [cursor, setCursor] = createSignal(0);
  const [treeCursor, setTreeCursor] = createSignal(0);
  // Scrollbox refs — auto-scroll the cursor row into view: the list pane's on
  // cursor movement, the tree's on tree-cursor movement (issue 15 / 16).
  let listScroll: any = null;
  let treeScroll: any = null;

  const rows = createMemo(() => buildRows({ issues: args.issues(), loaded: args.loaded(), error: args.error() }));
  const listSelected = () => args.issues()[cursor()];
  // The tree view's pool: the issues of the list-selected issue's effort
  // directory (the run-root's graph lives in `.scratch/<effort>/issues/`;
  // issues.ts reserves "run-root" for the root *issue*, so this is the effort
  // dir, not the root). Rooted on the list cursor, so toggling in and out of
  // the tree never chases the tree cursor around.
  const treeEffort = createMemo(() => listSelected()?.effort ?? "");
  const treePool = createMemo(() => args.issues().filter((i) => i.effort === treeEffort()));
  const treeRows = createMemo(() => flattenForest(buildForest(treePool())));
  const treeSelected = () => treeRows()[treeCursor()]?.issue;
  // The currently selected issue — view-aware, shared by the detail pane, the
  // dispatch/release/run verbs, and the footer. In the list view it is the
  // list cursor; in the tree view the tree cursor over the forest rows.
  const selected = () => (view() === "tree" ? treeSelected() : listSelected());
  // The issues the header's counters describe — all of them in the list view,
  // the tree pool's run-root scope in the tree view.
  const shown = () => (view() === "tree" ? treePool() : args.issues());

  function move(dir: number) {
    setCursor((c) => moveCursor(c, dir, args.issues().length));
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
    const idx = args.issues().findIndex((i) => i.id === id);
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
  createEffect(() => {
    const row = rows()[cursor()];
    if (row && row.kind === "issue" && listScroll) {
      try {
        listScroll.scrollChildIntoView(row.issue.id);
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