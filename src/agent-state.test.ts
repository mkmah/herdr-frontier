// Agent-state unit tests (issue 13 acceptance, Seam 2 — pure functions over
// `Issue[]` + `AgentRecord[]`, no IO, no herdr).
//
//   - `mapAgentStates`: pane_id → issue_id mapping → issue_id → AgentStatus map
//     (the live agent-state signal's payload; rows update from this).
//   - `attentionTransitions`: the diff between two snapshots that decides which
//     issues newly need a human (→ herdr notification show). Two triggers:
//     an issue that became `ready-for-human` (label change), and a dispatched
//     agent that went `blocked` (agent-status change).

import { describe, it, expect } from "bun:test";
import type { AgentRecord, AgentStatus } from "./herdr-client.js";
import type { Issue } from "./tracker/provider.js";
import { attentionTransitions, mapAgentStates } from "./agent-state.js";

const mk = (over: Partial<Issue> = {}): Issue => ({
  id: ".scratch/herdr-frontier/issues/13-live.md",
  title: "13 — Live",
  status: "open",
  type: "task",
  labels: ["ready-for-agent"],
  assignee: null,
  blockedBy: [],
  ...over,
});

const ID = ".scratch/herdr-frontier/issues/13-live.md";
const ID2 = ".scratch/herdr-frontier/issues/14-run.md";

const agent = (over: Partial<AgentRecord> = {}): AgentRecord => ({
  agent: "opencode",
  agent_status: "working",
  pane_id: "wZ:p3",
  ...over,
});

// --- mapAgentStates ---------------------------------------------------------

describe("mapAgentStates", () => {
  it("maps pane_id → issue_id via the registry, returning issue_id → status", () => {
    const agents = [
      agent({ pane_id: "wZ:p3", agent_status: "working" }),
      agent({ pane_id: "wZ:p7", agent_status: "blocked" }),
      agent({ pane_id: "wZ:p9", agent_status: "idle" }), // pane we don't own
    ];
    // The caller builds issue-id → pane-id from the ClaimRegistry; only our
    // dispatched panes are passed, so an orphan pane we don't own is ignored.
    const issueToPane = new Map([
      [ID, "wZ:p3"],
      [ID2, "wZ:p7"],
    ]);
    const states = mapAgentStates(agents, issueToPane);
    expect(states.get(ID)).toBe("working");
    expect(states.get(ID2)).toBe("blocked");
    expect(states.size).toBe(2); // the orphan pane (wZ:p9) isn't ours
  });

  it("drops an issue whose pane is no longer registered (agent gone)", () => {
    const issueToPane = new Map([[ID, "wZ:p3"]]);
    const states = mapAgentStates([agent({ pane_id: "wZ:other", agent_status: "working" })], issueToPane);
    expect(states.has(ID)).toBe(false); // our pane vanished — no entry
  });

  it("is empty when no dispatched issues have panes yet", () => {
    expect(mapAgentStates([agent()], new Map()).size).toBe(0);
    expect(mapAgentStates([], new Map([[ID, "wZ:p3"]])).size).toBe(0);
  });
});

// --- attentionTransitions ---------------------------------------------------

