// Tree-logic unit tests (issue 15 acceptance) — the pure derivations behind the
// secondary dependency-tree view: the forward forest (children = the issues a
// node blocks; roots = issues with no in-run blockers) and its depth-first
// flatten into lean connector rows. No OpenTUI harness — plain functions over
// `Issue` records, the same shape as the issue-10 display helpers.

import { describe, it, expect } from "bun:test";
import type { Issue } from "#/services/tracker/provider.js";
import { buildForest, flattenForest, foldForest } from "#/lib/tree.js";
import { idEffort, idNum, idOrder } from "#/services/tracker/local-markdown.js";

const mk = (over: Partial<Issue> = {}): Issue => {
  const id = over.id ?? ".scratch/e/issues/01-a.md";
  return {
    id,
    effort: idEffort(id),
    num: idNum(id),
    order: idOrder(id),
    title: "01 — A",
    status: "open",
    type: "task",
    labels: ["ready-for-agent"],
    assignee: null,
    blockedBy: [],
    ...over,
  };
};

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

  it("treats a cross-pool blocker as out-of-run: the node stays a root", () => {
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
    // The 02↔03 cycle is cut at the back-edge (02 is already an ancestor when
    // 03's expansion reaches it), so the flatten terminates and shows each
    // node once in this acyclic input.
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

// collapsible-categories 03 — Seam 2: the node-level fold (foldForest). A node
// whose id is in the collapsed set keeps its own row but prunes exactly its
// descendant rows; the remaining connectors recompute off the visible siblings,
// and leaves carry no chevron (their fold is a no-op).
describe("foldForest — the node-level fold", () => {
  it("prunes exactly a folded node's descendants; its own row, roots, and siblings stay", () => {
    // 01 ─ 02 ─ 04   +  03 (all in one root's subtree)
    const i1 = mk({ id: ".scratch/e/issues/01-a.md", title: "01 — A" });
    const i2 = mk({ id: ".scratch/e/issues/02-b.md", title: "02 — B", blockedBy: ["01"] });
    const i3 = mk({ id: ".scratch/e/issues/03-c.md", title: "03 — C", blockedBy: ["01"] });
    const i4 = mk({ id: ".scratch/e/issues/04-d.md", title: "04 — D", blockedBy: ["02"] });
    const rows = foldForest(buildForest([i1, i2, i3, i4]), new Set([i2.id]));
    // 04 was 02's descendant and is pruned; 01, 02, and sibling 03 stay
    expect(rows.map((r) => r.issue.id)).toEqual([i1.id, i2.id, i3.id]);
  });

  it("recomputes the remaining connectors after a prune", () => {
    // 01 with three children (02,03,04); 04 has a deep child 05
    const i1 = mk({ id: ".scratch/e/issues/01-a.md", title: "01 — A" });
    const i2 = mk({ id: ".scratch/e/issues/02-b.md", title: "02 — B", blockedBy: ["01"] });
    const i3 = mk({ id: ".scratch/e/issues/03-c.md", title: "03 — C", blockedBy: ["01"] });
    const i4 = mk({ id: ".scratch/e/issues/04-d.md", title: "04 — D", blockedBy: ["01"] });
    const i5 = mk({ id: ".scratch/e/issues/05-e.md", title: "05 — E", blockedBy: ["04"] });
    // fully expanded: 02/03 are non-last (├─), 04 is the last (└─), 05 its child
    const expanded = foldForest(buildForest([i1, i2, i3, i4, i5]));
    expect(expanded.map((r) => r.issue.id)).toEqual([i1.id, i2.id, i3.id, i4.id, i5.id]);
    expect(expanded.map((r) => `${r.branch}|${r.hasChildren ? "child" : "leaf"}`)).toEqual([
      `|child`,
      `├─ |leaf`,
      `├─ |leaf`,
      `└─ |child`,
      `└─ |leaf`,
    ]);
    // folding 04 prunes its subtree (05): 04 keeps its slot, so 02/03 stay ├─ and
    // 04 stays └─ — the walk re-derives every surviving connector from the
    // visible siblings rather than carrying a stale full-forest shape
    const folded = foldForest(buildForest([i1, i2, i3, i4, i5]), new Set([i4.id]));
    expect(folded.map((r) => r.issue.id)).toEqual([i1.id, i2.id, i3.id, i4.id]);
    expect(folded.map((r) => `${r.depth}:${r.branch}`)).toEqual(["0:", "1:├─ ", "1:├─ ", "1:└─ "]);
  });

  it("treats a leaf fold as a no-op — no rows change and the leaf carries no fold flag", () => {
    const i1 = mk({ id: ".scratch/e/issues/01-a.md", title: "01 — A" });
    const i2 = mk({ id: ".scratch/e/issues/02-b.md", title: "02 — B", blockedBy: ["01"] });
    const forest = buildForest([i1, i2]);
    const folded = foldForest(forest, new Set([i2.id]));
    const unfolded = foldForest(forest);
    expect(folded.map((r) => r.issue.id)).toEqual([i1.id, i2.id]);
    const leaf = folded.find((r) => r.issue.id === i2.id)!;
    expect(leaf.hasChildren).toBe(false);
    expect(leaf.folded).toBe(false);
    expect(leaf).toEqual(unfolded.find((r) => r.issue.id === i2.id)!);
  });

  it("folding at the root keeps that root's row alone and hides its whole subtree", () => {
    const i1 = mk({ id: ".scratch/e/issues/01-a.md", title: "01 — A" });
    const i2 = mk({ id: ".scratch/e/issues/02-b.md", title: "02 — B", blockedBy: ["01"] });
    const i3 = mk({ id: ".scratch/e/issues/03-c.md", title: "03 — C", blockedBy: ["01"] });
    const rows = foldForest(buildForest([i1, i2, i3]), new Set([i1.id]));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.issue.id).toBe(i1.id);
    expect(rows[0]!.folded).toBe(true);
    expect(rows[0]!.hasChildren).toBe(true);
    expect(rows[0]!.branch).toBe("");
  });

  it("hides a folded root's subtree but sibling roots stay", () => {
    const i1 = mk({ id: ".scratch/e/issues/01-a.md", title: "01 — A" });
    const i2 = mk({ id: ".scratch/e/issues/02-b.md", title: "02 — B", blockedBy: ["01"] });
    const i3 = mk({ id: ".scratch/e/issues/03-c.md", title: "03 — C" });
    const rows = foldForest(buildForest([i1, i2, i3]), new Set([i1.id]));
    expect(rows.map((r) => r.issue.id)).toEqual([i1.id, i3.id]);
    expect(rows.find((r) => r.issue.id === i1.id)!.folded).toBe(true);
    // the sibling root's own subtree is untouched
    expect(rows.find((r) => r.issue.id === i3.id)!.hasChildren).toBe(false);
    expect(rows.find((r) => r.issue.id === i3.id)!.folded).toBe(false);
  });

  it("exposes the chevron state: parents carry hasChildren + a fold flag, leaves none", () => {
    const i1 = mk({ id: ".scratch/e/issues/01-a.md", title: "01 — A" });
    const i2 = mk({ id: ".scratch/e/issues/02-b.md", title: "02 — B", blockedBy: ["01"] });
    const rows = foldForest(buildForest([i1, i2]));
    const root = rows.find((r) => r.issue.id === i1.id)!;
    expect(root.hasChildren).toBe(true);
    expect(root.folded).toBe(false);
    const leaf = rows.find((r) => r.issue.id === i2.id)!;
    expect(leaf.hasChildren).toBe(false);
    expect(leaf.folded).toBe(false);
  });

  it("flattenForest is the fully-expanded no-fold case", () => {
    const i1 = mk({ id: ".scratch/e/issues/01-a.md", title: "01 — A" });
    const i2 = mk({ id: ".scratch/e/issues/02-b.md", title: "02 — B", blockedBy: ["01"] });
    const i3 = mk({ id: ".scratch/e/issues/03-c.md", title: "03 — C", blockedBy: ["01"] });
    const rows = flattenForest(buildForest([i1, i2, i3]));
    expect(rows.map((r) => r.issue.id)).toEqual([i1.id, i2.id, i3.id]);
    expect(rows.every((r) => !r.folded)).toBe(true);
    expect(rows.map((r) => r.hasChildren)).toEqual([true, false, false]);
  });
});