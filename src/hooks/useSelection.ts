// useSelection — the view + cursor state shared by the two panes and every
// selection-driven verb (architecture review 2026-08, layered-frontend layout):
// the primary/secondary view switch (`t`), the list cursor over the grouped
// rows, the tree cursor over the flattened forward-forest rows (issue 15), the
// pane focus (border reflects it), the session-only collapse set that drives
// the fold-aware visible row list (collapsible-categories 02), and the derived
// glossary the rest of the shell reads (`selected`, `shown`, `treeEffort`…).
// Also owns the two panes' scrollbox refs and the auto-scroll-into-view
// effects (issue 15 / 16).
//
// Extracted from App.tsx so the composition root stays a thin wire-up of hooks.

import { createMemo, createSignal, createEffect } from "solid-js";
import type { Issue } from "#/services/tracker/provider.js";
import type { Focus } from "#/lib/display.js";
import type { AppView } from "#/types.js";
import { buildRows, categorySummary, groupId, type CategorySummary, type Row } from "#/lib/rows.js";
import { moveCursor } from "#/lib/format.js";
import { buildForest, foldForest } from "#/lib/tree.js";

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
  /** Categories folded on first render (test seam) — production starts with
   *  every category expanded (collapsible-categories 02). */
  initialCollapsed?: string[];
  /** Tree nodes folded on first render (test seam) — the one-shot renderer
   *  can't press Space, so the tree smokes seed the fold set (production starts
   *  with every node expanded — collapsible-categories 03). */
  initialTreeCollapsed?: string[];
}) {
  const [view, setView] = createSignal<AppView>(args.initialView ?? "list");
  const [focus, setFocus] = createSignal<Focus>("list");
  const [cursor, setCursor] = createSignal(args.initialCursor ?? 0);
  const [treeCursor, setTreeCursor] = createSignal(0);
  // The session-only collapse set, keyed by effort name (collapsible-categories
  // 02): every category starts expanded, `r` reload and the ~2s poll touch only
  // the issues signal, so fold state survives them; only a process restart
  // (this signal's birth) resets it.
  const [collapsed, setCollapsed] = createSignal<Set<string>>(new Set(args.initialCollapsed ?? []));
  // The tree view's session-only fold set, keyed per issue id
  // (collapsible-categories 03): every node starts expanded, `r` reload and the
  // ~2s poll touch only the issues signal, so fold state survives them; only a
  // process restart (this signal's birth) resets it. Keyed per issue id so
  // switching categories never spills one tree's folds into another.
  const [treeCollapsed, setTreeCollapsed] = createSignal<Set<string>>(new Set(args.initialTreeCollapsed ?? []));
  // Scrollbox refs — auto-scroll the cursor row into view: the list pane's on
  // cursor movement, the tree's on tree-cursor movement (issue 15 / 16).
  let listScroll: any = null;
  let treeScroll: any = null;

  const rows = createMemo(() =>
    buildRows({ issues: args.issues(), loaded: args.loaded(), error: args.error() }, collapsed()),
  );
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
  const treeRows = createMemo(() => foldForest(buildForest(treePool()), treeCollapsed()));
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

  // The category a row belongs to: the root of a header, the effort of an
  // issue's containing category, or null for a status row — the collapse logic's
  // one membership test (a header and its issues are all "in" the same root).
  function rootOfRow(row: Row | undefined): string | null {
    if (!row) return null;
    if (row.kind === "group") return row.root;
    if (row.kind === "issue") return row.issue.effort;
    return null;
  }

  /** The visible list's row index of a category's header, or -1. */
  const groupIndex = (root: string) => rows().findIndex((r) => r.kind === "group" && r.root === root);

  function selectCategory(root: string) {
    // The mouse selects a whole category — move the cursor onto its header row.
    const idx = groupIndex(root);
    if (idx >= 0) setCursor(idx);
  }

  // The collapse toggle (collapsible-categories 02): fold/unfold one category
  // by effort name. Folding the category holding the selected row clamps the
  // cursor onto its header — the visible anchor at that position — so selection
  // never points into the hidden issue rows. The header's row index is stable
  // across the fold (everything before it is untouched), so it is computed from
  // the pre-fold rows.
  function toggleCollapse(root: string) {
    const prev = collapsed();
    const next = new Set(prev);
    if (next.has(root)) next.delete(root);
    else next.add(root);
    if (next.has(root) && rootOfRow(selectedRow()) === root) {
      const idx = groupIndex(root);
      if (idx >= 0) setCursor(idx);
    }
    setCollapsed(next);
  }

  // The tree view's fold toggle (collapsible-categories 03): fold/unfold the
  // selected node's subtree. A leaf's Space is a no-op — only a node with
  // children can fold (the builder mirrors this, so a leaf can never carry a
  // fold flag). Folding the selected node keeps its own row (the visible anchor
  // at that position), so the cursor stays put; folding a node that is an
  // *ancestor* of the selection — reachable only through model drift, since
  // Space always folds the cursor's own row — clamps the cursor onto that
  // ancestor, mirroring the list view's clamp rule, so selection never points
  // at a hidden node. Unfolding reveals the subtree below the cursor.
  function treeFoldSelected() {
    const row = treeRows()[treeCursor()];
    if (!row || !row.hasChildren) return;
    const id = row.issue.id;
    const wasFolded = treeCollapsed().has(id);
    const next = new Set(treeCollapsed());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setTreeCollapsed(next);
    // The model-consistency rule (story 24): folding never leaves the selection
    // pointing at a hidden node — the cursor anchors onto the fold point. In
    // the normal path Space folds the cursor's own row, whose row stays at the
    // same index, so this is a no-op; it only moves the cursor if state drift
    // put the selection somewhere inside the just-folded subtree.
    if (!wasFolded) {
      const anchor = treeRows().findIndex((r) => r.issue.id === id);
      if (anchor >= 0 && treeCursor() !== anchor) setTreeCursor(anchor);
    }
  }

  // The `collapse` action: fold/unfold the row under the cursor — a category in
  // the list view (a header, or the selected issue's containing category), the
  // selected node in the tree view (collapsible-categories 03). The tree fold
  // rides the same shared `collapse` key mapping.
  function collapseSelected() {
    if (view() === "tree") {
      treeFoldSelected();
      return;
    }
    const root = rootOfRow(selectedRow());
    if (root) toggleCollapse(root);
  }

  // The `Enter` router's fact: whether the list cursor rests on a category
  // header (a header → fold on Enter, an issue row → dispatch as before).
  const isCategorySelected = () => selectedRow()?.kind === "group";

  function selectTreeById(id: string) {
    const idx = treeRows().findIndex((r) => r.issue.id === id);
    if (idx >= 0) setTreeCursor(idx);
  }

  // Keep the list cursor inside the (possibly shrinking) visible row list — a
  // fold or a poll refresh removes rows, and the cursor must never index past
  // the last visible one (hidden issues are unreachable by construction).
  createEffect(() => {
    const n = rows().length;
    setCursor((c) => Math.min(c, Math.max(0, n - 1)));
  });
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
  // Group headers carry a stable groupId so a category selection scrolls its
  // header into view too.
  createEffect(() => {
    const row = rows()[cursor()];
    if (!row || !listScroll) return;
    const id = row.kind === "issue" ? row.issue.id : row.kind === "group" ? groupId(row.root) : null;
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
    selectCategory,
    selectTreeById,
    toggleCollapse,
    collapseSelected,
    isCategorySelected,
    listScrollRef: (el: any) => (listScroll = el),
    treeScrollRef: (el: any) => (treeScroll = el),
  };
}