describe("attentionTransitions", () => {
  const states = (entries: [string, AgentStatus][]): Map<string, AgentStatus> => new Map(entries);

  it("flags an issue that newly became ready-for-human (label change)", () => {
    const prev = [mk({ id: ID, labels: ["ready-for-agent"] })];
    const next = [mk({ id: ID, labels: ["ready-for-human"] })];
    const t = attentionTransitions({
      prevIssues: prev,
      nextIssues: next,
      prevStates: new Map(),
      nextStates: new Map(),
    });
    expect(t.map((i) => i.id)).toEqual([ID]);
  });

  it("flags an issue whose dispatched agent newly went blocked", () => {
    const issue = mk({ id: ID, status: "claimed" });
    const t = attentionTransitions({
      prevIssues: [issue],
      nextIssues: [issue],
      prevStates: states([[ID, "working"]]),
      nextStates: states([[ID, "blocked"]]),
    });
    expect(t.map((i) => i.id)).toEqual([ID]);
  });

  it("does not re-fire while the agent stays blocked (idempotent across polls)", () => {
    const issue = mk({ id: ID, status: "claimed" });
    const t = attentionTransitions({
      prevIssues: [issue],
      nextIssues: [issue],
      prevStates: states([[ID, "blocked"]]),
      nextStates: states([[ID, "blocked"]]),
    });
    expect(t).toHaveLength(0);
  });

  it("does not flag an issue that was already ready-for-human (no transition)", () => {
    const human = mk({ id: ID, labels: ["ready-for-human"] });
    const t = attentionTransitions({
      prevIssues: [human],
      nextIssues: [human],
      prevStates: new Map(),
      nextStates: new Map(),
    });
    expect(t).toHaveLength(0);
  });

  it("does not flag a non-blocked agent-status change (working → done)", () => {
    const issue = mk({ id: ID, status: "claimed" });
    const t = attentionTransitions({
      prevIssues: [issue],
      nextIssues: [issue],
      prevStates: states([[ID, "working"]]),
      nextStates: states([[ID, "done"]]),
    });
    expect(t).toHaveLength(0);
  });

  it("dedupes: an issue that is both newly human-turn AND newly blocked fires once", () => {
    const t = attentionTransitions({
      prevIssues: [mk({ id: ID, status: "open", labels: ["ready-for-agent"] })],
      nextIssues: [mk({ id: ID, status: "claimed", labels: ["ready-for-human"] })],
      prevStates: states([[ID, "working"]]),
      nextStates: states([[ID, "blocked"]]),
    });
    expect(t.map((i) => i.id)).toEqual([ID]);
  });

  it("ignores issues that dropped off the list (resolved/removed)", () => {
    const t = attentionTransitions({
      prevIssues: [mk({ id: ID, labels: ["ready-for-agent"] })],
      nextIssues: [],
      prevStates: new Map(),
      nextStates: new Map(),
    });
    expect(t).toHaveLength(0);
  });

  it("does NOT notify for a needs-info / needs-triage transition (attention-lane only, spec.md:234)", () => {
    // needs-info and needs-triage get the inline ☻ marker (display layer) but
    // are not a notification trigger — only ready-for-human / agent-blocked are.
    for (const label of ["needs-info", "needs-triage"]) {
      const t = attentionTransitions({
        prevIssues: [mk({ id: ID, labels: ["ready-for-agent"] })],
        nextIssues: [mk({ id: ID, labels: [label] })],
        prevStates: new Map(),
        nextStates: new Map(),
      });
      expect(t).toHaveLength(0);
    }
  });

  it("does not re-fire when an already-ready-for-human issue's agent then goes blocked", () => {
    // The human was already flagged by the ready-for-human label; a later agent
    // block is the same attention state, not a NEW needs-a-human transition.
    const t = attentionTransitions({
      prevIssues: [mk({ id: ID, labels: ["ready-for-human"], status: "claimed" })],
      nextIssues: [mk({ id: ID, labels: ["ready-for-human"], status: "claimed" })],
      prevStates: states([[ID, "working"]]),
      nextStates: states([[ID, "blocked"]]),
    });
    expect(t).toHaveLength(0);
  });

  it("carries the latest issue record for each firing (title/id for the toast)", () => {
    const t = attentionTransitions({
      prevIssues: [mk({ id: ID, labels: ["ready-for-agent"], title: "old" })],
      nextIssues: [mk({ id: ID, labels: ["ready-for-human"], title: "new title" })],
      prevStates: new Map(),
      nextStates: new Map(),
    });
    expect(t[0]?.title).toBe("new title");
    expect(t).toHaveLength(1);
  });
});
