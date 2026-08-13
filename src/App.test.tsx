// Tests for the read-only Issue list (issue 09 acceptance).
//
// Two layers:
//   - logic.test: the pure presentation logic (grouping by run-root, triage,
//     cursor wrapping) — where the real behaviour lives.
//   - App render smoke: a synchronous initial render (initialIssues) proving the
//     OpenTUI component paints grouped rows. The OpenTUI test harness uses a
//     one-shot server renderer (no reactivity, no onMount), so async loading and
//     cursor motion are covered by logic.test, not by interaction here.

import { describe, it, expect } from "bun:test";
import { testRender } from "@opentui/solid";
import { App } from "./App.js";
import {
  buildRows,
  issueNum,
  moveCursor,
  effortOf,
  sortIssues,
  triageOf,
  type Row,
} from "./logic.js";
import type { Issue, TrackerProvider } from "./tracker/provider.js";

const mk = (over: Partial<Issue> = {}): Issue => ({
  id: ".scratch/e/issues/01-x.md",
  title: "01 — X",
  status: "open",
  type: "task",
  labels: ["ready-for-agent"],
  assignee: null,
  blockedBy: [],
  ...over,
});

const noopProvider: TrackerProvider = {
  listIssues: async () => [],
  readIssue: async () => { throw new Error("noop"); },
  claim: async () => { throw new Error("noop"); },
  updateLabels: async () => { throw new Error("noop"); },
  close: async () => { throw new Error("noop"); },
  comment: async () => { throw new Error("noop"); },
  addBlocking: async () => { throw new Error("noop"); },
};

describe("logic: effortOf / issueNum", () => {
  it("extracts the effort dir and numeric id from a repo-relative path", () => {
    expect(effortOf(".scratch/herdr-beads/issues/09-skeleton.md")).toBe("herdr-beads");
    expect(effortOf(".scratch/auth-spec/issues/22-token.md")).toBe("auth-spec");
    expect(issueNum(".scratch/e/issues/09-skeleton.md")).toBe("#09");
    expect(issueNum(".scratch/e/issues/README.md")).toBe("#README");
  });
});

describe("logic: triageOf", () => {
  it("returns the first non-wayfinder label, defaulting to needs-triage", () => {
    expect(triageOf(mk({ labels: ["ready-for-agent", "wayfinder:task"] }))).toBe("ready-for-agent");
    expect(triageOf(mk({ labels: ["wayfinder:research"] }))).toBe("needs-triage");
    expect(triageOf(mk({ labels: [] }))).toBe("needs-triage");
  });
});

describe("logic: sortIssues + buildRows groups by run-root", () => {
  it("sorts by run-root then title and emits group headers with counts", () => {
    const issues = sortIssues([
      mk({ id: ".scratch/auth-spec/issues/22-token.md", title: "22 — Token" }),
      mk({ id: ".scratch/herdr-beads/issues/09-skeleton.md", title: "09 — Skeleton" }),
      mk({ id: ".scratch/herdr-beads/issues/05-iface.md", title: "05 — Iface" }),
    ]);
    const rows = buildRows({ issues, loaded: true, error: null });
    const groups = rows.filter((r): r is Extract<Row, { kind: "group" }> => r.kind === "group");
    expect(groups.map((g) => g.root)).toEqual(["auth-spec", "herdr-beads"]);
    const byRoot = Object.fromEntries(groups.map((g) => [g.root, g.count]));
    expect(byRoot["auth-spec"]).toBe(1);
    expect(byRoot["herdr-beads"]).toBe(2);
    // within herdr-beads, 05 sorts before 09
    const hbIssues = rows.filter((r): r is Extract<Row, { kind: "issue" }> =>
      r.kind === "issue" && r.issue.id.includes("herdr-beads"));
    expect(hbIssues.map((r) => r.issue.title)).toEqual(["05 — Iface", "09 — Skeleton"]);
  });

  it("emits exactly one group header per contiguous run of same-root issues", () => {
    const rows = buildRows({
      issues: sortIssues([
        mk({ id: ".scratch/a/issues/1.md", title: "1" }),
        mk({ id: ".scratch/a/issues/2.md", title: "2" }),
        mk({ id: ".scratch/b/issues/3.md", title: "3" }),
      ]),
      loaded: true,
      error: null,
    });
    expect(rows.filter((r) => r.kind === "group")).toHaveLength(2);
  });

  it("emits an empty row when loaded with no issues", () => {
    expect(buildRows({ issues: [], loaded: true, error: null })).toEqual([{ kind: "empty" }]);
  });

  it("emits nothing yet while still loading", () => {
    expect(buildRows({ issues: [], loaded: false, error: null })).toEqual([]);
  });

  it("emits a single error row on failure", () => {
    expect(buildRows({ issues: [], loaded: true, error: "boom" })).toEqual([
      { kind: "error", message: "boom" },
    ]);
  });
});

describe("logic: moveCursor wraps and clamps", () => {
  it("wraps forward and backward over n items", () => {
    expect(moveCursor(0, 1, 3)).toBe(1);
    expect(moveCursor(2, 1, 3)).toBe(0); // wrap forward
    expect(moveCursor(0, -1, 3)).toBe(2); // wrap backward
    expect(moveCursor(1, -1, 3)).toBe(0);
  });
  it("is a no-op (returns 0) when there is nothing to move over", () => {
    expect(moveCursor(5, 1, 0)).toBe(0);
  });
});

describe("App (initial render smoke)", () => {
  it("paints group headers and issue titles from initialIssues", async () => {
    const setup = await testRender(() => (
      <App
        provider={noopProvider}
        initialIssues={[
          mk({ id: ".scratch/herdr-beads/issues/09-skeleton.md", title: "09 — Plugin skeleton" }),
          mk({ id: ".scratch/auth-spec/issues/22-token.md", title: "22 — Token refresh" }),
        ]}
      />
    ));
    await setup.flush();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("herdr-beads");
    expect(frame).toContain("auth-spec");
    expect(frame).toContain("Plugin skeleton");
    expect(frame).toContain("Token refresh");
    setup.renderer.destroy();
  });

  it("renders the empty state when initialIssues is empty", async () => {
    const setup = await testRender(() => <App provider={noopProvider} initialIssues={[]} />);
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("no issues");
    setup.renderer.destroy();
  });
});
