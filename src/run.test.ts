// Run-controller tests (issue 14 acceptance). Seams per the spec's Testing
// Decisions:
//   - the pure run-advance state machine (frontier-of-the-run + member status
//     transition) is Seam 2 — plain data, no provider, no IO, no herdr;
//   - the controller is Seam 1 + 3 — a FakeTrackerProvider (in-memory) plus a
//     recording herdr runner (no live herdr), sharing the manual dispatcher's
//     claim mutex through the same ClaimRegistry;
//   - the persistence seam is the injectable RunStore — FileRunStore is tested
//     over a temp state dir (the plugin's HERDR_PLUGIN_STATE_DIR shape).

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AlreadyClaimed, IssueNotFound, type Issue, type IssueDetail, type TrackerProvider } from "./tracker/provider.js";
import { HerdrClient, type HerdrRunner } from "./herdr-client.js";
import { ClaimRegistry, DispatchCoordinator } from "./dispatch.js";
import { DEFAULT_PROFILES } from "./profiles.js";
import { TranscriptIngester } from "./transcript.js";
import {
  advanceRun,
  runScope,
  runIdFor,
  RunController,
  FileRunStore,
  DEFAULT_RUN_CONCURRENCY,
  RUN_CONCURRENCY_KEY,
  type RunState,
} from "./run.js";

const EFFORT = "beads";
const ROOT = ".scratch/other"; // a foreign effort a run must not touch

const idOf = (n: string, slug = "x") => `.scratch/${EFFORT}/issues/${n}-${slug}.md`;
const A = idOf("01");
const B = idOf("02");
const C = idOf("03");
const D = idOf("04");

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const mk = (over: Partial<Issue> = {}): IssueDetail => ({
  id: A,
  title: "01 — A",
  status: "open",
  type: "task",
  labels: ["ready-for-agent"],
  assignee: null,
  blockedBy: [],
  body: "",
  comments: [],
  ...over,
});

const emptyRun = (root: string): RunState => ({
  id: runIdFor(root),
  root,
  status: "running",
  concurrency: DEFAULT_RUN_CONCURRENCY,
  startedAt: NOW,
  issues: [],
});

const memberStatus = (run: RunState, id: string) => run.issues.find((m) => m.id === id)?.status;

/** In-memory FakeTrackerProvider (Seam 1) mirroring the local-markdown claim gate. */
class FakeProvider implements TrackerProvider {
  private readonly issues = new Map<string, IssueDetail>();
  constructor(issues: IssueDetail[]) {
    for (const i of issues) this.issues.set(i.id, i);
  }
  async listIssues(): Promise<Issue[]> {
    return [...this.issues.values()];
  }
  async readIssue(id: string): Promise<IssueDetail> {
    const i = this.issues.get(id);
    if (!i) throw new IssueNotFound(id);
    return i;
  }
  async claim(id: string): Promise<Issue> {
    const i = this.issues.get(id);
    if (!i) throw new IssueNotFound(id);
    if (i.status !== "open") throw new AlreadyClaimed(id, i.status);
    const claimed: IssueDetail = { ...i, status: "claimed" };
    this.issues.set(id, claimed);
    return claimed;
  }
  async release(id: string): Promise<Issue> {
    const i = this.issues.get(id);
    if (!i) throw new IssueNotFound(id);
    const released: IssueDetail = { ...i, status: "open" };
    this.issues.set(id, released);
    return released;
  }
  async updateLabels(id: string): Promise<Issue> {
    return this.readIssue(id);
  }
  async close(id: string, resolution: string): Promise<Issue> {
    this.closed.push({ id, resolution });
    const i = this.issues.get(id);
    if (!i) throw new IssueNotFound(id);
    const done: IssueDetail = { ...i, status: "resolved" };
    this.issues.set(id, done);
    return done;
  }
  async comment(id: string, body: string): Promise<Issue> {
    this.commented.push({ id, body });
    return this.readIssue(id);
  }
  async addBlocking(id: string): Promise<Issue> {
    return this.readIssue(id);
  }
  /** Test helper: flip an issue's status as the tracker would. */
  setStatus(id: string, status: Issue["status"]): void {
    const i = this.issues.get(id);
    if (i) this.issues.set(id, { ...i, status });
  }
  get(id: string): IssueDetail {
    return this.issues.get(id)!;
  }
  /** Issue 17: what the transcript ingester wrote back via close/comment. */
  closed: { id: string; resolution: string }[] = [];
  commented: { id: string; body: string }[] = [];
}

