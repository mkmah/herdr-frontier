// Shell-controller tests (architecture review 2026-08, candidate 1). The shell
// is the signal-free deep module behind the primary shell's behavior: the four
// Confirmable verbs, the confirmation gate, and the load/poll pipeline. These
// tests exercise the seam end-to-end with inert fakes — no render, no herdr.
//
// The gate vocabulary (appKeyAction) moved here with the module; the App render
// smoke in App.test only proves the pane paints.

import { describe, it, expect } from "bun:test";
import { appKeyAction, ShellController, type ShellOutcome } from "#/services/shell/shell.js";
import type { Issue, IssueDetail, TrackerProvider } from "#/services/tracker/provider.js";
import type { AgentStatus } from "#/services/herdr/types.js";
import {
  type ConfirmPolicy,
  modalKeyAction,
} from "#/lib/confirm.js";
import {
  type DispatchCoordinator,
  type DispatchResult,
  type ReleaseResult,
} from "#/services/dispatch/coordinator.js";
import type { RunState } from "#/services/run/advance.js";
import type { RunController } from "#/services/run/controller.js";
import { idEffort, idNum, idOrder } from "#/services/tracker/local-markdown.js";

const mk = (over: Partial<Issue> = {}): Issue => {
  const id = over.id ?? ".scratch/e/issues/01-x.md";
  return {
    id,
    effort: idEffort(id),
    num: idNum(id),
    order: idOrder(id),
    title: "01 — X",
    status: "open",
    type: "task",
    labels: ["ready-for-agent"],
    assignee: null,
    blockedBy: [],
    ...over,
  };
};

// --- inert fakes ------------------------------------------------------------

class FakeProvider implements TrackerProvider {
  readonly calls: string[] = [];
  private readonly issues: Issue[];
  constructor(issues: Issue[] = []) {
    this.issues = issues;
  }
  async listIssues(): Promise<Issue[]> {
    this.calls.push("listIssues");
    return this.issues;
  }
  async readIssue(id: string): Promise<IssueDetail> {
    this.calls.push(`readIssue ${id}`);
    return { ...this.issues.find((i) => i.id === id)!, body: "", comments: [] };
  }
  async claim(): Promise<Issue> { throw new Error("noop"); }
  async release(): Promise<Issue> { throw new Error("noop"); }
  async updateLabels(): Promise<Issue> { throw new Error("noop"); }
  async close(): Promise<Issue> { throw new Error("noop"); }
  async comment(): Promise<Issue> { throw new Error("noop"); }
  async addBlocking(): Promise<Issue> { throw new Error("noop"); }
}

class FakeCoordinator {
  readonly order: string[] = [];
  claims: string[] = [];
  states = new Map<string, AgentStatus>();
  dispatchResult: DispatchResult = {
    ok: true,
    issue: mk(),
    command: "/implement .scratch/e/issues/01-x.md",
    paneId: "wZ:p1",
    kind: "opencode",
    args: [],
  };
  releaseResult: ReleaseResult = { ok: true, issue: mk(), tabClosed: true };

  reconcileClaims(_issues: Issue[]): void {
    this.order.push("reconcileClaims");
  }
  async reconcileTick(_fresh: Issue[]): Promise<Map<string, AgentStatus>> {
    this.order.push("reconcileTick");
    return this.states;
  }
  async dispatchIssue(issue: Issue): Promise<DispatchResult> {
    this.order.push(`dispatch ${issue.id}`);
    return this.dispatchResult;
  }
  async releaseIssue(issue: Issue): Promise<ReleaseResult> {
    this.order.push(`release ${issue.id}`);
    return this.releaseResult;
  }
}

class FakeRunController {
  readonly order: string[] = [];
  started: string[] = [];
  stopped = 0;
  steps = 0;
  runningRuns = 0;
  concurrency = 2;
  inflightCount = 0;
  private runs = new Map<string, RunState>();

