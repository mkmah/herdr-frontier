// Pure logic for the secondary dependency-tree view (issue 15).
//
// The locked 07 run view: a forward **forest** — children = the Issues a node
// blocks (run-progression: "when I finish, these unblock"); roots = Issues
// with no in-run blockers. Flattened into lean rows the tree scrollbox paints
// (tree connector · icon · #id · title · tasks · age), with the selected
// node's detail mirrored in the pane below. Extracted from the Solid component
// so the forest shape is unit-testable (same seam as ./logic.ts / ./display.ts);
// the component is a thin render layer over these functions.

import type { Issue } from "./tracker/provider.js";
import { issueNum, issueNumber } from "./logic.js";

/** One node in the forward forest. */
export interface TreeNode {
  issue: Issue;
  children: TreeNode[];
}

/**
 * The forward forest over a pool: children = the Issues a node blocks. A
 * blocker id counts as "in-run" when it names an Issue in the pool, so roots
 * are Issues with no in-run blockers (a cross-pool blocker — a dep on another
 * effort's issue — does not root the node). Roots and children are ordered by
 * number (the frontier's stable first-by-number convention). Cyclic blocker
 * links are cut at the back-edge so a stale graph can't recurse forever.
 */
export function buildForest(pool: Issue[]): TreeNode[] {
  const byNumber = (a: Issue, b: Issue) => issueNumber(a.id) - issueNumber(b.id) || a.id.localeCompare(b.id);
  const byId = new Map(pool.map((i) => [i.id, i]));
  // A blocker ref may be a full id or the issue's numeric prefix ("05"); both
  // resolve within the pool (a single effort, so numbers are unique there) —
  // the same prefix style `blockerResolved` matches, though here it resolves
  // membership (in-run), not resolution status. First-by-number wins on a
  // prefix collision.
  const byNum = new Map<string, Issue>();
  for (const i of [...pool].sort(byNumber)) {
    if (!byNum.has(issueNum(i.id))) byNum.set(issueNum(i.id), i);
  }
  const resolve = (ref: string): Issue | undefined => byId.get(ref) ?? byNum.get(issueNum(ref));
  const roots = pool.filter((i) => !i.blockedBy.some((b) => resolve(b))).sort(byNumber);
  const expand = (issue: Issue, ancestors: ReadonlySet<string>): TreeNode => {
    const children = pool
      .filter((c) => c.blockedBy.some((b) => resolve(b)?.id === issue.id))
      .filter((c) => !ancestors.has(c.id))
      .sort(byNumber)
      .map((c) => expand(c, new Set([...ancestors, issue.id])));
    return { issue, children };
  };
  return roots.map((r) => expand(r, new Set([r.id])));
}

/** One flattened tree row — the lean render unit for the tree scrollbox. */
export interface TreeRow {
  issue: Issue;
  /** Nesting depth — drives the row's `paddingLeft` (0 = root). */
  depth: number;
  /** Tree connector: "" for a root, "├─ " for a non-last child, "└─ " for the last. */
  branch: string;
}

/** Flatten a forest depth-first into the lean rows the tree renders. */
export function flattenForest(nodes: TreeNode[]): TreeRow[] {
  const out: TreeRow[] = [];
  const walk = (children: TreeNode[], depth: number): void => {
    children.forEach((node, i) => {
      const last = i === children.length - 1;
      out.push({ issue: node.issue, depth, branch: depth === 0 ? "" : last ? "└─ " : "├─ " });
      walk(node.children, depth + 1);
    });
  };
  walk(nodes, 0);
  return out;
}