const SCHEMA = JSON.stringify({ schemas: { request: { $defs: { AgentStartParams: { properties: { kind: {} } } } } } });
const ok = (text: unknown) => JSON.stringify({ id: "x", result: text });

/**
 * Recorded-fixture runner (Seam 3): serves the schema, serves each `tab create`
 * with a fresh pane/tab id, and accepts any `agent start` / `agent prompt` —
 * recording every invocation so a test can count dispatches. No live herdr.
 */
function herdrHarness(): { client: HerdrClient; calls: string[][] } {
  const calls: string[][] = [];
  let seq = 0;
  const runner: HerdrRunner = async (args) => {
    calls.push(args);
    const key = args.join(" ");
    if (key === "api schema --json") return { code: 0, stdout: SCHEMA, stderr: "" };
    if (key === "agent list") return { code: 0, stdout: ok({ agents: [] }), stderr: "" };
    if (args[0] === "tab" && args[1] === "create") {
      const n = ++seq;
      return { code: 0, stdout: ok({ tab: { tab_id: `wZ:t${n}` }, root_pane: { pane_id: `wZ:p${n}` } }), stderr: "" };
    }
    if (args[0] === "pane" && args[1] === "wait-output") return { code: 0, stdout: ok({ matched_line: "❯" }), stderr: "" };
    if (args[0] === "agent" && args[1] === "start") return { code: 0, stdout: ok({}), stderr: "" };
    if (args[0] === "agent" && args[1] === "prompt") return { code: 0, stdout: ok({}), stderr: "" };
    if (args[0] === "agent" && args[1] === "read") {
      return { code: 0, stdout: ok({ read: { text: "resolved 01 — driver done" } }), stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `no fixture for: ${key}` };
  };
  return { client: new HerdrClient({ runner }), calls };
}

function harness(
  issues: IssueDetail[],
  over: { concurrency?: number; storeDir?: string; provider?: FakeProvider; transcripts?: TranscriptIngester } = {},
) {
  const provider = over.provider ?? new FakeProvider(issues);
  const claims = new ClaimRegistry();
  const { client, calls } = herdrHarness();
  const coordinator = new DispatchCoordinator({ client, provider, profiles: DEFAULT_PROFILES, claims, cwd: "/repo" });
  const store = new FileRunStore({ dir: over.storeDir ?? join(stateDir, "runs") });
  const controller = new RunController({
    provider,
    coordinator,
    store,
    concurrency: over.concurrency,
    transcripts: over.transcripts,
  });
  return { provider, claims, calls, controller, store, coordinator };
}

let stateDir: string;
beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "beads-run-"));
});
afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

// --- pure run-advance state machine (Seam 2) -------------------------------

describe("runScope", () => {
  it("returns only the issues in the root's effort (nothing outside)", () => {
    const inside = mk({ id: A });
    const outside = mk({ id: `${ROOT}/issues/09-x.md` });
    expect(runScope([inside, outside], EFFORT).map((i) => i.id)).toEqual([A]);
  });
});

describe("runIdFor", () => {
  it("derives a deterministic run id from the root", () => {
    expect(runIdFor(EFFORT)).toBe("run-beads");
    expect(runIdFor("a b/c")).toBe("run-a-b-c");
  });
});

