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

/** Recorded fixture runner: serves canned stdout, records every invocation. */
function recordingRunner(fixtures: Record<string, string>): { runner: HerdrRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: HerdrRunner = async (args) => {
    calls.push(args);
    const stdout = fixtures[args.join(" ")];
    if (stdout === undefined) return { code: 1, stdout: "", stderr: `no fixture for: ${args.join(" ")}` };
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
  over: { fixtures?: Record<string, string>; grace?: number } = {},
) {
  const provider = new FakeProvider(issues);
  const claims = new ClaimRegistry();
  const { runner, calls } = recordingRunner({
    "api schema --json": SCHEMA,
    [`tab create --cwd ${CWD} --label 12 — Driver --no-focus`]: TAB_OK,
    "agent start herdr-beads-12 --kind opencode --pane wZ:p3 -- -m claude-sonnet-4-5": ok({}),
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

    // We don't write status — the implement skill owns the lifecycle. The
    // provider record stays open until the dispatched agent claims it.
    expect((await h.provider.readIssue(ID)).status).toBe("open");

    // The herdr invocations: tab → agent start → (lazy schema introspection, at
    // first start-agent) → prompt, in schema-driven order.
    expect(h.calls.map((c) => c.join(" "))).toEqual([
      "tab create --cwd /repo --label 12 — Driver --no-focus",
      "api schema --json",
      "agent start herdr-beads-12 --kind opencode --pane wZ:p3 -- -m claude-sonnet-4-5",
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

  it("reports already-claimed when the issue isn't open (in-flight or done — status gate)", async () => {
    const h = harness([mk({ status: "claimed" })]);
    const result = await h.coordinator.dispatchIssue(mk({ status: "claimed" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("already-claimed");
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
});
