// Pure display helpers for the two-pane primary shell (issue 10).
//
// Extracted from the Solid component so the interesting derivations — list state,
// the state-glyph precedence, human-turn detection, age humanization, focus
// cycling — are unit-testable without the OpenTUI harness. The component is a
// thin render layer over these functions; colors live in ./theme.ts.

import type { AgentStatus } from "#/services/herdr/types.js";
import type { Issue } from "#/services/tracker/provider.js";
import { attention } from "#/lib/attention.js";

/** List state, resolved per `Issue` (prototype 06's four-state model). */
export type ListState = "done" | "running" | "blocked" | "frontier";

/** Which pane has keyboard focus. */
export type Focus = "list" | "detail";

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
 * The state glyph for a row, plus the state it resolved to (so the theme can
 * color it with a plain stateColor lookup — the precedence lives here once).
 * Icon precedence (locked in prototype 06): done `✓` > human `☻` > running
 * `⟳` > blocked `✗` > frontier `○`. Issue 13 adds a second path to `☻`: a
 * dispatched agent that went `blocked` (agent state, CONTEXT.md: Attention
 * lane) shows the same pulsing human marker as a `ready-for-human` issue.
 */
export interface IssueIcon {
  glyph: string;
  state: ListState | "human";
}

export function iconFor(issue: Issue, isResolved: (id: string) => boolean, agentStatus?: AgentStatus): IssueIcon {
  const s = listStateOf(issue, isResolved);
  if (s === "done") return { glyph: "✓", state: "done" };
  if (attention(issue, agentStatus) !== null) return { glyph: "☻", state: "human" };
  if (s === "running") return { glyph: "⟳", state: "running" };
  if (s === "blocked") return { glyph: "✗", state: "blocked" };
  return { glyph: "○", state: "frontier" };
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

// --- mouse seam (issue 16) -------------------------------------------------
// The pure derivations behind the shell's pointer handling: the double-click
// state machine and the wheel-to-delta mapping. The component feeds its real
// `MouseEvent`s in; the button codes mirror @opentui/core's `MouseButton` enum
// so the seam stays testable without the harness.

/** @opentui/core `MouseButton` codes, mirrored so this module stays harness-free. */
export const MouseButton = {
  LEFT: 0,
  MIDDLE: 1,
  RIGHT: 2,
  WHEEL_UP: 4,
  WHEEL_DOWN: 5,
} as const;

/** The last row-click the tracker saw, for double-click detection. */
export interface ClickRecord {
  id: string;
  at: number;
}

/**
 * Step the double-click state machine with one row-click.
 *
 * Returns whether this click forms a double-click (same id inside the
 * `windowMs` window) and the record to keep for the next click. A double-click
 * consumes itself (`next` is null), so a third click inside the window counts
 * as a fresh single — the same reset the handlers used to do by hand.
 */
export function trackClick(
  prev: ClickRecord | null,
  id: string,
  at: number,
  windowMs = 400,
): { double: boolean; next: ClickRecord | null } {
  if (prev && prev.id === id && at - prev.at < windowMs) {
    return { double: true, next: null };
  }
  return { double: false, next: { id, at } };
}

/** Cursor delta for a wheel event: up -1, down +1, any other button 0. */
export function wheelDelta(button: number): number {
  if (button === MouseButton.WHEEL_UP) return -1;
  if (button === MouseButton.WHEEL_DOWN) return 1;
  return 0;
}