describe("advanceRun — the pure run-advance state machine (issue 14)", () => {
  it("scopes a run to its root's effort — the graph walk, nothing outside", () => {
    const { run } = advanceRun(emptyRun(EFFORT), [mk({ id: A }), mk({ id: B }), mk({ id: `${ROOT}/issues/09-x.md` })], NOW);
    expect(run.issues.map((m) => m.id).sort()).toEqual([A, B].sort());
  });

  it("leaves a blocker-gated issue waiting, then promotes it once the blocker resolves", () => {
    const blocked = mk({ id: B, blockedBy: [A] });
    let { run, eligible } = advanceRun(emptyRun(EFFORT), [mk({ id: A }), blocked], NOW);
    expect(memberStatus(run, B)).toBe("waiting");
    expect(eligible.map((i) => i.id)).toEqual([A]);

    ({ run, eligible } = advanceRun(emptyRun(EFFORT), [{ ...blocked }, mk({ id: A, status: "resolved" })], NOW));
    expect(memberStatus(run, B)).toBe("pending");
    expect(eligible.map((i) => i.id)).toEqual([B]);
  });

  it("derives dispatched from claimed and resolved from resolved", () => {
    const { run } = advanceRun(emptyRun(EFFORT), [mk({ id: A, status: "claimed" }), mk({ id: B, status: "resolved" })], NOW);
    expect(memberStatus(run, A)).toBe("dispatched");
    expect(memberStatus(run, B)).toBe("resolved");
  });

  it("marks wontfix and the wayfinder:map run-root as skipped (never work)", () => {
    const { run } = advanceRun(
      emptyRun(EFFORT),
      [mk({ id: A, labels: ["wontfix"] }), mk({ id: B, labels: ["wayfinder:map"] })],
      NOW,
    );
    expect(memberStatus(run, A)).toBe("skipped");
    expect(memberStatus(run, B)).toBe("skipped");
  });

  it("keeps human-turn issues waiting — never auto-spawned", () => {
    const { run, eligible } = advanceRun(emptyRun(EFFORT), [mk({ id: A, labels: ["ready-for-human"] })], NOW);
    expect(memberStatus(run, A)).toBe("waiting");
    expect(eligible).toHaveLength(0);
  });

  it("auto-mode eligibility is only ready-for-agent + wayfinder:research", () => {
    const { run, eligible } = advanceRun(
      emptyRun(EFFORT),
      [
        mk({ id: A, labels: ["ready-for-agent"] }),
        mk({ id: B, labels: ["wayfinder:research"], type: "research" }),
        mk({ id: C, labels: ["wayfinder:prototype"], type: "prototype" }),
      ],
      NOW,
    );
    expect(memberStatus(run, A)).toBe("pending");
    expect(memberStatus(run, B)).toBe("pending");
    expect(memberStatus(run, C)).toBe("waiting");
    expect(eligible.map((i) => i.id).sort()).toEqual([A, B].sort());
  });

  it("orders eligible issues first-by-number", () => {
    const { eligible } = advanceRun(emptyRun(EFFORT), [mk({ id: C }), mk({ id: A }), mk({ id: B })], NOW);
    expect(eligible.map((i) => i.id)).toEqual([A, B, C]);
  });

  it("completes a run when every member is resolved or skipped", () => {
    const { run } = advanceRun(
      emptyRun(EFFORT),
      [mk({ id: A, status: "resolved" }), mk({ id: B, labels: ["wontfix"] })],
      NOW,
    );
    expect(run.status).toBe("completed");
    expect(run.completedAt).toBe(NOW);
  });

  it("keeps a run running while a human turn is pending (HITL waits for the human)", () => {
    const { run } = advanceRun(emptyRun(EFFORT), [mk({ id: A, labels: ["ready-for-human"] })], NOW);
    expect(run.status).toBe("running");
  });

  it("picks up a new issue that appears in the effort mid-run (the graph walk)", () => {
    const first = advanceRun(emptyRun(EFFORT), [mk({ id: A })], NOW);
    const { run } = advanceRun(first.run, [mk({ id: A }), mk({ id: B })], NOW);
    expect(memberStatus(run, B)).toBe("pending");
  });

  it("does not complete an empty effort's run (no members yet = keep waiting)", () => {
    const { run } = advanceRun(emptyRun(EFFORT), [], NOW);
    expect(run.status).toBe("running");
  });
});

// --- controller (Seam 1 + 3) ------------------------------------------------

