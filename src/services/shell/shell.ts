// The shell controller (architecture review 2026-08, candidate 1) — the deep
// module behind the primary shell's behavior: the four Confirmable verbs, the
// confirmation gate, and the load/poll pipeline. Extracted from App.tsx so the
// behavior is unit-testable through a small interface instead of a full render.
//
// App is the thin render adapter: it owns every Solid signal, forwards keys and
// mouse, and applies the outcome records this module returns. This module is
// signal-free — no state of its own, nothing to keep in sync with a screen. The
// only state anywhere is behind the coordinator's ClaimRegistry and the run
// store, both already behind their own seams.
//
// request() answers "what should the shell do with this trigger?" — show the
// confirmation dialog, or go. The dialog is self-describing (ConfirmDialog
// carries its trigger), so confirm() can run the verb from the dialog App
// already holds — the controller keeps no pending-action state, so the modal on
// screen and the verb that runs can never drift.
//
// load() is loud (an error row on failure); tick() is silent (null → apply
// nothing, the next tick retries) — the two poll/load paths preserve their
// original semantics. tick() funnels claims + dead-dispatch + attention through
// the coordinator's reconcileTick, which reads `herdr agent list` exactly once
// per tick (the review's card-3 win).

import type { Issue, IssueDetail, TrackerProvider } from "#/services/tracker/provider.js";
import type { DispatchCoordinator, DispatchResult, ReleaseResult } from "#/services/dispatch/coordinator.js";
import { DEFAULT_RUN_CONCURRENCY, type RunController } from "#/services/run/controller.js";
import type { RunState } from "#/services/run/advance.js";
import type { AgentStatus } from "#/services/herdr/types.js";
import {
  confirmationFor,
  type ConfirmationCtx,
  type ConfirmationTrigger,
  type ConfirmDialog,
  type ConfirmPolicy,
} from "#/lib/confirm.js";
import { dispatch } from "#/lib/orchestrator.js";
import { issueLabel } from "#/lib/issues.js";

// --- input surface (the actions a key press can trigger) --------------------

/** The actions a key press can trigger — the shell's command vocabulary, the
 *  single source of truth the `useKeyboard` handler switches on, extracted so
 *  the bindings are testable (issue 14 stop: `s` starts, shift-`s` stops —
 *  never a toggle). */
export type AppKeyAction =
  | "quit"
  | "focus"
  | "down"
  | "up"
  | "dispatch"
  | "release"
  | "run-start"
  | "run-stop"
  | "toggle-view"
  | "reload";

/** Map a parsed key event to its action. shift-`s` reaches us as `name: "s"`
 *  with `shift: true` (raw terminal) or `name: "S"` (kitty protocol); both map
 *  to stop. Returns null for keys the shell ignores. */
export function appKeyAction(key: { name?: string; shift?: boolean }): AppKeyAction | null {
  if (key.name === "q") return "quit";
  if (key.name === "tab") return "focus";
  if (key.name === "j" || key.name === "down") return "down";
  if (key.name === "k" || key.name === "up") return "up";
  if (key.name === "return") return "dispatch";
  if (key.name === "x") return "release";
  if (key.name === "s" && !key.shift) return "run-start";
  if (key.name === "S" || (key.name === "s" && key.shift)) return "run-stop";
  if (key.name === "t") return "toggle-view";
  if (key.name === "r") return "reload";
  return null;
}

// --- the deepened module ----------------------------------------------------

/** The outcome of one Confirmable verb. The run verbs have nothing to report
 *  (`ran: true` — App bumps its run-status pulse and the poll owns truth);
 *  dispatch/release pass through the coordinator's existing result records so
 *  no fourth result shape is invented. */
export type ShellOutcome =
  | { verb: "dispatch"; result: DispatchResult }
  | { verb: "release"; result: ReleaseResult }
  | { verb: "run-start" | "run-stop"; ran: true };

/** The gate's answer to a Confirmable trigger: ask the user, or go. */
export type ShellRequestResult =
  | { kind: "dialog"; dialog: ConfirmDialog }
  | { kind: "go" };

export interface ShellDeps {
  provider: TrackerProvider;
  /** The shared manual dispatcher — its ClaimRegistry is the one claim mutex
   *  both manual and automated dispatches go through. */
  coordinator: DispatchCoordinator;
  /** The automated run-controller. */
  runController: RunController;
  /** The merged `[confirm]` bypass — `false` per trigger suppresses its gate. */
  confirmPolicy: ConfirmPolicy;
}

export class ShellController {
  private readonly deps: ShellDeps;