  load(root: string): RunState | null {
    return this.runs.get(root) ?? null;
  }
  setRun(root: string, run: RunState): void {
    this.runs.set(root, run);
  }
  async start(root: string): Promise<void> {
    this.order.push(`start ${root}`);
    this.started.push(root);
  }
  async stopAllAndRelease(): Promise<void> {
    this.order.push("stopAllAndRelease");
    this.stopped += 1;
  }
  async stepAll(_fresh: Issue[]): Promise<void> {
    this.order.push("stepAll");
    this.steps += 1;
  }
}

function makeShell(
  opts: {
    provider?: FakeProvider;
    coordinator?: FakeCoordinator;
    run?: FakeRunController;
    policy?: ConfirmPolicy;
  } = {},
) {
  const provider = opts.provider ?? new FakeProvider([mk()]);
  const coordinator = opts.coordinator ?? new FakeCoordinator();
  const run = opts.run ?? new FakeRunController();
  const shell = new ShellController({
    provider,
    coordinator: coordinator as unknown as DispatchCoordinator,
    runController: run as unknown as RunController,
    confirmPolicy: opts.policy ?? {},
  });
  return { shell, provider, coordinator, run };
}

// --- the moved key vocabulary ----------------------------------------------

describe("appKeyAction — the key bindings (issue 14 stop)", () => {
  it("maps s to start and shift-s (both parse forms) to stop — never a toggle", () => {
    expect(appKeyAction({ name: "s", shift: false })).toBe("run-start");
    expect(appKeyAction({ name: "s", shift: true })).toBe("run-stop"); // raw terminal
    expect(appKeyAction({ name: "S", shift: true })).toBe("run-stop"); // kitty protocol
  });

  it("keeps the other bindings stable", () => {
    expect(appKeyAction({ name: "q" })).toBe("quit");
    expect(appKeyAction({ name: "escape" })).toBeNull(); // Esc no longer quits — it's a no-op outside a modal
    expect(appKeyAction({ name: "tab" })).toBe("focus");
    expect(appKeyAction({ name: "j" })).toBe("down");
    expect(appKeyAction({ name: "down" })).toBe("down");
    expect(appKeyAction({ name: "k" })).toBe("up");
    expect(appKeyAction({ name: "up" })).toBe("up");
    expect(appKeyAction({ name: "return" })).toBe("dispatch");
    expect(appKeyAction({ name: "x" })).toBe("release");
    expect(appKeyAction({ name: "r" })).toBe("reload");
    expect(appKeyAction({ name: "t" })).toBe("toggle-view");
    expect(appKeyAction({ name: "z" })).toBeNull();
  });

  it("maps Space to collapse in both protocol spellings; Enter stays dispatch (collapsible-categories 02)", () => {
    expect(appKeyAction({ name: " " })).toBe("collapse"); // raw terminal
    expect(appKeyAction({ name: "space" })).toBe("collapse"); // kitty protocol
    expect(appKeyAction({ name: "return" })).toBe("dispatch"); // Enter never folds from the map
  });

  it("never lets the collapse action intercept a modal's keys (the swallow routes to the modal)", () => {
    // While a dialog is open the key handler routes EXCLUSIVELY to modalKeyAction
    // (useKeys checks the modal first), so Space's collapse mapping is unreachable
    // there — Space is a dead key behind the overlay, Enter stays confirm.
    expect(modalKeyAction({ name: " " })).toBeNull();
    expect(modalKeyAction({ name: "space" })).toBeNull();
    expect(modalKeyAction({ name: "return" })).toBe("confirm");
  });

  it("makes q the sole quit key — Esc maps to no action (issue 01)", () => {
    expect(appKeyAction({ name: "escape" })).toBeNull();
    expect(appKeyAction({ name: "q" })).toBe("quit");
  });
});

// --- the confirmation gate --------------------------------------------------

