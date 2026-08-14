// Dispatch-flow tests (issue 12 acceptance): the manual single-issue dispatch.
//
//   `Enter` → claim (mutex) → build the `agent start` vector from the profile
//   → prompt the agent with `/implement {id}` (`{id}` = the issue's identity:
//   the repo-relative `.md` path for local-markdown, the tracker's native id for
//   other providers).
//
// Seam 1 + 3 together: a FakeTrackerProvider (in-memory, mirrors the contract
// incl. AlreadyClaimed) and a recording fixture runner (no live herdr). The
// shared claim mutex — a concurrent second dispatch of the same Issue — is
// tested via ClaimRegistry + the coordinator.

import { describe, it, expect } from "bun:test";
import {
  AlreadyClaimed,
  ClaimBusy,
  IssueNotFound,
  type Issue,
  type IssueDetail,
  type TrackerProvider,
} from "./tracker/provider.js";
import { HerdrClient, type HerdrRunner } from "./herdr-client.js";
import {
  ClaimRegistry,
  DispatchCoordinator,
} from "./dispatch.js";
import type { ProfilesConfig } from "./profiles.js";

const ID = ".scratch/herdr-beads/issues/12-driver.md";
const BODY = "## What to build\n\nA herdr driver with an injectable runner.";

const mk = (over: Partial<Issue> = {}): IssueDetail => ({
  id: ID,
  title: "12 — Driver",
  status: "open",
  type: "task",
  labels: ["ready-for-agent"],
  assignee: null,
  blockedBy: [],
  body: BODY,
  comments: [],
  ...over,
});

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
  async close(id: string): Promise<Issue> {
    return this.readIssue(id);
  }
  async comment(id: string): Promise<Issue> {
    return this.readIssue(id);
  }
  async addBlocking(id: string): Promise<Issue> {
    return this.readIssue(id);
  }
}

/** Recorded fixture runner: serves canned stdout, records every invocation.
 *  A fixture value beginning with `__FAIL__:` returns exit 1 with the rest as
 *  stderr (so a test can simulate a failing herdr command). */
function recordingRunner(fixtures: Record<string, string>): { runner: HerdrRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: HerdrRunner = async (args) => {
    calls.push(args);
    const key = args.join(" ");
    const stdout = fixtures[key];
    if (stdout === undefined) return { code: 1, stdout: "", stderr: `no fixture for: ${key}` };
    if (stdout.startsWith("__FAIL__:")) return { code: 1, stdout: "", stderr: stdout.slice("__FAIL__:".length) };
    return { code: 0, stdout, stderr: "" };
  };
  return { runner, calls };
}

const ok = (text: unknown) => JSON.stringify({ id: "x", result: text });
const TAB_OK = ok({ tab: { tab_id: "wZ:t2" }, root_pane: { pane_id: "wZ:p3" } });
const SCHEMA = JSON.stringify({ schemas: { request: { $defs: { AgentStartParams: { properties: { kind: {} } } } } } });

/** A config where the implement profile carries a model passed raw in args. */
const PROFILES: ProfilesConfig = {
  profiles: { implement: { kind: "opencode", args: ["-m", "claude-sonnet-4-5"] } },
  default_profile: { kind: "pi", args: [] },
};

const CWD = "/repo";

function harness(
  issues: IssueDetail[],
  over: { fixtures?: Record<string, string>; grace?: number; provider?: FakeProvider } = {},
) {
  const provider = over.provider ?? new FakeProvider(issues);
  const claims = new ClaimRegistry();
  const { runner, calls } = recordingRunner({
    "api schema --json": SCHEMA,
    [`tab create --cwd ${CWD} --label 12 — Driver --no-focus`]: TAB_OK,
    "agent start herdr-beads-12 --kind opencode --pane wZ:p3 --timeout 120000 -- -m claude-sonnet-4-5": ok({}),
    [`agent prompt herdr-beads-12 /implement ${ID}`]: ok({}),
    ...over.fixtures,
  });
  const client = new HerdrClient({ runner });
  const coordinator = new DispatchCoordinator({
    client,
    provider,
    profiles: PROFILES,
    claims,
    cwd: CWD,
    deadDispatchGraceMs: over.grace,
  });
  return { provider, claims, calls, coordinator };
}

