// useVerbs — the four Confirmable actions, gated through the shell
// (architecture review 2026-08, layered-frontend layout):
// `Enter`/double-click = dispatch, `x` = release, `s`/`S` = run start/stop.
// Every verb enters through the shell's `request` — the confirmation gate's
// single entry, so keyboard and mouse (both views) ride the same path — and
// runs its body through the shell's `confirm`. The shell returns outcome
// records; this hook turns them into the feedback signals the detail pane
// paints (`dispatchState` / `releaseState`) and owns the confirmation overlay's
// state (`modal` + `openModal` / `confirmModal`).
//
// Extracted from App.tsx so the composition root stays a thin wire-up of hooks.

import { createSignal } from "solid-js";
import type { ShellController } from "#/services/shell/shell.js";
import type { Issue } from "#/services/tracker/provider.js";
import type { ConfirmDialog } from "#/lib/confirm.js";
import type { DispatchUi, ModalState, ReleaseUi } from "#/types.js";

export function useVerbs(args: {
  shell: ShellController;
  selected: () => Issue | undefined;
  /** Bump the run pulse (the detail pane's run-status line remounts on it). */
  bumpRun: () => void;
  /** The issue-list setter — verbs optimistically reflect their outcome. */
  setIssues: (updater: (prev: Issue[]) => Issue[]) => void;
  /** A dialog already open on first render (test seam), sewed to Confirm. */
  initialModal?: ModalState | null;
}) {
  const [dispatchState, setDispatchState] = createSignal<DispatchUi>({ status: "idle" });
  const [releaseState, setReleaseState] = createSignal<ReleaseUi>({ status: "idle" });
  // The confirmation overlay (confirmation-gate 05): null = no dialog; else the
  // dialog to paint plus which button is focused. Confirm is always pre-focused
  // (the rulebook's focusedButton). State changes here never move selection or
  // the pane focus — cancel costs nothing.
  const [modal, setModal] = createSignal<ModalState | null>(args.initialModal ?? null);

  /** Open the gate's dialog — Confirm is always pre-focused (the rulebook
   *  locks it; there is no other first-focus). */
  function openModal(dialog: ConfirmDialog) {
    setModal({ dialog, focus: dialog.focusedButton });
  }

  // --- manual dispatch -----------------------------------------------------
  // `Enter` (or double-click) dispatches the selected Issue: claim → resolve
  // `{id}` → `agent start` from the profile. The coordinator (behind the shell)
  // owns the shared claim mutex; we only render its outcome and reflect the
  // claim in the list so the row flips to "running" without a full reload.
  function doDispatch() {
    const sel = args.selected();
    if (!sel) return;
    const gate = args.shell.request("dispatch", sel);
    if (gate.kind === "dialog") { openModal(gate.dialog); return; }
    void runDispatch(sel);
  }
  async function runDispatch(sel: Issue) {
    setDispatchState({ status: "running", issueId: sel.id });
    try {
      const outcome = await args.shell.confirm("dispatch", sel);
      if (outcome.verb !== "dispatch") return;
      const r = outcome.result;
      if (r.ok) {
        setDispatchState({ status: "ok", issueId: r.issue.id, paneId: r.paneId, command: r.command });
        // The coordinator has already atomically claimed (`Status: claimed`) via
        // the provider before agent start; the background poll reflects it in
        // the list row. Resolution (`→ resolved`) is the implement skill's, later.
      } else {
        const msg =
          r.reason === "already-dispatched"
            ? "already dispatched this session"
            : r.reason === "already-claimed"
              ? "already claimed by another dispatcher"
              : r.reason === "claim-busy"
                ? "claim lock busy — try again"
                : "human turn — not auto-dispatched";
        setDispatchState({ status: "error", issueId: r.issue.id, message: msg });
      }
    } catch (e) {
      setDispatchState({ status: "error", issueId: sel.id, message: e instanceof Error ? e.message : String(e) });
    }
  }

  // --- stop / reopen an in-flight issue (the inverse of dispatch) ----------
  // `x` reopens the selected Issue (status → open) and closes the herdr tab this
  // session spawned for it. The provider release is authoritative; we optimistically
  // reflect the reopen in the list so the row flips back without a full reload
  // (which would reset the cursor). The background poll reconciles anything stale.
  function doRelease() {
    const sel = args.selected();
    if (!sel) return;
    const gate = args.shell.request("release", sel);
    if (gate.kind === "dialog") { openModal(gate.dialog); return; }
    void runRelease(sel);
  }
  async function runRelease(sel: Issue) {
    setReleaseState({ status: "running", issueId: sel.id });
    try {
      const outcome = await args.shell.confirm("release", sel);
      if (outcome.verb !== "release") return;
      const r = outcome.result;
      if (r.ok) {
        setReleaseState({ status: "ok", issueId: r.issue.id, tabClosed: r.tabClosed });
        args.setIssues((prev) => prev.map((i) => (i.id === r.issue.id ? { ...i, status: "open" } : i)));
      } else {
        setReleaseState({ status: "error", issueId: r.issue.id, message: r.message });
      }
    } catch (e) {
      setReleaseState({ status: "error", issueId: sel.id, message: e instanceof Error ? e.message : String(e) });
    }
  }

  // --- automated run (issue 14) --------------------------------------------
  // `s` starts a run bound to the selected Issue's run-root (its effort — the
  // directory a map/spec/to-tickets set lives in); `S` (shift-s) stops every
  // running run AND releases each in-flight pane it dispatched (close tab +
  // reopen the issue) — the one-key version of pressing x on every issue.
  // Starting is idempotent — a running run is returned untouched, so `s` never
  // toggles a run off. The controller walks the graph, dispatching each issue
  // as its blockers clear; the poll loop steps it.
  function startRun() {
    const sel = args.selected();
    if (!sel) return;
    const gate = args.shell.request("run-start", sel);
    if (gate.kind === "dialog") { openModal(gate.dialog); return; }
    void runStart(sel);
  }
  async function runStart(sel: Issue) {
    try {
      await args.shell.confirm("run-start", sel);
      args.bumpRun();
    } catch {
      // surfaced next poll — start failures are non-fatal
    }
  }
  function stopRun() {
    const gate = args.shell.request("run-stop");
    if (gate.kind === "dialog") { openModal(gate.dialog); return; }
    void runStop();
  }
  async function runStop() {
    try {
      await args.shell.confirm("run-stop");
      args.bumpRun();
    } catch {
      // surfaced next poll — stop failures are non-fatal
    }
  }

  /** Confirm the open dialog: run the confirmed verb's body on the current
   *  selection. The ~2s poll has kept reconciling live state behind the dialog,
   *  so a state change under it just makes the confirmed action a no-op,
   *  surfaced through the existing detail-pane feedback (never a second
   *  dialog). */
  function confirmModal() {
    const m = modal();
    if (!m) return;
    setModal(null);
    switch (m.dialog.trigger) {
      case "dispatch": {
        const sel = args.selected();
        if (sel) void runDispatch(sel);
        break;
      }
      case "release": {
        const sel = args.selected();
        if (sel) void runRelease(sel);
        break;
      }
      case "run-start": {
        const sel = args.selected();
        if (sel) void runStart(sel);
        break;
      }
      case "run-stop":
        void runStop();
        break;
    }
  }

  return {
    dispatchState,
    releaseState,
    modal,
    setModal,
    openModal,
    doDispatch,
    doRelease,
    startRun,
    stopRun,
    confirmModal,
  };
}