describe("ShellController.request — the gate", () => {
  it("asks for a structurally-actionable dispatch/release/run-start with the gate on", () => {
    const { shell } = makeShell();
    for (const trigger of ["dispatch", "release", "run-start"] as const) {
      const gate = shell.request(trigger, mk());
      expect(gate.kind).toBe("dialog");
      if (gate.kind === "dialog") {
        expect(gate.dialog.trigger).toBe(trigger); // self-describing — App never stores a pending action
        expect(gate.dialog.focusedButton).toBe("confirm");
      }
    }
  });

  it("names the subjects in the dialog copy (live ids/titles/roots/counts)", () => {
    const { shell, run } = makeShell();
    const dispatchGate = shell.request("dispatch", mk());
    if (dispatchGate.kind === "dialog") {
      expect(dispatchGate.dialog.context).toBe("#01 — 01 — X");
    }
    run.setRun("e", {
      id: "run-e", root: "e", status: "running", concurrency: 2, startedAt: 0, issues: [],
    } satisfies RunState);
    const startGate = shell.request("run-start", mk({ id: ".scratch/e/issues/01-x.md" }));
    if (startGate.kind === "dialog") {
      expect(startGate.dialog.context).toBe("e"); // the run-root effort
      expect(startGate.dialog.body).toContain("2 panes"); // the run's concurrency
    }
  });

  it("asks for run-stop only when runs are actually running", () => {
    const { shell, run } = makeShell();
    expect(shell.request("run-stop").kind).toBe("go"); // zero running — structural no-op
    run.runningRuns = 1;
    const gate = shell.request("run-stop");
    expect(gate.kind).toBe("dialog");
    if (gate.kind === "dialog") expect(gate.dialog.trigger).toBe("run-stop");
  });

  it("goes straight through for structural no-ops (dispatch/release need a selection)", () => {
    const { shell } = makeShell();
    expect(shell.request("dispatch").kind).toBe("go");
    expect(shell.request("release").kind).toBe("go");
    expect(shell.request("run-start").kind).toBe("go");
  });

  it("never asks for a non-dispatchable issue (a claimed issue can't dispatch)", () => {
    const { shell } = makeShell();
    expect(shell.request("dispatch", mk({ status: "claimed" })).kind).toBe("go");
  });

  it("goes straight through when the [confirm] policy suppresses a trigger", () => {
    const { shell } = makeShell({ policy: { "run-start": false, dispatch: false } });
    expect(shell.request("run-start", mk()).kind).toBe("go");
    expect(shell.request("dispatch", mk()).kind).toBe("go");
    expect(shell.request("release", mk()).kind).toBe("dialog"); // still gated
  });
});

// --- the verbs --------------------------------------------------------------

describe("ShellController.confirm — the verbs", () => {
  it("dispatches through the coordinator and reports the outcome record", async () => {
    const { shell, coordinator } = makeShell();
    const outcome = await shell.confirm("dispatch", mk());
    expect(coordinator.order).toEqual(["dispatch .scratch/e/issues/01-x.md"]);
    expect(outcome).toEqual({ verb: "dispatch", result: coordinator.dispatchResult });
  });

  it("releases through the coordinator and reports the outcome record", async () => {
    const { shell, coordinator } = makeShell();
    const outcome = await shell.confirm("release", mk());
    expect(coordinator.order).toEqual(["release .scratch/e/issues/01-x.md"]);
    expect(outcome).toEqual({ verb: "release", result: coordinator.releaseResult });
  });

  it("starts a run on the selected issue's run-root — never on the id", async () => {
    const { shell, run } = makeShell();
    const outcome = await shell.confirm("run-start", mk({ id: ".scratch/herdr-frontier/issues/05-iface.md" }));
    expect(run.order).toEqual(["start herdr-frontier"]);
    expect(outcome).toEqual({ verb: "run-start", ran: true });
  });

  it("stops every run + releases through stopAllAndRelease", async () => {
    const { shell, run } = makeShell();
    const outcome = await shell.confirm("run-stop");
    expect(run.order).toEqual(["stopAllAndRelease"]);
    expect(outcome).toEqual({ verb: "run-stop", ran: true });
  });

  it("narrows every outcome verb to exactly one of the ShellOutcome shapes", async () => {
    const { shell } = makeShell();
    const outcomes: ShellOutcome[] = [
      await shell.confirm("dispatch", mk()),
      await shell.confirm("release", mk()),
      await shell.confirm("run-start", mk()),
      await shell.confirm("run-stop"),
    ];
    for (const o of outcomes) {
      if (o.verb === "dispatch" || o.verb === "release") {
        expect(o.result).toBeDefined();
      } else {
        expect(o.ran).toBe(true);
      }
    }
  });
});

