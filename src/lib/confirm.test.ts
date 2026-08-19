// Pure rulebook tests for the confirmation gate (confirmation-gate 03) — Seam 1
// in the spec's Testing Decisions, mirroring the appKeyAction tests' shape: the
// modal key mapping (move / confirm / cancel / the full swallow), the policy
// suppression (false kills the gate; absent/true keep it), every structural skip
// per trigger, and the per-trigger dialog copy with live subjects and Confirm
// pre-focused. Plain data against the pure module — no IO, no renderer.

import { describe, it, expect } from "bun:test";
import {
  confirmationFor,
  confirmDialogFor,
  modalKeyAction,
  type ConfirmationCtx,
  type ConfirmationTrigger,
} from "#/lib/confirm.js";

const ctx: ConfirmationCtx = {
  hasSelection: true,
  hasCoordinator: true,
  hasController: true,
  dispatchable: true,
  runningRuns: 2,
  issueLabel: "#05",
  issueTitle: "Confirm rulebook",
  runRoot: "herdr-frontier",
  concurrency: 3,
  inflight: 2,
};

const TRIGGERS: ConfirmationTrigger[] = ["dispatch", "release", "run-start", "run-stop"];

describe("modalKeyAction — the modal's key mapping", () => {
  it("maps the move keys to focus intent (←/k left, →/j/Tab right)", () => {
    expect(modalKeyAction({ name: "left" })).toBe("left");
    expect(modalKeyAction({ name: "k" })).toBe("left");
    expect(modalKeyAction({ name: "right" })).toBe("right");
    expect(modalKeyAction({ name: "j" })).toBe("right");
    expect(modalKeyAction({ name: "tab" })).toBe("right");
  });

  it("maps Enter to confirm and Esc/q to cancel — cancel never quits while a modal is open", () => {
    expect(modalKeyAction({ name: "return" })).toBe("confirm");
    expect(modalKeyAction({ name: "escape" })).toBe("cancel");
    expect(modalKeyAction({ name: "q" })).toBe("cancel");
  });

  it("swallows every other key — the modal routes all keys here, so one can't fire an action behind the overlay", () => {
    for (const name of ["a", "s", "x", "S", "t", "r", "down", "up", "f", "1", " ", "n"]) {
      expect(modalKeyAction({ name })).toBeNull();
    }
    expect(modalKeyAction({ name: "s", shift: true })).toBeNull();
  });
});

describe("confirmationFor — the gate", () => {
  it("suppresses the gate when the policy turns the trigger off (false), for each of the four actions", () => {
    for (const trigger of TRIGGERS) {
      expect(confirmationFor(trigger, { [trigger]: false }, ctx)).toBeNull();
    }
  });

  it("keeps the gate on when the policy is absent or true — false is the only 'off' value", () => {
    for (const trigger of TRIGGERS) {
      expect(confirmationFor(trigger, {}, ctx)).not.toBeNull();
      expect(confirmationFor(trigger, { [trigger]: true }, ctx)).not.toBeNull();
      const other = TRIGGERS.find((t) => t !== trigger)!;
      expect(confirmationFor(trigger, { [other]: false }, ctx)).not.toBeNull();
    }
  });

  it("returns the dialog to render when the gate stays on", () => {
    expect(confirmationFor("dispatch", {}, ctx)).toEqual(confirmDialogFor("dispatch", ctx));
  });

  it("skips dispatch without a selection, a dispatcher, or a dispatchable selection", () => {
    expect(confirmationFor("dispatch", {}, { ...ctx, hasSelection: false })).toBeNull();
    expect(confirmationFor("dispatch", {}, { ...ctx, hasCoordinator: false })).toBeNull();
    expect(confirmationFor("dispatch", {}, { ...ctx, dispatchable: false })).toBeNull();
  });

  it("skips release without a selection or a dispatcher", () => {
    expect(confirmationFor("release", {}, { ...ctx, hasSelection: false })).toBeNull();
    expect(confirmationFor("release", {}, { ...ctx, hasCoordinator: false })).toBeNull();
  });

  it("skips run-start without a selection or a run controller", () => {
    expect(confirmationFor("run-start", {}, { ...ctx, hasSelection: false })).toBeNull();
    expect(confirmationFor("run-start", {}, { ...ctx, hasController: false })).toBeNull();
  });

  it("skips run-stop without a run controller or any running run", () => {
    expect(confirmationFor("run-stop", {}, { ...ctx, hasController: false })).toBeNull();
    expect(confirmationFor("run-stop", {}, { ...ctx, runningRuns: 0 })).toBeNull();
  });

  it("checks only each trigger's own facts — another gate's structure never blocks it", () => {
    expect(confirmationFor("dispatch", {}, { ...ctx, hasController: false })).not.toBeNull();
    expect(confirmationFor("run-start", {}, { ...ctx, hasCoordinator: false })).not.toBeNull();
    expect(confirmationFor("run-stop", {}, { ...ctx, hasSelection: false })).not.toBeNull();
    expect(confirmationFor("release", {}, { ...ctx, hasController: false, runningRuns: 0 })).not.toBeNull();
  });

  it("suppresses before consulting structure — a toggled-off trigger never asks the facts", () => {
    expect(confirmationFor("dispatch", { dispatch: false }, ctx)).toBeNull();
    expect(confirmationFor("run-stop", { "run-stop": false }, ctx)).toBeNull();
  });
});

describe("confirmDialogFor — the per-trigger copy", () => {
  it("names the issue for dispatch — #id and title, what claim+start does", () => {
    const d = confirmDialogFor("dispatch", ctx);
    expect(d).toEqual({
      trigger: "dispatch",
      title: "Dispatch #05?",
      context: "#05 — Confirm rulebook",
      body: "Claims #05 and starts an agent in a new pane — work begins now.",
      cancelLabel: "Cancel",
      confirmLabel: "Confirm",
      focusedButton: "confirm",
    });
  });

  it("names the issue for release — #id and title, the stop+reopen cost", () => {
    const d = confirmDialogFor("release", ctx);
    expect(d).toEqual({
      trigger: "release",
      title: "Release #05?",
      context: "#05 — Confirm rulebook",
      body: "Stops the agent, closes its tab, and reopens #05. The agent's in-flight context is lost.",
      cancelLabel: "Cancel",
      confirmLabel: "Confirm",
      focusedButton: "confirm",
    });
  });

  it("names the run-root and concurrency cap for run-start", () => {
    const d = confirmDialogFor("run-start", ctx);
    expect(d).toEqual({
      trigger: "run-start",
      title: "Start run?",
      context: "herdr-frontier",
      body: "Walks the herdr-frontier graph, dispatching each issue as its blockers clear — up to 3 panes in parallel.",
      cancelLabel: "Cancel",
      confirmLabel: "Confirm",
      focusedButton: "confirm",
    });
  });

  it("names the in-flight tally for run-stop", () => {
    const d = confirmDialogFor("run-stop", ctx);
    expect(d).toEqual({
      trigger: "run-stop",
      title: "Stop all runs?",
      context: "2 in-flight",
      body: "Stops every running run and releases 2 in-flight issues: closes those tabs and reopens them all.",
      cancelLabel: "Cancel",
      confirmLabel: "Confirm",
      focusedButton: "confirm",
    });
  });

  it("renders Cancel/Confirm with Confirm pre-focused, in every dialog", () => {
    for (const trigger of TRIGGERS) {
      const d = confirmDialogFor(trigger, ctx);
      expect(d.cancelLabel).toBe("Cancel");
      expect(d.confirmLabel).toBe("Confirm");
      expect(d.focusedButton).toBe("confirm");
    }
  });
});