  constructor(deps: ShellDeps) {
    this.deps = deps;
  }

  /** The run state for a run-root — a read accessor for the detail pane's
   *  run-status line (display crosses this seam read-only). */
  runFor(root: string): RunState | null {
    return this.deps.runController.load(root);
  }

  /** The full body + comments for an issue id — the detail pane's read
   *  accessor (display crosses this seam read-only). */
  readIssue(id: string): Promise<IssueDetail> {
    return this.deps.provider.readIssue(id);
  }

  /** The confirmation gate: decide whether a Confirmable trigger asks or goes.
   *  The gate facts (selection, dispatchability, run tallies, ids/titles/roots)
   *  are all derivable from `sel` + the controller's own deps, so App passes
   *  only the selection. On "go" the caller runs the verb via {@link confirm} —
   *  the split is what lets App paint its "⟳ working…" feedback *before* the
   *  verb's await. */
  request(trigger: ConfirmationTrigger, sel?: Issue): ShellRequestResult {
    const gate = confirmationFor(trigger, this.deps.confirmPolicy, this.gateCtx(sel));
    if (gate) return { kind: "dialog", dialog: gate };
    return { kind: "go" };
  }

  /** Run one Confirmable verb, bypassing the gate — the modal's confirm and the
   *  gate's "go" both land here. The trigger comes from the self-describing
   *  dialog App already holds (or the action the key mapped to); no pending
   *  action is stored. Dispatch/release may throw (post-claim herdr failures) —
   *  App's try/catch surfaces those; the run verbs swallow and the poll owns
   *  truth. */
  async confirm(trigger: ConfirmationTrigger, sel?: Issue): Promise<ShellOutcome> {
    switch (trigger) {
      case "dispatch":
        return { verb: "dispatch", result: await this.deps.coordinator.dispatchIssue(sel!) };
      case "release":
        return { verb: "release", result: await this.deps.coordinator.releaseIssue(sel!) };
      case "run-start":
        await this.deps.runController.start(sel!.effort);
        return { verb: "run-start", ran: true };
      case "run-stop":
        await this.deps.runController.stopAllAndRelease();
        return { verb: "run-stop", ran: true };
    }
  }

  /** Loud load: a fresh issue snapshot (an error row on failure). Reconciles
   *  the in-session claim mutex against the fresh snapshot; dead-dispatch
   *  cleanup is poll-only now (the 2s tick owns it — flagged in the review). */
  async load(): Promise<{ ok: true; issues: Issue[] } | { ok: false; error: string }> {
    try {
      const issues = await this.deps.provider.listIssues();
      this.deps.coordinator.reconcileClaims(issues);
      return { ok: true, issues };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Silent poll tick: claims + dead-dispatch + attention through the
   *  coordinator's single reconcile (one `herdr agent list` read), then step
   *  every running run on the same snapshot. Returns the state delta for App to
   *  apply, or null when the tick failed — apply nothing, the next tick retries.
   *  Accepts the poll loop's own fresh snapshot so a run's work rides on issues
   *  the UI already loaded. */
  async tick(fresh?: Issue[]): Promise<{ issues: Issue[]; agentStates: Map<string, AgentStatus> } | null> {
    try {
      const all = fresh ?? (await this.deps.provider.listIssues());
      const agentStates = await this.deps.coordinator.reconcileTick(all);
      await this.deps.runController.stepAll(all);
      return { issues: all, agentStates };
    } catch {
      return null; // non-fatal — the next tick retries
    }
  }

  /** The gate facts for a selection — the controller-domain view of "what can
   *  this trigger do right now". Always wired (the controller has its deps), so
   *  `hasCoordinator`/`hasController` are constant. */
  private gateCtx(sel?: Issue): ConfirmationCtx {
    const runRoot = sel ? sel.effort : "";
    const run = sel ? this.deps.runController.load(runRoot) : null;
    const outcome = sel ? dispatch(sel) : null;
    return {
      hasSelection: !!sel,
      hasCoordinator: true,
      hasController: true,
      dispatchable:
        !!sel && sel.status === "open" && (outcome?.kind === "implement" || outcome?.kind === "wayfinder"),
      runningRuns: this.deps.runController.runningRuns,
      issueLabel: sel ? issueLabel(sel) : "",
      issueTitle: sel?.title ?? "",
      runRoot,
      concurrency: run?.concurrency ?? this.deps.runController.concurrency ?? DEFAULT_RUN_CONCURRENCY,
      inflight: this.deps.runController.inflightCount,
    };
  }
}
