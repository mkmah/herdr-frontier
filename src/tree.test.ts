// Tree-logic unit tests (issue 15 acceptance) — the pure derivations behind the
// secondary dependency-tree view: the forward forest (children = the issues a
// node blocks; roots = issues with no in-run blockers) and its depth-first
// flatten into lean connector rows. No OpenTUI harness — plain functions over
// `Issue` records, the same shape as the issue-10 display helpers.

import { describe, it, expect } from "bun:test";
import type { Issue } from "./tracker/provider.js";
import { buildForest, flattenForest } from "./tree.js";

const mk = (over: Partial<Issue> = {}): Issue => ({
  id: ".scratch/e/issues/01-a.md",
  title: "01 — A",
  status: "open",
  type: "task",
  labels: ["ready-for-agent"],
  assignee: null,
  blockedBy: [],
  ...over,
});

describe("buildForest — the forward forest", () => {
  it("makes children the issues a node blocks, and roots the no-in-run-blocker issues", () => {
    const i1 = mk({ id: ".scratch/e/issues/01-a.md", title: "01 — A" });
    const i2 = mk({ id: ".scratch/e/issues/02-b.md", title: "02 — B", blockedBy: ["01"] });
    const i3 = mk({ id: ".scratch/e/issues/03-c.md", title: "03 — C", blockedBy: ["02"] });
    const forest = buildForest([i3, i1, i2]); // shuffled — output order is deterministic
    expect(forest).toHaveLength(1);
    const root = forest[0]!;
    expect(root.issue.id).toBe(i1.id);
    expect(root.children.map((c) => c.issue.id)).toEqual([i2.id]);
    expect(root.children[0]!.children.map((c) => c.issue.id)).toEqual([i3.id]);
    expect(root.children[0]!.children[0]!.children).toEqual([]);
  });

  it("emits one root per issue with no in-run blocker, ordered by number", () => {
    const i2 = mk({ id: ".scratch/e/issues/02-b.md", title: "02 — B" });
    const i1 = mk({ id: ".scratch/e/issues/01-a.md", title: "01 — A" });
    const forest = buildForest([i2, i1]);
    expect(forest.map((r) => r.issue.id)).toEqual([i1.id, i2.id]);
  });

  it("treats a cross-pool blocker as out-of-run: it does not root the node", () => {
    // "04" waits on "99" which is not in the pool — so "04" is a root here.
    const i4 = mk({ id: ".scratch/e/issues/04-d.md", title: "04 — D", blockedBy: ["99"] });
    const forest = buildForest([i4]);
    expect(forest.map((r) => r.issue.id)).toEqual([i4.id]);
  });

  it("cuts cyclic blocker links instead of recursing forever", () => {
    const i1 = mk({ id: ".scratch/e/issues/01-a.md", title: "01 — A" });
    const i2 = mk({ id: ".scratch/e/issues/02-b.md", title: "02 — B", blockedBy: ["01", "03"] });
    const i3 = mk({ id: ".scratch/e/issues/03-c.md", title: "03 — C", blockedBy: ["02"] });
    const forest = buildForest([i1, i2, i3]);
    const rows = flattenForest(forest);
    // Every issue appears exactly once; the 02↔03 cycle is cut at the back-edge.
    expect(rows.map((r) => r.issue.id)).toEqual([i1.id, i2.id, i3.id]);
    expect(rows[1]!.issue.id).toBe(i2.id);
    expect(rows[2]!.issue.id).toBe(i3.id);
  });

  it("returns an empty forest for an empty pool", () => {
    expect(buildForest([])).toEqual([]);
  });
});

describe("flattenForest — lean connector rows", () => {
  it("flattens depth-first with connectors and padding depths", () => {
    const i1 = mk({ id: ".scratch/e/issues/01-a.md", title: "01 — A" });
    const i2 = mk({ id: ".scratch/e/issues/02-b.md", title: "02 — B", blockedBy: ["01"] });
    const i3 = mk({ id: ".scratch/e/issues/03-c.md", title: "03 — C", blockedBy: ["02"] });
    const rows = flattenForest(buildForest([i1, i2, i3]));
    expect(rows.map((r) => r.issue.title)).toEqual(["01 — A", "02 — B", "03 — C"]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2]);
    expect(rows[0]!.branch).toBe("");
    expect(rows[1]!.branch).toBe("└─ ");
    expect(rows[2]!.branch).toBe("└─ ");
  });

  it("uses ├─ for non-last siblings and └─ for the last", () => {
    const i1 = mk({ id: ".scratch/e/issues/01-a.md", title: "01 — A" });
    const i2 = mk({ id: ".scratch/e/issues/02-b.md", title: "02 — B", blockedBy: ["01"] });
    const i3 = mk({ id: ".scratch/e/issues/03-c.md", title: "03 — C", blockedBy: ["01"] });
    const rows = flattenForest(buildForest([i1, i2, i3]));
    expect(rows[1]!.branch).toBe("├─ ");
    expect(rows[2]!.branch).toBe("└─ ");
  });
});