describe("RunController", () => {
  it("start walks the root's dependency graph — every issue in the effort becomes a member", async () => {
    const h = harness([mk({ id: A }), mk({ id: B }), mk({ id: `${ROOT}/issues/09-x.md` })]);
    const run = await h.controller.start(EFFORT);
    expect(run.status).toBe("running");
    expect(run.id).toBe("run-beads");
    expect(run.issues.map((m) => m.id).sort()).toEqual([A, B].sort());
    expect(h.store.load(EFFORT)?.id).toBe("run-beads"); // persisted
  });

  it("start is idempotent while a run is running", async () => {
    const h = harness([mk({ id: A })]);
    const first = await h.controller.start(EFFORT);
    const second = await h.controller.start(EFFORT);
    expect(second.startedAt).toBe(first.startedAt);
    expect(second.issues).toHaveLength(1);
  });

  it("dispatches an issue when its blockers resolve — and claims it first", async () => {
    const h = harness([mk({ id: A }), mk({ id: B, blockedBy: [A] })]);
    await h.controller.start(EFFORT);
    await h.controller.stepAll();

    // A is dispatched — and the tracker shows claimed BEFORE the agent ran.
    expect(h.provider.get(A).status).toBe("claimed");
    expect(memberStatus(h.controller.load(EFFORT)!, A)).toBe("dispatched");
    expect(memberStatus(h.controller.load(EFFORT)!, B)).toBe("waiting");
    expect(h.calls.filter((c) => c[0] === "agent" && c[1] === "start")).toHaveLength(1);

    // A resolves → B unblocks → B is dispatched on the next step.
    h.provider.setStatus(A, "resolved");
    await h.controller.stepAll();
    expect(h.provider.get(B).status).toBe("claimed");
    expect(memberStatus(h.controller.load(EFFORT)!, B)).toBe("dispatched");
    expect(h.calls.filter((c) => c[0] === "agent" && c[1] === "start")).toHaveLength(2);
  });

  it("shares the claim mutex with manual dispatch — the run never double-dispatches a held issue", async () => {
    const h = harness([mk({ id: A })]);
    await h.coordinator.dispatchIssue(mk({ id: A })); // manual dispatch wins the claim first
    await h.controller.start(EFFORT);
    await h.controller.stepAll();
    // The run observes A as in-flight (claimed) — but spawns NO second pane.
    expect(h.calls.filter((c) => c[0] === "agent" && c[1] === "start")).toHaveLength(1);
  });

  it("shares the claim mutex with manual dispatch — a manual dispatch of a run-spawned issue is refused", async () => {
    const h = harness([mk({ id: A })]);
    await h.controller.start(EFFORT);
    await h.controller.stepAll(); // the run dispatches A (claimed + mutex held)
    const manual = await h.coordinator.dispatchIssue(mk({ id: A }));
    expect(manual.ok).toBe(false);
    if (!manual.ok) expect(manual.reason).toBe("already-dispatched");
    expect(h.calls.filter((c) => c[0] === "agent" && c[1] === "start")).toHaveLength(1);
  });

  it("caps parallel panes per run at the configured concurrency", async () => {
    const h = harness([mk({ id: A }), mk({ id: B }), mk({ id: C })], { concurrency: 1 });
    await h.controller.start(EFFORT);
    await h.controller.stepAll();
    expect(h.calls.filter((c) => c[0] === "agent" && c[1] === "start")).toHaveLength(1);
    let run = h.controller.load(EFFORT)!;
    expect(run.issues.filter((m) => m.status === "dispatched")).toHaveLength(1);
    expect(run.issues.filter((m) => m.status === "pending")).toHaveLength(2);

    // The in-flight pane resolves → the freed slot dispatches the next issue.
    const inFlight = run.issues.find((m) => m.status === "dispatched")!.id;
    h.provider.setStatus(inFlight, "resolved");
    await h.controller.stepAll();
    expect(h.calls.filter((c) => c[0] === "agent" && c[1] === "start")).toHaveLength(2);
    run = h.controller.load(EFFORT)!;
    expect(run.issues.filter((m) => m.status === "dispatched")).toHaveLength(1);
    expect(run.issues.filter((m) => m.status === "pending")).toHaveLength(1);
  });

  it("reads the concurrency config key when no explicit cap is given (default is the fallback)", async () => {
    process.env[RUN_CONCURRENCY_KEY] = "1";
    try {
      const h = harness([mk({ id: A }), mk({ id: B }), mk({ id: C })]);
      const run = await h.controller.start(EFFORT);
      expect(run.concurrency).toBe(1);
      await h.controller.stepAll();
      expect(h.calls.filter((c) => c[0] === "agent" && c[1] === "start")).toHaveLength(1);
    } finally {
      delete process.env[RUN_CONCURRENCY_KEY];
    }
  });

  it("spawns only the AFK types — ready-for-agent + wayfinder:research; HITL waits", async () => {
    const h = harness([
      mk({ id: A, labels: ["ready-for-agent"] }),
      mk({ id: B, labels: ["wayfinder:research"], type: "research" }),
      mk({ id: C, labels: ["wayfinder:prototype"], type: "prototype" }),
      mk({ id: D, labels: ["ready-for-human"] }),
    ]);
    await h.controller.start(EFFORT);
    await h.controller.stepAll();
    expect(h.calls.filter((c) => c[0] === "agent" && c[1] === "start")).toHaveLength(2);
    const run = h.controller.load(EFFORT)!;
    expect(memberStatus(run, A)).toBe("dispatched");
    expect(memberStatus(run, B)).toBe("dispatched");
    expect(memberStatus(run, C)).toBe("waiting");
    expect(memberStatus(run, D)).toBe("waiting");
  });

  it("completes a run once all its work resolves, then idles", async () => {
    const h = harness([mk({ id: A }), mk({ id: B, blockedBy: [A] })]);
    await h.controller.start(EFFORT);
    await h.controller.stepAll(); // dispatch A
    h.provider.setStatus(A, "resolved");
    await h.controller.stepAll(); // dispatch B
    h.provider.setStatus(B, "resolved");
    await h.controller.stepAll(); // all resolved → completed
    expect(h.controller.load(EFFORT)?.status).toBe("completed");

    const starts = h.calls.filter((c) => c[0] === "agent" && c[1] === "start").length;
    await h.controller.stepAll(); // a completed run does nothing more
    expect(h.calls.filter((c) => c[0] === "agent" && c[1] === "start")).toHaveLength(starts);
  });

  it("persists and rehydrates after a restart — no double-dispatch of in-flight work", async () => {
    const provider = new FakeProvider([mk({ id: A }), mk({ id: B })]);
    const store = new FileRunStore({ dir: join(stateDir, "runs") });

    // First controller "crashes" after dispatching A + B (concurrency 2).
    {
      const claims = new ClaimRegistry();
      const { client } = herdrHarness();
      const coordinator = new DispatchCoordinator({ client, provider, profiles: DEFAULT_PROFILES, claims, cwd: "/repo" });
      const first = new RunController({ provider, coordinator, store, concurrency: 2 });
      await first.start(EFFORT);
      await first.stepAll();
      expect(store.load(EFFORT)!.issues.filter((m) => m.status === "dispatched")).toHaveLength(2);
    }

    // Fresh controller over the same store + provider + a fresh claim mutex.
    const claims2 = new ClaimRegistry();
    const { client: client2, calls: calls2 } = herdrHarness();
    const coordinator2 = new DispatchCoordinator({ client: client2, provider, profiles: DEFAULT_PROFILES, claims: claims2, cwd: "/repo" });
    const second = new RunController({ provider, coordinator: coordinator2, store, concurrency: 2 });

    const rehydrated = second.load(EFFORT)!;
    expect(rehydrated.status).toBe("running");
    expect(rehydrated.issues.filter((m) => m.status === "dispatched")).toHaveLength(2);

    // The rehydrated controller must not re-dispatch the in-flight (claimed) work.
    await second.stepAll();
    expect(calls2.filter((c) => c[0] === "agent" && c[1] === "start")).toHaveLength(0);

    // And it keeps walking: resolve A → B (already in-flight) is not re-spawned either.
    provider.setStatus(A, "resolved");
    await second.stepAll();
    expect(calls2.filter((c) => c[0] === "agent" && c[1] === "start")).toHaveLength(0);
  });

  it("stop marks a run stopped (idles without dispatching more)", async () => {
    const h = harness([mk({ id: A }), mk({ id: B })]);
    await h.controller.start(EFFORT);
    await h.controller.stop(EFFORT);
    expect(h.controller.load(EFFORT)?.status).toBe("stopped");
    await h.controller.stepAll();
    expect(h.calls.some((c) => c[0] === "agent" && c[1] === "start")).toBe(false);
  });

  it("restart after stop replaces the stopped run with a fresh one (s toggle)", async () => {
    const h = harness([mk({ id: A }), mk({ id: B })]);
    await h.controller.start(EFFORT);
    await h.controller.stop(EFFORT);
    const fresh = await h.controller.start(EFFORT);
    expect(fresh.status).toBe("running");
    // A stopped run is replaced, not returned as-is: the snapshot is fresh (all
    // pending) and stepAll dispatches again — a stopped run would idle.
    expect(h.controller.load(EFFORT)?.issues.every((m) => m.status === "pending")).toBe(true);
    await h.controller.stepAll();
    expect(h.calls.filter((c) => c[0] === "agent" && c[1] === "start")).toHaveLength(2);
  });

  it("a stopped run stops re-spawning issues reopened by hand (manual tab close then md edit)", async () => {
    const h = harness([mk({ id: A }), mk({ id: B })]);
    await h.controller.start(EFFORT);
    await h.controller.stepAll(); // dispatch A + B → tabs spawn
    expect(h.calls.filter((c) => c[0] === "agent" && c[1] === "start")).toHaveLength(2);

    // Manual tab close: the pane is gone but the tracker still says claimed. The
    // poll confirms the claims (tracker shows claimed), then the user edits the
    // md back to open → reconcileClaims releases the confirmed claim, so the
    // running run re-dispatches it.
    h.coordinator.reconcileClaims(await h.provider.listIssues()); // confirm A + B
    h.provider.setStatus(A, "open");
    h.coordinator.reconcileClaims(await h.provider.listIssues()); // release A
    await h.controller.stepAll(await h.provider.listIssues());
    expect(h.calls.filter((c) => c[0] === "agent" && c[1] === "start")).toHaveLength(3);

    // Stopping the run must end the re-spawn for good, even when md edits follow.
    await h.controller.stop(EFFORT);
    h.provider.setStatus(B, "open");
    h.coordinator.reconcileClaims(await h.provider.listIssues());
    await h.controller.stepAll(await h.provider.listIssues());
    await h.controller.stepAll(await h.provider.listIssues());
    expect(h.calls.filter((c) => c[0] === "agent" && c[1] === "start")).toHaveLength(3);
  });

  it("stopAll stops every running run (the dedicated S key — a stopped run idles)", async () => {
    const other = ".scratch/other"; // a second effort's run-root
    const h = harness([mk({ id: A }), mk({ id: B })]);
    const h2 = harness([mk({ id: `${other}/issues/01-x.md` })], {
      provider: h.provider,
      storeDir: join(stateDir, "runs"),
    });
    // Two running runs (each bound to its own effort) over one shared store.
    await h.controller.start(EFFORT);
    await h2.controller.start(other);
    expect(h.controller.load(EFFORT)?.status).toBe("running");
    expect(h2.controller.load(other)?.status).toBe("running");

    // The dedicated stop key stops every running run, not just the selected
    // effort's — so auto-dispatch ends even when the selection is elsewhere.
    await h.controller.stopAll();
    expect(h.controller.load(EFFORT)?.status).toBe("stopped");
    expect(h2.controller.load(other)?.status).toBe("stopped");

    // Both idle now — md edits can't re-spawn either run.
    await h.controller.stepAll();
    await h2.controller.stepAll();
    expect(h.calls.filter((c) => c[0] === "agent" && c[1] === "start")).toHaveLength(0);
    expect(h2.calls.filter((c) => c[0] === "agent" && c[1] === "start")).toHaveLength(0);
  });

  it("stopAllAndRelease stops every run AND releases its in-flight panes (S = the x-loop in one key)", async () => {
    const h = harness([mk({ id: A }), mk({ id: B }), mk({ id: C })]);
    await h.controller.start(EFFORT);
    await h.controller.stepAll(); // dispatch A + B + C (concurrency 3)
    const run = h.controller.load(EFFORT)!;
    expect(run.issues.filter((m) => m.status === "dispatched")).toHaveLength(3);
    expect(h.provider.get(A).status).toBe("claimed");

    const stopped = await h.controller.stopAllAndRelease();
    expect(stopped).toBe(1);

    // The run is stopped and every in-flight pane was released back to open
    // (the provider claim dropped, its tab closed) — what x does per-issue.
    expect(h.controller.load(EFFORT)?.status).toBe("stopped");
    expect(h.provider.get(A).status).toBe("open");
    expect(h.provider.get(B).status).toBe("open");
    expect(h.provider.get(C).status).toBe("open");
    expect(h.calls.filter((c) => c[0] === "tab" && c[1] === "close")).toHaveLength(3);

    // Nothing left to spawn — edits can't resurrect the run.
    h.provider.setStatus(A, "open");
    await h.controller.stepAll();
    expect(h.calls.filter((c) => c[0] === "agent" && c[1] === "start")).toHaveLength(3);
  });

  // --- running-runs accessor (issue 02) -------------------------------------

  it("runningRuns is zero for an empty store", () => {
    const h = harness([]);
    expect(h.controller.runningRuns).toBe(0);
  });

  it("runningRuns counts only the currently running runs — stopped and completed never count", async () => {
    const h = harness([mk({ id: A })]);
    await h.controller.start(EFFORT);
    expect(h.controller.runningRuns).toBe(1);

    // A mixed store: terminal records sit beside the running one.
    h.store.save({ ...emptyRun("done"), status: "completed", completedAt: NOW });
    h.store.save({ ...emptyRun("stopped"), status: "stopped" });
    expect(h.controller.runningRuns).toBe(1);

    // Once the running run is stopped too, nothing counts.
    await h.controller.stop(EFFORT);
    expect(h.controller.runningRuns).toBe(0);
  });

  // The gate's live copy facts (issue 05): run-start names the controller's
  // effective concurrency cap, run-stop the store's in-flight tally.
  it("concurrency reflects the deps override, then the env key, then the default", () => {
    expect(harness([], { concurrency: 5 }).controller.concurrency).toBe(5);
    process.env[RUN_CONCURRENCY_KEY] = "2";
    try {
      expect(harness([]).controller.concurrency).toBe(2);
      expect(harness([], { concurrency: 7 }).controller.concurrency).toBe(7); // deps beat env
    } finally {
      delete process.env[RUN_CONCURRENCY_KEY];
    }
    expect(harness([]).controller.concurrency).toBe(DEFAULT_RUN_CONCURRENCY);
  });

  it("inflightCount totals the dispatched members across running runs only", async () => {
    const h = harness([mk({ id: A }), mk({ id: B }), mk({ id: C })], { concurrency: 3 });
    await h.controller.start(EFFORT);
    await h.controller.stepAll(); // dispatch A + B + C
    expect(h.controller.inflightCount).toBe(3);

    // A resolved member leaves the in-flight tally.
    h.provider.setStatus(A, "resolved");
    await h.controller.stepAll();
    expect(h.controller.inflightCount).toBe(2);

    // A terminal run (stopped) never counts — it releases nothing in-flight.
    await h.controller.stop(EFFORT);
    expect(h.controller.inflightCount).toBe(0);
  });

  // --- transcript ingestion (issue 17) --------------------------------------

  it("ingests a finished member's output via the wired ingester — comment on a resolved issue", async () => {
    const provider = new FakeProvider([mk({ id: A }), mk({ id: B, blockedBy: [A] })]);
    const ingester = new TranscriptIngester({
      client: herdrHarness().client,
      provider,
      repoRoot: "/repo",
      config: {},
    });
    const h = harness([], { provider, transcripts: ingester });
    await h.controller.start(EFFORT);
    await h.controller.stepAll(); // dispatch A
    h.provider.setStatus(A, "resolved");
    await h.controller.stepAll(); // A resolves → the run ingests its transcript

    expect(h.provider.commented).toEqual([{ id: A, body: "resolved 01 — driver done" }]);
    expect(h.provider.closed).toEqual([]);
    const run = h.controller.load(EFFORT)!;
    expect(memberStatus(run, A)).toBe("resolved");
    expect(run.issues.find((m) => m.id === A)!.ingested).toBe(true); // persisted
  });

  it("records the profile kind on dispatch and never re-ingests a completed member (restart-safe)", async () => {
    const provider = new FakeProvider([mk({ id: A })]);
    const store = new FileRunStore({ dir: join(stateDir, "runs") });

    {
      const claims = new ClaimRegistry();
      const { client } = herdrHarness();
      const coordinator = new DispatchCoordinator({ client, provider, profiles: DEFAULT_PROFILES, claims, cwd: "/repo" });
      const ingester = new TranscriptIngester({ client, provider, repoRoot: "/repo", config: {} });
      const first = new RunController({ provider, coordinator, store, transcripts: ingester });
      await first.start(EFFORT);
      await first.stepAll();
      const run = first.load(EFFORT)!;
      expect(run.issues.find((m) => m.id === A)!.kind).toBe("opencode"); // recorded at dispatch
      provider.setStatus(A, "resolved");
      await first.stepAll();
      expect(provider.commented).toHaveLength(1);
    }

    // Restart over the same store + provider: the persisted ingested flag stops
    // a second write-back (and a second agent read).
    const claims2 = new ClaimRegistry();
    const { client: client2, calls: calls2 } = herdrHarness();
    const coordinator2 = new DispatchCoordinator({ client: client2, provider, profiles: DEFAULT_PROFILES, claims: claims2, cwd: "/repo" });
    const ingester2 = new TranscriptIngester({ client: client2, provider, repoRoot: "/repo", config: {} });
    const second = new RunController({ provider, coordinator: coordinator2, store, transcripts: ingester2 });
    await second.stepAll();
    expect(provider.commented).toHaveLength(1);
    expect(calls2.some((c) => c[0] === "agent" && c[1] === "read")).toBe(false);
  });

  it("ingestion failure is best-effort — the run completes, the member records the error", async () => {
    const provider = new FakeProvider([mk({ id: A })]);
    const failingClient = new HerdrClient({
      runner: async () => ({ code: 1, stdout: "", stderr: "agent read boom" }),
    });
    const ingester = new TranscriptIngester({ client: failingClient, provider, repoRoot: "/repo", config: {} });
    const h = harness([], { provider, transcripts: ingester });
    await h.controller.start(EFFORT);
    await h.controller.stepAll();
    provider.setStatus(A, "resolved");
    await h.controller.stepAll(); // the ingest read throws — swallowed

    const run = h.controller.load(EFFORT)!;
    const member = run.issues.find((m) => m.id === A)!;
    expect(run.status).toBe("completed"); // a broken ingest never wedges the run
    expect(member.ingested).toBeFalsy(); // never marked ingested → retryable
    expect(member.ingestError).toMatch(/agent read boom/);
    expect(provider.commented).toEqual([]);
    expect(provider.closed).toEqual([]);
  });
});

