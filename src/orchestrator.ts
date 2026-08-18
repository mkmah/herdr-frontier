// Orchestration policy — the pure brain over `Issue[]` (issue 11).
//
// Seam 2 in the spec's Testing Decisions: frontier computation and dispatch
// precedence are pure functions of `Issue[]`, unit-tested with plain data —
// no provider, no IO, no herdr. The run-controller (issue 14) and the TUI
// consume these; nothing below this module knows a tracker or an agent.

import type { Issue } from "./tracker/provider.js";
import { HUMAN_ROLES, blockerResolved } from "./logic.js";

// --- dispatch --------------------------------------------------------------

const WAYFINDER_MAP = "wayfinder:map";
const READY_FOR_AGENT = "ready-for-agent";

/** What one Issue resolves to at dispatch time (CONTEXT.md's Dispatch). */
export type DispatchOutcome =
  | { kind: "wayfinder"; id: string; command: string }
  | { kind: "implement"; id: string; command: string }
  | { kind: "human" }
  | { kind: "not-dispatched"; reason: "excluded" | "run-root" };

/**
 * Resolve an Issue's dispatch precedence (automatic, no human disambiguation):
 * `wontfix` → excluded (terminal); `ready-for-human` / `needs-info` /
 * `needs-triage` → human turn, never auto-dispatched (checked before the agent
 * dispatch rules — "never" is absolute, per spec user story 13); `wayfinder:<non-map>` → `/wayfinder {id}`
 * (beats `ready-for-agent`); `ready-for-agent` (incl. paired with
 * `wayfinder:map`) → `/implement {id}`; `wayfinder:map` alone → run-root, not
 * dispatched; unlabeled ⇒ `needs-triage` ⇒ human turn.
 */
export function dispatch(issue: Issue): DispatchOutcome {
  const labels = issue.labels;

  if (labels.includes("wontfix")) return { kind: "not-dispatched", reason: "excluded" };

  if (labels.some((l) => HUMAN_ROLES.has(l))) return { kind: "human" };

  const wf = labels.find((l) => l.startsWith("wayfinder:") && l !== WAYFINDER_MAP);
  if (wf) return { kind: "wayfinder", id: issue.id, command: `/wayfinder ${issue.id}` };

  if (labels.includes(READY_FOR_AGENT)) {
    return { kind: "implement", id: issue.id, command: `/implement ${issue.id}` };
  }

  if (labels.includes(WAYFINDER_MAP)) return { kind: "not-dispatched", reason: "run-root" };

  return { kind: "human" };
}

/**
 * Auto-mode filter — spawns only the two AFK types: `ready-for-agent`
 * (→ /implement) and `wayfinder:research` (→ /wayfinder). Every other outcome
 * — other wayfinder types, human turns, wontfix, run-roots, unlabeled — waits.
 */
export function autoSpawnable(issue: Issue): boolean {
  const d = dispatch(issue);
  if (d.kind === "implement") return true;
  if (d.kind === "wayfinder") return issue.labels.includes("wayfinder:research");
  return false;
}

// --- frontier --------------------------------------------------------------

/**
 * The set of issues claimable right now (CONTEXT.md): `open ∧ unclaimed ∧
 * every blockedBy id resolved`, ordered first-by-number — the record's
 * adapter-owned `order` field (the local-markdown tracker fills it from the
 * numeric filename prefix per its frontier convention; ties broken by id for a
 * stable, deterministic order).
 */
export function frontier(issues: Issue[]): Issue[] {
  return issues
    .filter((i) => i.status === "open" && i.assignee === null)
    .filter((i) => i.blockedBy.every((b) => blockerResolved(b, i, issues)))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}
