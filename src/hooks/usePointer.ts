// usePointer — the shell's mouse surface (prototype 08's behavior, applied to
// the real shell; issue 15/16): click a row = select + focus the list, wheel
// over a pane = move the cursor, click the detail pane = focus detail,
// double-click a row = dispatch. Both the list panes and the tree panes' rows
// route through here (issue 15). Extracted from App.tsx so the composition root
// stays a thin wire-up of hooks.

import type { MouseEvent } from "@opentui/core";
import { trackClick, wheelDelta, MouseButton, type ClickRecord, type Focus } from "#/lib/display.js";
import { groupId } from "#/lib/rows.js";

export function usePointer(args: {
  selectById: (id: string) => void;
  selectCategory: (root: string) => void;
  selectTreeById: (id: string) => void;
  toggleCollapse: (root: string) => void;
  doDispatch: () => void;
  move: (dir: number) => void;
  treeMove: (dir: number) => void;
  setFocus: (f: Focus) => void;
}) {
  let lastClick: ClickRecord | null = null;
  function onRowMouseDown(e: MouseEvent, id: string) {
    if (e.button !== MouseButton.LEFT) return;
    args.setFocus("list");
    args.selectById(id);
    const click = trackClick(lastClick, id, Date.now());
    lastClick = click.next;
    if (click.double) void args.doDispatch();
  }
  // A category header gets the same onMouseDown routing an issue row has — a
  // single click selects the whole category AND folds it; a double-click is two
  // folds (a no-op round-trip), never a dispatch (collapsible-categories 02).
  // The id namespace groupId(root) can never collide with an issue id, so the
  // double-click tracker shares `lastClick` safely.
  function onHeaderMouseDown(e: MouseEvent, root: string) {
    if (e.button !== MouseButton.LEFT) return;
    args.setFocus("list");
    args.selectCategory(root);
    args.toggleCollapse(root);
    const click = trackClick(lastClick, groupId(root), Date.now());
    lastClick = click.next;
  }
  function onListWheel(e: MouseEvent) {
    args.move(wheelDelta(e.button));
  }
  function onDetailMouseDown(e: MouseEvent) {
    if (e.button === MouseButton.LEFT) args.setFocus("detail");
  }
  // Tree-view mouse (issue 15): click a row = select + focus the tree, double-
  // click = dispatch, wheel = move the cursor — the list pane's behavior
  // applied to the forest rows.
  let lastTreeClick: ClickRecord | null = null;
  function onTreeRowMouseDown(e: MouseEvent, id: string) {
    if (e.button !== MouseButton.LEFT) return;
    args.setFocus("list");
    args.selectTreeById(id);
    const click = trackClick(lastTreeClick, id, Date.now());
    lastTreeClick = click.next;
    if (click.double) void args.doDispatch();
  }
  function onTreeWheel(e: MouseEvent) {
    args.treeMove(wheelDelta(e.button));
  }

  return { onRowMouseDown, onHeaderMouseDown, onListWheel, onDetailMouseDown, onTreeRowMouseDown, onTreeWheel };
}