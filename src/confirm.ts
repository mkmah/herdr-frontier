// The confirmation rulebook (confirmation-gate 03) — the whole "should we ask,
// and what do we say" decision as one pure, unit-tested module: the single
// source of truth the shell (issue 05) and the config (issue 04) both
// consume. No IO, no render state — mirrors the pure `appKeyAction` seam in
// style and shape (spec's module responsibilities). The gate is default-on
// (only `false` suppresses; absent and `true` keep it), structural no-ops skip
// it, and each Confirmable action's dialog copy is per-trigger with its live
// subject (issue id + title, run-root + concurrency, in-flight tally) filled
// from context.

import { issueNum } from "./logic.js";

/** The four Confirmable actions (CONTEXT.md): the actions a confirmation gate
 *  guards before they execute — dispatch, release, run-start, run-stop. This is
 *  the shared trigger vocabulary the `[confirm]` config table (issue 04) and
 *  the shell's verbs (issue 05) both consume. */
export type ConfirmationTrigger = "dispatch" | "release" | "run-start" | "run-stop";

/** The config bypass: `false` suppresses that trigger's gate; absent and `true`
 *  both keep it, so an empty config leaves every gate on. A trigger missing
 *  from the record means "confirm" (the default). */
export type ConfirmPolicy = Partial<Record<ConfirmationTrigger, boolean>>;

/** The two modal buttons; the shell's focus index moves over them. */
export type ConfirmButton = "cancel" | "confirm";

/** The facts the gate decides on, plus the live subjects the dialog copy names.
 *  The booleans are structural skips — a gate for an action that can't run is
 *  never shown; the subject fields fill the per-trigger copy with real
 *  ids/titles/counts. One shape serves both `confirmationFor` and
 *  `confirmDialogFor` (spec: with live ids/titles/counts filled from context). */
export interface ConfirmationCtx {
  /** An issue is selected (dispatch / release / run-start need one). */
  hasSelection: boolean;
  /** The dispatch coordinator is present (dispatch / release run through it). */
  hasCoordinator: boolean;
  /** The run controller is present (run-start / run-stop run through it). */
  hasController: boolean;
  /** The selected issue's dispatch outcome is implement/wayfinder and it is
   *  open — dispatch's structural skip. */
  dispatchable: boolean;
  /** Runs currently running (run-stop's structural skip: a stop-all with zero
   *  running runs is a no-op). */
  runningRuns: number;
  /** The selected issue's id — its `#id` names the dispatch/release subject. */
  issueId: string;
  /** The selected issue's title — the second half of the context line. */
  issueTitle: string;
  /** The run-root effort a run-start would walk (its context line). */
  runRoot: string;
  /** The run's per-run concurrency cap (run-start's body names it). */
  concurrency: number;
  /** The in-flight issue tally a run-stop would release (its context line). */
  inflight: number;
}

/** The rendered copy for one confirmation dialog — the title, the context line,
 *  the body, and the `[ Cancel  Confirm ]` row the modal paints, with Confirm
 *  always pre-focused. `trigger` is which Confirmable action confirms from this
 *  dialog, so the dialog is self-describing when the shell stores the pending
 *  action and executes it on confirm. */
export interface ConfirmDialog {
  trigger: ConfirmationTrigger;
  title: string;
  /** The context line: `#id — title` for dispatch/release, the run-root effort
   *  for run-start, the in-flight tally for run-stop. */
  context: string;
  body: string;
  cancelLabel: string;
  confirmLabel: string;
  /** The pre-focused button — always confirm (the deliberate-action default:
   *  the action is two keys away, not one). */
  focusedButton: "confirm";
}

/** A modal key press's intent: move button focus, activate, cancel, or nothing.
 *  The nothing (null) is the swallow — while a modal is open the key handler
 *  routes every key here, so an unmapped key can never fire an action behind
 *  the overlay. */
export type ModalKeyAction = "left" | "right" | "confirm" | "cancel";