// --- load / poll ------------------------------------------------------------

describe("ShellController.load", () => {
  it("fetches a fresh snapshot and reconciles the in-session claims", async () => {
    const { shell, provider, coordinator } = makeShell();
    const res = await shell.load();
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.issues).toEqual([mk()]);
    expect(provider.calls).toEqual(["listIssues"]);
    expect(coordinator.order).toEqual(["reconcileClaims"]);
  });

  it("is loud on failure — the error row, not a throw", async () => {
    const provider = new FakeProvider();
    provider.listIssues = async () => {
      throw new Error("tracker down");
    };
    const { shell, coordinator } = makeShell({ provider });
    const res = await shell.load();
    expect(res).toEqual({ ok: false, error: "tracker down" });
    expect(coordinator.order).toEqual([]); // claims were never touched
  });
});

// --- the poll tick ----------------------------------------------------------

describe("ShellController.tick", () => {
  it("runs the whole reconcile (claims → attention) then steps the runs, in order", async () => {
    const { shell, provider, coordinator, run } = makeShell();
    coordinator.states.set(mk().id, "blocked");
    const res = await shell.tick();
    expect(res).not.toBeNull();
    expect(res!.issues).toEqual([mk()]);
    expect(res!.agentStates.get(mk().id)).toBe("blocked");
    // one provider read + the coordinator's single reconcile + one run-step
    expect(provider.calls).toEqual(["listIssues"]);
    expect(coordinator.order).toEqual(["reconcileTick"]); // the tick's reconcile
    expect(run.order).toEqual(["stepAll"]); // steps after the reconcile
  });

  it("carries the poll loop's own fresh snapshot (no second read)", async () => {
    const { shell, provider, coordinator, run } = makeShell();
    const fresh = [mk({ id: ".scratch/other/issues/2.md", title: "2" })];
    const res = await shell.tick(fresh);
    expect(res!.issues).toBe(fresh);
    expect(provider.calls).toEqual([]); // uses the passed snapshot
    expect(coordinator.order[0]).toBe("reconcileTick");
    expect(run.steps).toBe(1);
  });

  it("is silent on failure — null, apply nothing, next tick retries", async () => {
    const reconcileTick = async () => { throw new Error("herdr agent list failed"); };
    const coordinator = new FakeCoordinator();
    coordinator.reconcileTick = reconcileTick;
    const { shell } = makeShell({ coordinator });
    await expect(shell.tick()).resolves.toBeNull();
  });

  it("returns null when the run-step throws (all-or-nothing apply)", async () => {
    const { shell, run } = makeShell();
    run.stepAll = async () => { throw new Error("bad snapshot"); };
    await expect(shell.tick([mk()])).resolves.toBeNull();
  });
});

// --- the display read accessors ---------------------------------------------

describe("ShellController read accessors", () => {
  it("runFor reads the run state for a run-root", async () => {
    const { shell, run } = makeShell();
    run.setRun("e", {
      id: "run-e", root: "e", status: "running", concurrency: 2, startedAt: 0, issues: [],
    } satisfies RunState);
    const state = shell.runFor("e");
    expect(state).not.toBeNull();
    expect(state!.root).toBe("e");
    expect(shell.runFor("missing")).toBeNull();
  });

  it("readIssue fetches the detail body for an id", async () => {
    const { shell, provider } = makeShell();
    await shell.readIssue(mk().id);
    expect(provider.calls).toEqual(["readIssue .scratch/e/issues/01-x.md"]);
  });
});