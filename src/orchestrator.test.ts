// Orchestration-policy unit tests (issue 11 acceptance) — the pure policy brain
// over `Issue[]`: frontier computation and dispatch precedence (Seam 2 in the
// spec — no provider, no IO, no herdr). All fixtures are plain data.

import { describe, it, expect } from "bun:test";
import type { Issue } from "./tracker/provider.js";
import { frontier, dispatch, autoSpawnable } from "./orchestrator.js";

const EFFORT = ".scratch/herdr-beads/issues/";
const mkId = (num: string, slug = "item") => `${EFFORT}${num}-${slug}.md`;

const mk = (over: Partial<Issue> = {}): Issue => ({
  id: mkId("01"),
  title: "01 — Item",
  status: "open",
  type: "task",
  labels: ["ready-for-agent"],
  assignee: null,
  blockedBy: [],
  ...over,
});

describe("frontier", () => {
  const ids = [
    mk({ id: mkId("05", "iface"), status: "resolved" }),
    mk({ id: mkId("06", "proto"), status: "open" }),
    mk({ id: mkId("07", "manip"), status: "open", blockedBy: ["05"] }),
    mk({ id: mkId("08", "shell"), status: "open", blockedBy: ["99"] }),
    mk({ id: mkId("09", "claim"), status: "claimed" }),
    mk({ id: mkId("10", "assign"), status: "open", assignee: "me" }),
  ];

  it("is open, unclaimed, and every blocker resolved — nothing else", () => {
    const got = frontier(ids).map((i) => i.id);
    expect(got).toEqual([mkId("06", "proto"), mkId("07", "manip")]);
  });

  it("removes an issue when a single blocker is open", () => {
    expect(frontier(ids).map((i) => i.id)).not.toContain(mkId("08", "shell"));
    const open = mk({ id: mkId("11", "dep") });
    const resolved = mk({ id: mkId("12", "dep"), status: "resolved", blockedBy: ["11"] });
    expect(frontier([resolved])).toHaveLength(0);
  });

  it("claims and assignments both keep an issue off the frontier", () => {
    expect(frontier(ids).map((i) => i.id)).not.toContain(mkId("09", "claim"));
    expect(frontier(ids).map((i) => i.id)).not.toContain(mkId("10", "assign"));
  });

  it("orders first-by-number", () => {
    const out = frontier([
      mk({ id: mkId("10") }),
      mk({ id: mkId("03") }),
      mk({ id: mkId("17") }),
      mk({ id: mkId("02") }),
    ]);
    expect(out.map((i) => i.id)).toEqual([mkId("02"), mkId("03"), mkId("10"), mkId("17")]);
  });

  it("resolves a blocker by full id or by numeric prefix within the same effort", () => {
    const blocked = mk({ id: mkId("07"), blockedBy: [mkId("05", "resolved")] });
    const fullIdResolved = frontier([blocked, mk({ id: mkId("05"), status: "resolved" })]);
    expect(fullIdResolved.map((i) => i.id)).toContain(mkId("07"));

    const numResolved = frontier([
      mk({ id: mkId("07"), blockedBy: ["05"] }),
      mk({ id: mkId("05"), status: "resolved" }),
    ]);
    expect(numResolved.map((i) => i.id)).toContain(mkId("07"));
  });
});

describe("dispatch", () => {
  it("dispatches a wayfinder:<non-map> issue to /wayfinder {id}", () => {
    const issue = mk({ labels: ["wayfinder:research"] });
    expect(dispatch(issue)).toEqual({ kind: "wayfinder", id: issue.id, command: `/wayfinder ${issue.id}` });
  });

  it("makes wayfinder:research beat ready-for-agent", () => {
    const issue = mk({ labels: ["ready-for-agent", "wayfinder:research"] });
    expect(dispatch(issue).kind).toBe("wayfinder");
  });

  it("dispatches plain ready-for-agent to /implement {id}", () => {
    const issue = mk({ labels: ["ready-for-agent"] });
    expect(dispatch(issue)).toEqual({ kind: "implement", id: issue.id, command: `/implement ${issue.id}` });
  });

  it("still implements when ready-for-agent is paired with wayfinder:map", () => {
    const issue = mk({ labels: ["ready-for-agent", "wayfinder:map"] });
    expect(dispatch(issue).kind).toBe("implement");
  });

  it("never dispatches a bare wayfinder:map (run-root)", () => {
    const issue = mk({ labels: ["wayfinder:map"] });
    expect(dispatch(issue).kind).toBe("not-dispatched");
  });

  it("surfaces ready-for-human, needs-info, and needs-triage as human turns", () => {
    for (const label of ["ready-for-human", "needs-info", "needs-triage"]) {
      expect(dispatch(mk({ labels: [label] })).kind).toBe("human");
    }
  });

  it("excludes wontfix as terminal, even alongside ready-for-agent", () => {
    const issue = mk({ labels: ["wontfix", "ready-for-agent"] });
    expect(dispatch(issue).kind).toBe("not-dispatched");
  });

  it("treats unlabeled as needs-triage → never dispatched", () => {
    expect(dispatch(mk({ labels: [] })).kind).toBe("human");
  });
});

describe("autoSpawnable", () => {
  it("spawns ready-for-agent and wayfinder:research — and nothing else", () => {
    expect(autoSpawnable(mk({ labels: ["ready-for-agent"] }))).toBe(true);
    expect(autoSpawnable(mk({ labels: ["wayfinder:research"] }))).toBe(true);
  });
  it("does not spawn other wayfinder types or wayfinder:map", () => {
    expect(autoSpawnable(mk({ labels: ["wayfinder:prototype"] }))).toBe(false);
    expect(autoSpawnable(mk({ labels: ["wayfinder:map"] }))).toBe(false);
    expect(autoSpawnable(mk({ labels: ["ready-for-agent", "wayfinder:map"] }))).toBe(true);
  });
  it("never spawns human turns, wontfix, or unlabeled issues", () => {
    expect(autoSpawnable(mk({ labels: ["ready-for-human"] }))).toBe(false);
    expect(autoSpawnable(mk({ labels: ["needs-info"] }))).toBe(false);
    expect(autoSpawnable(mk({ labels: ["needs-triage"] }))).toBe(false);
    expect(autoSpawnable(mk({ labels: ["wontfix"] }))).toBe(false);
    expect(autoSpawnable(mk({ labels: [] }))).toBe(false);
  });
});