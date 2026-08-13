// Tests for the read-only Issue list + two-pane primary shell (issues 09 + 10).
//
// Two layers:
//   - logic.test / display.test: the pure presentation logic (grouping by
//     run-root, triage, cursor wrapping, list state, icon precedence) — where
//     the real behaviour lives.
//   - App render smoke: a synchronous initial render (initialIssues +
//     initialDetail) proving the OpenTUI component paints a 40/60 two-pane shell
//     with ghui-style rows and the detail fields. The OpenTUI test harness uses
//     a one-shot server renderer (no reactivity, no onMount/createEffect), so
//     async loading, cursor motion, and focus cycling are covered by the unit
//     tests, not by interaction here.

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
import type { Issue, IssueDetail, TrackerProvider } from "./tracker/provider.js";

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

describe("App (initial render smoke — two-pane shell)", () => {
  it("paints a 40/60 shell with group headers, ghui-style rows, and the detail fields", async () => {
    const first = mk({
      id: ".scratch/herdr-beads/issues/09-skeleton.md",
      title: "09 — Plugin skeleton",
      status: "claimed",
      labels: ["ready-for-agent", "wayfinder:task"],
      tasks: { done: 2, total: 4 },
      updatedAt: Date.now() - 5 * 3_600_000,
    });
    const second = mk({
      id: ".scratch/auth-spec/issues/22-token.md",
      title: "22 — Token refresh",
      labels: ["ready-for-human"],
      blockedBy: ["21"],
    });
    const detail: IssueDetail = {
      ...first,
      body: "Build the primary shell. Blocked-by line here.",
      comments: [],
    };

    const setup = await testRender(() => (
      <App
        provider={noopProvider}
        initialIssues={[first, second]}
        initialDetail={detail}
      />
    ));
    await setup.flush();
    const frame = setup.captureCharFrame();

    // list pane: grouped rows, #id, truncated titles
    expect(frame).toContain("herdr-beads");
    expect(frame).toContain("auth-spec");
    expect(frame).toContain("#09");
    expect(frame).toContain("#22");
    expect(frame).toContain("Plugin skeleton");
    expect(frame).toContain("Token refresh");
    // ghui-style: tasks ratio + age on the selected row
    expect(frame).toContain("2/4");
    expect(frame).toContain("5h");
    // detail pane: labels + blocked-by + body
    expect(frame).toContain("ready-for-agent");
    expect(frame).toContain("wayfinder:task");
    expect(frame).toContain("blocked by: —");
    expect(frame).toContain("Build the primary shell");
    setup.renderer.destroy();
  });

  it("renders the empty state when initialIssues is empty", async () => {
    const setup = await testRender(() => <App provider={noopProvider} initialIssues={[]} />);
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("no issues");
    setup.renderer.destroy();
  });

  // Regression: the stale-detail race. When a detail record for a differently
  // id'd issue is present while another issue is selected (the state between
  // navigation and the new read resolving), the body must not paint under the
  // wrong title.
  it("does not paint a detail body whose id differs from the selected issue", async () => {
    const eleven = mk({ id: ".scratch/herdr-beads/issues/11-a.md", title: "11 — A" });
    const twelve = mk({ id: ".scratch/herdr-beads/issues/12-b.md", title: "12 — B" });
    const staleDetail: IssueDetail = {
      ...twelve,
      body: "BODY OF 12 (must not paint under 11)",
      comments: [],
    };
    const setup = await testRender(() => (
      <App provider={noopProvider} initialIssues={[eleven, twelve]} initialDetail={staleDetail} />
    ));
    await setup.flush();
    const frame = setup.captureCharFrame();
    // cursor starts at issue 11 — the body of 12 must not leak under it
    expect(frame).not.toContain("BODY OF 12 (must not paint under 11)");
    setup.renderer.destroy();
  });
});