/** Map a parsed key event to its modal intent. `←`/`k` move focus left (toward
 *  Cancel), `→`/`j`/`Tab` right, `Enter` activates the focused button, and
 *  `Esc`/`q` cancel — cancel, never quit: the key handler has no path to
 *  `appKeyAction` while the swallow routes here, so `q` quits only outside a
 *  modal. Everything else maps to null — the full dead-key swallow. */
export function modalKeyAction(key: { name?: string; shift?: boolean }): ModalKeyAction | null {
  if (key.name === "left" || key.name === "k") return "left";
  if (key.name === "right" || key.name === "j" || key.name === "tab") return "right";
  if (key.name === "return") return "confirm";
  if (key.name === "escape" || key.name === "q") return "cancel";
  return null;
}

/** True when a trigger's structural requirements are met — a confirmation gate
 *  for an action that can't run is never shown (spec: no-op suppression).
 *  Dispatch needs a dispatchable selection + a dispatcher; release a selection
 *  + a dispatcher; run-start a selection + a controller; run-stop a controller
 *  with ≥1 running run. */
function structurallyActionable(trigger: ConfirmationTrigger, ctx: ConfirmationCtx): boolean {
  switch (trigger) {
    case "dispatch":
      return ctx.hasSelection && ctx.hasCoordinator && ctx.dispatchable;
    case "release":
      return ctx.hasSelection && ctx.hasCoordinator;
    case "run-start":
      return ctx.hasSelection && ctx.hasController;
    case "run-stop":
      return ctx.hasController && ctx.runningRuns > 0;
  }
}

/** The gate decision: `null` means the verb runs directly (the policy
 *  suppresses the trigger, or a structural no-op applies); else the
 *  `ConfirmDialog` to render. */
export function confirmationFor(
  trigger: ConfirmationTrigger,
  policy: ConfirmPolicy,
  ctx: ConfirmationCtx,
): ConfirmDialog | null {
  if (policy[trigger] === false) return null; // only false is "off" — absent/true keep it
  if (!structurallyActionable(trigger, ctx)) return null;
  return confirmDialogFor(trigger, ctx);
}

/** The per-trigger dialog copy (locked verbatim from the confirmation-gate
 *  grilling): dispatch and release name the issue (`#id` + title), run-start
 *  the run-root and concurrency cap, run-stop the in-flight tally — Confirm
 *  always pre-focused. */
export function confirmDialogFor(trigger: ConfirmationTrigger, ctx: ConfirmationCtx): ConfirmDialog {
  switch (trigger) {
    case "dispatch": {
      const id = issueNum(ctx.issueId);
      return {
        trigger,
        title: `Dispatch ${id}?`,
        context: `${id} — ${ctx.issueTitle}`,
        body: `Claims ${id} and starts an agent in a new pane — work begins now.`,
        cancelLabel: "Cancel",
        confirmLabel: "Confirm",
        focusedButton: "confirm",
      };
    }
    case "release": {
      const id = issueNum(ctx.issueId);
      return {
        trigger,
        title: `Release ${id}?`,
        context: `${id} — ${ctx.issueTitle}`,
        body: `Stops the agent, closes its tab, and reopens ${id}. The agent's in-flight context is lost.`,
        cancelLabel: "Cancel",
        confirmLabel: "Confirm",
        focusedButton: "confirm",
      };
    }
    case "run-start":
      return {
        trigger,
        title: "Start run?",
        context: ctx.runRoot,
        body: `Walks the ${ctx.runRoot} graph, dispatching each issue as its blockers clear — up to ${ctx.concurrency} panes in parallel.`,
        cancelLabel: "Cancel",
        confirmLabel: "Confirm",
        focusedButton: "confirm",
      };
    case "run-stop":
      return {
        trigger,
        title: "Stop all runs?",
        context: `${ctx.inflight} in-flight`,
        body: `Stops every running run and releases ${ctx.inflight} in-flight issues: closes those tabs and reopens them all.`,
        cancelLabel: "Cancel",
        confirmLabel: "Confirm",
        focusedButton: "confirm",
      };
  }
}
