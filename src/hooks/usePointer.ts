// usePointer — the shell's mouse surface (prototype 08's behavior, applied to
// the real shell; issue 15/16): click a row = select + focus the list, wheel
// over a pane = move the cursor, click the detail pane = focus detail,
// double-click a row = dispatch. Both the list panes and the tree panes' rows
// route through here (issue 15). Extracted from App.tsx so the composition root
// stays a thin wire-up of hooks.

import type { MouseEvent } from "@opentui/core";
import { trackClick, wheelDelta, MouseButton, type ClickRecord, type Focus } from "#/lib/display.js";

export function usePointer(args: {
  selectById: (id: string) => void;
  selectTreeById: (id: string) => void;
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

  return { onRowMouseDown, onListWheel, onDetailMouseDown, onTreeRowMouseDown, onTreeWheel };
}