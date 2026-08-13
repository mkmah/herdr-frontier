// Pure display helpers for the two-pane primary shell (issue 10).
//
// Extracted from the Solid component so the interesting derivations — list state,
// the state-glyph precedence, human-turn detection, age humanization, focus
// cycling — are unit-testable without the OpenTUI harness. The component is a
// thin render layer over these functions; colors live in ./theme.ts.

import type { Issue } from "./tracker/provider.js";
import { triageOf } from "./logic.js";

/** List state, resolved per `Issue` (prototype 06's four-state model). */
export type ListState = "done" | "running" | "blocked" | "frontier";

/** Which pane has keyboard focus. */
export type Focus = "list" | "detail";

const HUMAN_ROLES: ReadonlySet<string> = new Set(["ready-for-human", "needs-info", "needs-triage"]);

/** True when the issue needs a human: `ready-for-human` / `needs-info` / `needs-triage`. */
export function isHumanTurn(issue: Issue): boolean {
  return HUMAN_ROLES.has(triageOf(issue));
}

/**
 * The issue's list state:
 *  - `done`     — status resolved
 *  - `running`  — status claimed (an agent/claim-owner is on it)
 *  - `blocked`  — at least one blockedBy id is not resolved
 *  - `frontier` — open, unclaimed, all blockers resolved
 */
export function listStateOf(issue: Issue, isResolved: (id: string) => boolean): ListState {
  if (issue.status === "resolved") return "done";
  if (issue.status === "claimed") return "running";
  if (issue.blockedBy.some((b) => !isResolved(b))) return "blocked";
  return "frontier";
}

/**
 * The state glyph for a row. Icon precedence (locked in prototype 06):
 * done `✓` > human `☻` > running `⟳` > blocked `✗` > frontier `○`.
 */
export function iconFor(issue: Issue, isResolved: (id: string) => boolean): string {
  const s = listStateOf(issue, isResolved);
  if (s === "done") return "✓";
  if (isHumanTurn(issue)) return "☻";
  if (s === "running") return "⟳";
  if (s === "blocked") return "✗";
  return "○";
}

/**
 * Humanize an epoch-ms age relative to `nowMs` into a compact string for the
 * row's age column: `now`, `5m`, `5h`, `3d`, `1w`, `2mo`.
 */
export function humanizeAge(updatedAtMs: number, nowMs: number): string {
  const sec = Math.max(0, Math.floor((nowMs - updatedAtMs) / 1000));
  if (sec < 60) return "now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  if (d < 30) return `${Math.floor(d / 7)}w`;
  return `${Math.floor(d / 30)}mo`;
}

/** Tab cycles focus between the two panes. */
export function cycleFocus(f: Focus): Focus {
  return f === "list" ? "detail" : "list";
}