describe("ClaimRegistry (the shared claim mutex)", () => {
  it("grants one claim and refuses the second until released", () => {
    const reg = new ClaimRegistry();
    expect(reg.tryClaim(ID)).toBe(true);
    expect(reg.tryClaim(ID)).toBe(false);
    reg.release(ID);
    expect(reg.tryClaim(ID)).toBe(true);
  });
});

describe("DispatchCoordinator.dispatchIssue", () => {
  it("claims, prompts with /implement {id} (the issue's identity), and builds the agent-start vector from the profile", async () => {
    const h = harness([mk()]);
    const result = await h.coordinator.dispatchIssue(mk());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // For local-markdown `{id}` is the repo-relative .md path — the same id the
    // agent (via /implement) resolves. The body is never embedded.
    expect(result.command).toBe(`/implement ${ID}`);
    expect(result.kind).toBe("opencode");
    expect(result.args).toEqual(["-m", "claude-sonnet-4-5"]);
    expect(result.paneId).toBe("wZ:p3");

    // The dispatcher claims atomically BEFORE any work (issue 12 acceptance #1):
    // `Status: claimed` is written before the agent is ever started — the
    // cross-process mutex intent, not something left to the agent.
    expect((await h.provider.readIssue(ID)).status).toBe("claimed");

    // The herdr invocations: tab → agent start → (lazy schema introspection, at
    // first start-agent) → prompt, in schema-driven order.
    expect(h.calls.map((c) => c.join(" "))).toEqual([
      "tab create --cwd /repo --label 12 — Driver --no-focus",
      "api schema --json",
      "agent start herdr-beads-12 --kind opencode --pane wZ:p3 --timeout 120000 -- -m claude-sonnet-4-5",
      `agent prompt herdr-beads-12 /implement ${ID}`,
    ]);
  });

  it("prevents a concurrent second dispatch of the same issue (shared mutex, no second claim)", async () => {
    const h = harness([mk()]);
    const first = await h.coordinator.dispatchIssue(mk());
    const second = await h.coordinator.dispatchIssue(mk());

    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, issue: mk(), command: `/implement ${ID}`, reason: "already-dispatched" });
    // Only one agent-start invocation ever happened — no double-dispatch.
    expect(h.calls.filter((c) => c[0] === "agent" && c[1] === "start")).toHaveLength(1);
  });

  it("closes the tab it created when the handoff fails (no orphan tab leak)", async () => {
    // startAgent fails (e.g. `agent_pane_busy`) AFTER tab create succeeded. The
    // dispatch rethrows, but first closes the just-created tab so a failed
    // dispatch doesn't leak a bare-shell tab, and frees the in-session mutex.
    // (The tracker claim stays until `releaseIssue`/manual reset — no un-claim.)
    const h = harness(
      [mk()],
      {
        fixtures: {
          "agent start herdr-beads-12 --kind opencode --pane wZ:p3 --timeout 120000 -- -m claude-sonnet-4-5":
            "__FAIL__: agent_pane_busy: not an available shell",
          "tab close wZ:t2": ok({}),
        },
      },
    );
    await expect(h.coordinator.dispatchIssue(mk())).rejects.toThrow(/agent_pane_busy/);
    expect(h.calls.map((c) => c.join(" "))).toContain("tab close wZ:t2");
    expect(h.claims.tryClaim(ID)).toBe(true); // mutex freed → retryable
  });

  it("reports already-claimed when the issue isn't open (in-flight or done — status gate)", async () => {
    const h = harness([mk({ status: "claimed" })]);
    const result = await h.coordinator.dispatchIssue(mk({ status: "claimed" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("already-claimed");
    expect(h.calls.some((c) => c[0] === "agent" && c[1] === "start")).toBe(false);
  });

  it("surfaces a cross-process race: provider.claim throws AlreadyClaimed between load and dispatch", async () => {
    // The loaded snapshot was `open`, but a concurrent process claimed it
    // between our load and our dispatch — the authoritative `provider.claim`
    // throws AlreadyClaimed (the cross-process mutex doing its job, issue 12
    // acceptance #3). We surface it as already-claimed, free the in-session
    // mutex, and never reach herdr.
    const contended = new FakeProvider([mk()]); // starts open
    await contended.claim(ID); // another process wins the race
    const h = harness([mk()], { provider: contended });
    // We pass the stale `open` snapshot (what we loaded before the race).
    const result = await h.coordinator.dispatchIssue(mk({ status: "open" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("already-claimed");
    expect(h.claims.tryClaim(ID)).toBe(true); // session mutex freed for retry
    expect(h.calls.some((c) => c[0] === "agent" && c[1] === "start")).toBe(false);
  });

  it("surfaces ClaimBusy (contended/stale lock) as a retryable claim-busy failure", async () => {
    // The provider's claim lock is contended or stale — `provider.claim` raises
    // ClaimBusy. The critical section never ran, so the issue is STILL open (no
    // status write) and the dispatch is retryable once the lock clears. We surface
    // it as claim-busy, free the in-session mutex, and never reach herdr.
    class BusyProvider extends FakeProvider {
      override async claim(): Promise<Issue> {
        throw new ClaimBusy(ID);
      }
    }
    const h = harness([mk()], { provider: new BusyProvider([mk()]) });
    const result = await h.coordinator.dispatchIssue(mk());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("claim-busy");
    expect(h.claims.tryClaim(ID)).toBe(true); // session mutex freed — retryable
    expect((await h.provider.readIssue(ID)).status).toBe("open"); // no write happened
    expect(h.calls.some((c) => c[0] === "agent" && c[1] === "start")).toBe(false);
  });

  it("never claims or dispatches a human turn", async () => {
    const human = mk({ labels: ["ready-for-human"] });
    const h = harness([human]);
    const result = await h.coordinator.dispatchIssue(human);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not-dispatchable");
    expect((await h.provider.readIssue(ID)).status).toBe("open");
    expect(h.calls.some((c) => c[0] === "agent" && c[1] === "start")).toBe(false);
  });

  it("never holds the mutex when the status gate blocks dispatch (retry stays possible)", async () => {
    const h = harness([mk({ status: "claimed" })]);
    const result = await h.coordinator.dispatchIssue(mk({ status: "claimed" }));
    expect(result.ok).toBe(false);
    expect(h.claims.tryClaim(ID)).toBe(true); // never claimed — free for a valid issue
  });

  it("reconcileClaims releases an id the implement skill reset back to open (re-dispatchable)", async () => {
    const h = harness([mk()]);
    // Dispatch succeeds — the implement skill later claims (status → claimed).
    await h.coordinator.dispatchIssue(mk());
    expect(h.claims.has(ID)).toBe(true);
    h.coordinator.reconcileClaims([mk({ status: "claimed" })]);
    expect(h.claims.isConfirmed(ID)).toBe(true); // handoff confirmed
    expect(h.claims.has(ID)).toBe(true); // still held while in-flight
    // User resets it to open — reconcile sees open+confirmed → release.
    h.coordinator.reconcileClaims([mk({ status: "open" })]);
    expect(h.claims.has(ID)).toBe(false); // now re-dispatchable
  });

  it("reconcileClaims keeps an unconfirmed open id held (handoff window)", async () => {
    const h = harness([mk()]);
    await h.coordinator.dispatchIssue(mk());
    // Implement hasn't claimed yet — status still open, never confirmed.
    h.coordinator.reconcileClaims([mk({ status: "open" })]);
    expect(h.claims.has(ID)).toBe(true); // handoff window — keep holding
  });

  it("reconcileClaims releases an id the implement skill finished (resolved)", async () => {
    const h = harness([mk()]);
    await h.coordinator.dispatchIssue(mk());
    h.coordinator.reconcileClaims([mk({ status: "resolved" })]);
    expect(h.claims.has(ID)).toBe(false);
  });

  it("reconcileDeadDispatches releases a dispatch whose tab was closed before claiming", async () => {
    // grace 0 so the just-dispatched claim is immediately eligible; the agent
    // list is empty → the pane is gone → release (re-dispatchable).
    const h = harness([mk()], { grace: 0, fixtures: { "agent list": ok({ agents: [] }) } });
    await h.coordinator.dispatchIssue(mk());
    expect(h.claims.has(ID)).toBe(true);
    await h.coordinator.reconcileDeadDispatches();
    expect(h.claims.has(ID)).toBe(false);
  });

  it("reconcileDeadDispatches keeps a dispatch whose agent is still alive (not yet claimed)", async () => {
    // Agent still registered against the dispatched pane → it's just slow to
    // claim → keep holding (no premature release / duplicate dispatch).
    const h = harness(
      [mk()],
      { grace: 0, fixtures: { "agent list": ok({ agents: [{ agent_status: "working", pane_id: "wZ:p3" }] }) } },
    );
    await h.coordinator.dispatchIssue(mk());
    await h.coordinator.reconcileDeadDispatches();
    expect(h.claims.has(ID)).toBe(true);
  });

  it("reconcileDeadDispatches skips confirmed dispatches (the tracker owns those)", async () => {
    // Confirmed (claimed) but agent list empty — still held: status reconciles it.
    const h = harness([mk()], { grace: 0, fixtures: { "agent list": ok({ agents: [] }) } });
    await h.coordinator.dispatchIssue(mk());
    h.coordinator.reconcileClaims([mk({ status: "claimed" })]);
    await h.coordinator.reconcileDeadDispatches();
    expect(h.claims.has(ID)).toBe(true);
  });

  it("reconcileDeadDispatches respects the grace window (just dispatched, never checked)", async () => {
    const h = harness([mk()], { grace: 60_000, fixtures: { "agent list": ok({ agents: [] }) } });
    await h.coordinator.dispatchIssue(mk());
    await h.coordinator.reconcileDeadDispatches();
    expect(h.claims.has(ID)).toBe(true); // within grace — not yet eligible
    expect(h.calls.some((c) => c[0] === "agent" && c[1] === "list")).toBe(false); // didn't even query
  });

  it("pollAgentStates maps the live agent list onto dispatched issues (issue 13)", async () => {
    // The ~2s poll's payload: for each in-flight dispatch, the agent_status of
    // the pane it landed in. The coordinator owns the pane-id mapping; the pure
    // mapping lives in agent-state.ts. Here we wire the seam end-to-end.
    const h = harness(
      [mk()],
      {
        fixtures: {
          "agent list": ok({
            agents: [
              { agent: "opencode", agent_status: "blocked", pane_id: "wZ:p3" }, // our dispatch
              { agent: "claude", agent_status: "working", pane_id: "wW:other" }, // foreign pane
            ],
          }),
        },
      },
    );
    await h.coordinator.dispatchIssue(mk()); // claims + creates pane wZ:p3
    const states = await h.coordinator.pollAgentStates();
    expect(states.get(ID)).toBe("blocked");
    expect(states.size).toBe(1); // the foreign pane isn't ours
  });

  it("pollAgentStates drops an issue whose pane is gone (no stale entry)", async () => {
    const h = harness(
      [mk()],
      { fixtures: { "agent list": ok({ agents: [] }) } }, // our pane vanished
    );
    await h.coordinator.dispatchIssue(mk());
    const states = await h.coordinator.pollAgentStates();
    expect(states.has(ID)).toBe(false);
  });
});

// Issue 13: the attention watcher — diffs successive snapshots and fires a
// `herdr notification show` toast when an issue newly needs a human (became
// ready-for-human, or its dispatched agent went blocked). The coordinator owns
// the herdr client + the prev-state memory; the pure diff lives in agent-state.ts.
describe("DispatchCoordinator.reconcileAttention (issue 13)", () => {
  it("fires a notification when an issue newly becomes ready-for-human", async () => {
    const h = harness(
      [mk({ labels: ["ready-for-agent"] })],
      { fixtures: { "agent list": ok({ agents: [] }) } },
    );
    // First tick — baseline, no transitions (the provider still shows the old label).
    await h.coordinator.reconcileAttention([mk({ labels: ["ready-for-agent"] })]);
    expect(h.calls.some((c) => c[0] === "notification")).toBe(false);
    // Second tick — the tracker now shows ready-for-human → fire the toast.
    await h.coordinator.reconcileAttention([mk({ labels: ["ready-for-human"] })]);
    const note = h.calls.find((c) => c[0] === "notification");
    expect(note).toBeDefined();
    expect(note![1]).toBe("show");
    expect(note![2]).toContain("#12"); // the title carries the issue id
    expect(note!).toContain("--sound"); // the handoff beat (research 01 §4)
    expect(note!).toContain("request");
  });

  it("fires a notification when a dispatched agent newly goes blocked", async () => {
    // The issue is dispatched (claimed). First poll the agent is working; the
    // next poll it goes blocked → fire the toast. The harness fixture map is
    // immutable per test, so use a scripted runner that advances `agent list`
    // through a working → blocked → blocked sequence.
    const open = mk({ status: "open" }); // what dispatchIssue sees
    const claimed = mk({ status: "claimed" }); // what the tracker shows after claim
    const script = [
      ok({ agents: [{ agent: "opencode", agent_status: "working", pane_id: "wZ:p3" }] }),
      ok({ agents: [{ agent: "opencode", agent_status: "blocked", pane_id: "wZ:p3" }] }),
      ok({ agents: [{ agent: "opencode", agent_status: "blocked", pane_id: "wZ:p3" }] }),
    ];
    let listStep = 0;
    const calls: string[][] = [];
    const scriptedRunner: HerdrRunner = async (args) => {
      calls.push(args);
      const key = args.join(" ");
      if (key === "agent list") {
        return { code: 0, stdout: script[listStep++] ?? script[script.length - 1]!, stderr: "" };
      }
      if (key === "api schema --json") return { code: 0, stdout: SCHEMA, stderr: "" };
      if (key === `tab create --cwd ${CWD} --label 12 — Driver --no-focus`) return { code: 0, stdout: TAB_OK, stderr: "" };
      if (key === "agent start herdr-beads-12 --kind opencode --pane wZ:p3 --timeout 120000 -- -m claude-sonnet-4-5") {
        return { code: 0, stdout: ok({}), stderr: "" };
      }
      if (key === `agent prompt herdr-beads-12 /implement ${ID}`) return { code: 0, stdout: ok({}), stderr: "" };
      if (key.startsWith("notification show")) return { code: 0, stdout: ok({}), stderr: "" };
      return { code: 1, stdout: "", stderr: `no fixture for: ${key}` };
    };
    const provider = new FakeProvider([open]); // starts open → dispatch can claim
    const claims = new ClaimRegistry();
    const client = new HerdrClient({ runner: scriptedRunner });
    const coordinator = new DispatchCoordinator({
      client, provider, profiles: PROFILES, claims, cwd: CWD,
    });
    await coordinator.dispatchIssue(open); // claims + creates pane wZ:p3
    await coordinator.reconcileAttention([claimed]); // tick 1: working → no toast
    expect(calls.some((c) => c[0] === "notification")).toBe(false);
    await coordinator.reconcileAttention([claimed]); // tick 2: blocked → toast fires
    expect(calls.filter((c) => c[0] === "notification")).toHaveLength(1);
    await coordinator.reconcileAttention([claimed]); // tick 3: stays blocked → no re-fire
    expect(calls.filter((c) => c[0] === "notification")).toHaveLength(1);
  });

  it("does not re-fire while the human-turn state persists (idempotent)", async () => {
    const h = harness([mk()], { fixtures: { "agent list": ok({ agents: [] }) } });
    await h.coordinator.reconcileAttention([mk({ labels: ["ready-for-agent"] })]); // prime (no fire)
    await h.coordinator.reconcileAttention([mk({ labels: ["ready-for-human"] })]); // transition → fires
    expect(h.calls.filter((c) => c[0] === "notification")).toHaveLength(1);
    await h.coordinator.reconcileAttention([mk({ labels: ["ready-for-human"] })]); // stays — no re-fire
    expect(h.calls.filter((c) => c[0] === "notification")).toHaveLength(1);
  });

  it("returns the live agent-state map for the signal (issue-id → status)", async () => {
    const h = harness(
      [mk()], // open → dispatch can claim
      {
        fixtures: {
          "agent list": ok({ agents: [{ agent: "opencode", agent_status: "blocked", pane_id: "wZ:p3" }] }),
        },
      },
    );
    await h.coordinator.dispatchIssue(mk()); // claims + creates pane wZ:p3
    const states = await h.coordinator.reconcileAttention([mk({ status: "claimed" })]);
    expect(states.get(ID)).toBe("blocked");
  });
});

describe("ClaimRegistry (tab tracking)", () => {
  it("records and returns the tab a dispatch landed in", () => {
    const reg = new ClaimRegistry();
    reg.tryClaim(ID);
    expect(reg.tabIdOf(ID)).toBeUndefined();
    reg.setTabId(ID, "wZ:t2");
    expect(reg.tabIdOf(ID)).toBe("wZ:t2");
    reg.release(ID);
    expect(reg.tabIdOf(ID)).toBeUndefined();
  });
});

describe("DispatchCoordinator.releaseIssue (stop + reopen)", () => {
  it("releases the claim, closes the dispatched tab, and frees the in-session mutex", async () => {
    const h = harness([mk()], { fixtures: { "tab close wZ:t2": ok({}) } });
    await h.coordinator.dispatchIssue(mk()); // claims + creates tab wZ:t2
    expect(h.claims.has(ID)).toBe(true);
    expect(h.claims.tabIdOf(ID)).toBe("wZ:t2");

    const result = await h.coordinator.releaseIssue(mk());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tabClosed).toBe(true);
    expect((await h.provider.readIssue(ID)).status).toBe("open");
    expect(h.claims.tryClaim(ID)).toBe(true); // mutex freed → re-dispatchable
    expect(h.calls.map((c) => c.join(" "))).toContain("tab close wZ:t2");
  });

  it("reopens a foreign/stale claim even with no tracked tab (no tab close)", async () => {
    // An issue claimed by another process (or a crashed prior dispatch) is not
    // in our registry → no tabId → we reopen it but don't close a tab we don't
    // own. The provider release is authoritative; the tab is someone else's.
    const h = harness([mk({ status: "claimed" })]);
    const result = await h.coordinator.releaseIssue(mk({ status: "claimed" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tabClosed).toBe(false);
    expect((await h.provider.readIssue(ID)).status).toBe("open");
    expect(h.calls.some((c) => c[0] === "tab" && c[1] === "close")).toBe(false);
  });

  it("still reopens the issue if the tab close fails (best-effort)", async () => {
    // No `tab close` fixture → close throws. The issue is reopened regardless;
    // the orphan tab is a minor leak the user can close manually.
    const h = harness([mk()]);
    await h.coordinator.dispatchIssue(mk());
    const result = await h.coordinator.releaseIssue(mk());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tabClosed).toBe(false);
    expect((await h.provider.readIssue(ID)).status).toBe("open");
    expect(h.claims.tryClaim(ID)).toBe(true);
  });

  it("surfaces a provider release failure without closing the tab or freeing the mutex", async () => {
    // provider.release throws (e.g. ClaimBusy) → the issue is still claimed,
    // the tab still runs, the mutex still held. Retryable as-is.
    class ReleaseBusy extends FakeProvider {
      override async release(): Promise<Issue> {
        throw new ClaimBusy(ID);
      }
    }
    const h = harness([mk()], { provider: new ReleaseBusy([mk()]) });
    await h.coordinator.dispatchIssue(mk());
    const result = await h.coordinator.releaseIssue(mk());
    expect(result.ok).toBe(false);
    expect(h.calls.some((c) => c[0] === "tab" && c[1] === "close")).toBe(false);
    expect(h.claims.has(ID)).toBe(true); // mutex still held — still our dispatch
  });
});
