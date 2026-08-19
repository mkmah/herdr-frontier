// useKeys — the keyboard surface (architecture review 2026-08,
// layered-frontend layout). While a confirmation dialog is open every key
// routes to the modal and only the modal — the dead key swallow (nothing
// behind the overlay can fire). Outside a dialog the shell's action vocabulary
// (appKeyAction, services/shell/shell.ts) maps keys to the verbs App/useVerbs
// expose. Extracted from App.tsx so the composition root stays a thin wire-up
// of hooks.

import { useKeyboard, useRenderer } from "@opentui/solid";
import { appKeyAction } from "#/services/shell/shell.js";
import { modalKeyAction } from "#/lib/confirm.js";
import { cycleFocus, type Focus } from "#/lib/display.js";
import type { AppView, ModalState } from "#/types.js";

export function useKeys(args: {
  onQuit?: () => void;
  modal: () => ModalState | null;
  setModal: (m: ModalState | null) => void;
  confirmModal: () => void;
  view: () => AppView;
  move: (dir: number) => void;
  treeMove: (dir: number) => void;
  /** The `collapse` action handler — folds the category under the list cursor
   *  (collapsible-categories 02); the tree's node-level fold rides the same
   *  action (ticket 03). */
  collapse: () => void;
  /** Whether the list cursor rests on a category header — the `Enter` router's
   *  fact (a header folds on Enter, an issue row dispatches as before). */
  isCategorySelected: () => boolean;
  doDispatch: () => void;
  doRelease: () => void;
  startRun: () => void;
  stopRun: () => void;
  toggleView: () => void;
  load: () => void;
  setFocus: (updater: (f: Focus) => Focus) => void;
}) {
  const renderer = useRenderer();
  useKeyboard((key) => {
    const m = args.modal();
    if (m) {
      // While a dialog is open every key routes here and only here — the dead
      // key swallow: any key the modal doesn't map does nothing, so no cursor
      // motion, view toggle, reload, quit, or Confirmable action can fire
      // behind the overlay. Only the move/confirm/cancel keys reach the shell.
      switch (modalKeyAction(key)) {
        case "left":
          args.setModal({ dialog: m.dialog, focus: "cancel" });
          break;
        case "right":
          args.setModal({ dialog: m.dialog, focus: "confirm" });
          break;
        case "confirm":
          // Enter activates the *focused* button — Confirm pre-focused, but a
          // focused Cancel makes Enter cancel (and Esc/q always cancel).
          if (m.focus === "cancel") args.setModal(null);
          else args.confirmModal();
          break;
        case "cancel":
          // Esc/q — cancel, never quit: appKeyAction is unreachable here.
          args.setModal(null);
          break;
        case null:
          break;
      }
      return;
    }
    switch (appKeyAction(key)) {
      case "quit":
        (args.onQuit ?? (() => renderer.destroy()))();
        break;
      case "focus":
        args.setFocus((f) => cycleFocus(f));
        break;
      case "down":
        if (args.view() === "tree") args.treeMove(1);
        else args.move(1);
        break;
      case "up":
        if (args.view() === "tree") args.treeMove(-1);
        else args.move(-1);
        break;
      case "dispatch":
        // `Enter` keeps its dispatch action in the key map; the router decides
        // what the cursor row wants: in the list view a category header folds,
        // an issue row dispatches as before, and the tree always dispatches
        // (collapsible-categories 02).
        if (args.view() === "list" && args.isCategorySelected()) args.collapse();
        else void args.doDispatch();
        break;
      case "release":
        void args.doRelease();
        break;
      case "run-start":
        void args.startRun();
        break;
      case "run-stop":
        void args.stopRun();
        break;
      case "toggle-view":
        args.toggleView();
        break;
      case "reload":
        void args.load();
        break;
      case "collapse":
        // `Space` folds/unfolds — the category under the cursor (a header, or
        // the selected issue's containing category) in the list view; the tree
        // view's node-level fold is ticket 03. The handler no-ops where folding
        // points at nothing.
        args.collapse();
        break;
    }
  });
}