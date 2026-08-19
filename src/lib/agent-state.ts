// Live agent state + attention transitions (issue 13, Seam 2 in the spec's
// Testing Decisions) — pure functions over `Issue[]` + `AgentRecord[]` + the
// issue-id → pane-id mapping the ClaimRegistry owns. No IO, no herdr; unit-
// tested with plain data.
//
// The poll loop (App.tsx) calls `mapAgentStates` each tick (~2s — the proven
// reference pattern from research 01) to derive the issue-id → AgentStatus
// signal that updates the list rows live, then `attentionTransitions` to diff
// the previous and fresh snapshots and fire `herdr notification show` for the
// two handoff triggers the issue names:
//   1. an Issue that newly became `ready-for-human` (label change, from the
//      tracker), and
//   2. a dispatched agent that newly went `blocked` (agent-status change).
// `needs-info` / `needs-triage` get the inline ☻ marker (display layer) but
// are attention-lane only — they do NOT raise a notification (spec.md:234).
// Polling is the default state source (PUSH over the raw socket is a future
// optimization, explicitly out of scope here).

import type { AgentRecord, AgentStatus } from "#/services/herdr/types.js";
import type { Issue } from "#/services/tracker/provider.js";
import { attention } from "#/lib/attention.js";

/**
 * Build the issue-id → `AgentStatus` map from a fresh `herdr agent list` poll.
 * The caller passes the issue-id → pane-id mapping (built from the
 * `ClaimRegistry`'s tracked panes); an issue whose pane is no longer in the
 * agent list (tab closed / agent gone) simply drops out, which the display
 * layer reads as "no live state" and falls back to the issue's own status.
 */
export function mapAgentStates(
  agents: AgentRecord[],
  issueToPane: Map<string, string>,
): Map<string, AgentStatus> {
  const byPane = new Map<string, AgentStatus>();
  for (const a of agents) {
    if (a.pane_id) byPane.set(a.pane_id, a.agent_status);
  }
  const out = new Map<string, AgentStatus>();
  for (const [issueId, paneId] of issueToPane) {
    const status = byPane.get(paneId);
    if (status !== undefined) out.set(issueId, status);
  }
  return out;
}

export interface AttentionTransitionInput {
  prevIssues: Issue[];
  nextIssues: Issue[];
  prevStates: Map<string, AgentStatus>;
  nextStates: Map<string, AgentStatus>;
}

/**
 * The issue ids that "need a human" for the notification's purposes this
 * snapshot: `attention` at its `"notify"` kind — a `ready-for-human` triage
 * role, or a dispatched agent that is `blocked` (issue 13 — CONTEXT.md:
 * Attention lane is label state PLUS agent state). Everything else
 * (working/idle/done agents, needs-info, needs-triage) is not a notification
 * trigger — the `"notify"`/`"human"` split lives in the one `attention`
 * predicate (Card 4), never in a separate test here.
 */
function notifiableIds(issues: Issue[], states: Map<string, AgentStatus>): Set<string> {
  const ids = new Set<string>();
  const byId = new Map(issues.map((i) => [i.id, i]));
  for (const id of new Set([...issues.map((i) => i.id), ...states.keys()])) {
    if (attention(byId.get(id) ?? null, states.get(id)) === "notify") ids.add(id);
  }
  return ids;
}

/**
 * The issues that newly need a human this tick (→ `herdr notification show`).
 * An issue fires when it was NOT in the previous snapshot's notifiable set but
 * is in this one's — covering both triggers uniformly:
 *   1. an Issue that newly became `ready-for-human` (label change), and
 *   2. a dispatched agent that newly went `blocked` (agent-status change).
 *
 * Idempotent across polls: an issue that stays `ready-for-human`, or an agent
 * that stays `blocked`, does not re-fire — and an issue that was already
 * needing a human (e.g. already `ready-for-human`) does not re-fire when a
 * second trigger (agent blocked) lands. Issues that dropped off the list
 * (resolved/removed) are ignored. The latest issue record is carried so the
 * caller has the title/id for the toast body.
 */
export function attentionTransitions(input: AttentionTransitionInput): Issue[] {
  const { prevIssues, nextIssues, prevStates, nextStates } = input;
  const prevAttention = notifiableIds(prevIssues, prevStates);
  const nextAttention = notifiableIds(nextIssues, nextStates);
  const nextById = new Map(nextIssues.map((i) => [i.id, i]));

  const newAttention: Issue[] = [];
  for (const id of nextAttention) {
    if (prevAttention.has(id)) continue; // already needed a human — not a transition
    const issue = nextById.get(id);
    if (issue) newAttention.push(issue);
  }
  return newAttention;
}
