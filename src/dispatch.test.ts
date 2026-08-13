// Dispatch-flow tests (issue 12 acceptance): the manual single-issue dispatch.
//
//   `Enter` → claim (mutex) → resolve `{id}` to the Issue body → build the
//   `agent start` vector from the profile → run it.
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
import { dispatch } from "./orchestrator.js";
import { HerdrClient, type HerdrRunner } from "./herdr-client.js";
import {
  ClaimRegistry,
  DispatchCoordinator,
  resolvePrompt,
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

function harness(issues: IssueDetail[]) {
  const provider = new FakeProvider(issues);
  const claims = new ClaimRegistry();
  const { runner, calls } = recordingRunner({
    "api schema --json": SCHEMA,
    [`tab create --cwd ${CWD} --label 12 — Driver --no-focus`]: TAB_OK,
    "agent start #12 --kind opencode --pane wZ:p3 -- -m claude-sonnet-4-5": ok({}),
    [`agent prompt #12 /implement ${BODY}`]: ok({}),
  });
  const client = new HerdrClient({ runner });
  const coordinator = new DispatchCoordinator({ client, provider, profiles: PROFILES, claims, cwd: CWD });
  return { provider, claims, calls, coordinator };
}

describe("resolvePrompt", () => {
  it("resolves {id} to the issue body for /implement and /wayfinder", () => {
    const impl = dispatch(mk({ labels: ["ready-for-agent"] }));
    expect(resolvePrompt(impl, mk())).toBe(`/implement ${BODY}`);

    const wf = dispatch(mk({ labels: ["wayfinder:research"], type: "research" }));
    expect(resolvePrompt(wf, mk())).toBe(`/wayfinder ${BODY}`);
  });

  it("is null for human turns and non-dispatched issues", () => {
    expect(resolvePrompt(dispatch(mk({ labels: ["ready-for-human"] })), mk())).toBeNull();
    expect(resolvePrompt(dispatch(mk({ labels: ["wayfinder:map"] })), mk())).toBeNull();
  });
});

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
  it("claims, resolves the body, builds the agent-start vector from the profile, and prompts", async () => {
    const h = harness([mk()]);
    const result = await h.coordinator.dispatchIssue(mk());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command).toBe(`/implement ${ID}`);
    expect(result.prompt).toBe(`/implement ${BODY}`);
    expect(result.kind).toBe("opencode");
    expect(result.args).toEqual(["-m", "claude-sonnet-4-5"]);
    expect(result.paneId).toBe("wZ:p3");

    // The issue was claimed before dispatch — the provider record reflects it.
    expect((await h.provider.readIssue(ID)).status).toBe("claimed");

    // The herdr invocations: tab → agent start → (lazy schema introspection at
    // first prompt) → prompt, in schema-driven order (start detects kind).
    expect(h.calls.map((c) => c.join(" "))).toEqual([
      "tab create --cwd /repo --label 12 — Driver --no-focus",
      "api schema --json",
      "agent start #12 --kind opencode --pane wZ:p3 -- -m claude-sonnet-4-5",
      "agent prompt #12 /implement ## What to build\n\nA herdr driver with an injectable runner.",
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

  it("reports already-claimed when the provider's gate is closed (claimed by another dispatcher)", async () => {
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

  it("releases the mutex so a retry is possible when the provider refuses", async () => {
    const h = harness([mk({ status: "claimed" })]);
    const result = await h.coordinator.dispatchIssue(mk({ status: "claimed" }));
    expect(result.ok).toBe(false);
    expect(h.claims.tryClaim(ID)).toBe(true); // freed for a later (valid) issue
  });
});