// --- persistence seam (FileRunStore over the plugin state dir) --------------

describe("FileRunStore", () => {
  it("round-trips a run and a fresh instance re-reads it (crash rehydrate)", () => {
    const dir = join(stateDir, "runs");
    const store = new FileRunStore({ dir });
    store.save(emptyRun(EFFORT));
    expect(store.load(EFFORT)?.id).toBe("run-beads");
    expect(new FileRunStore({ dir }).load(EFFORT)?.id).toBe("run-beads");
  });

  it("load returns null for a run that was never stored", () => {
    expect(new FileRunStore({ dir: join(stateDir, "runs") }).load("nope")).toBeNull();
  });

  it("all() lists every stored run", () => {
    const store = new FileRunStore({ dir: join(stateDir, "runs") });
    store.save(emptyRun("a"));
    store.save(emptyRun("b"));
    expect(store.all().map((r) => r.root).sort()).toEqual(["a", "b"]);
  });

  it("remove deletes a run's file (cleanup)", () => {
    const store = new FileRunStore({ dir: join(stateDir, "runs") });
    store.save(emptyRun(EFFORT));
    store.remove(EFFORT);
    expect(store.load(EFFORT)).toBeNull();
  });

  it("prune removes terminal runs older than the retention window, keeping running + recent ones", () => {
    const store = new FileRunStore({ dir: join(stateDir, "runs") });
    const old = Date.now() - 20 * DAY;
    store.save({ ...emptyRun("a"), status: "completed", completedAt: old });
    store.save({ ...emptyRun("b"), status: "completed", completedAt: Date.now() });
    store.save({ ...emptyRun("c"), status: "running", startedAt: old });
    store.prune(7 * DAY);
    expect(store.all().map((r) => r.root).sort()).toEqual(["b", "c"]);
  });
});
