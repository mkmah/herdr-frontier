// The attention rulebook (CONTEXT.md: Attention lane) — the single shared
// definition of "needs a human": label state (the triage role) PLUS agent state
// (a blocked dispatched agent). One predicate, consumed by both the display
// layer (the ☻ marker) and the notification diff (the toast); they differ by
// the returned kind, never by a separate membership test. Pure — no IO, no
// render.

import type { Issue } from "#/services/tracker/provider.js";
import type { AgentStatus } from "#/services/herdr/types.js";
import { triageOf } from "#/lib/issues.js";

/** The canonical labels that mean "a human must look at this" (CONTEXT.md: attention). */
export const HUMAN_ROLES: ReadonlySet<string> = new Set(["ready-for-human", "needs-info", "needs-triage"]);

/** The human labels that also raise a herdr notification (issue 13). */
const NOTIFY_LABELS: ReadonlySet<string> = new Set(["ready-for-human"]);

/**
 * What an issue needs from a human right now:
 *  - `"notify"` — a `ready-for-human` triage role, or a dispatched agent that
 *    went `blocked`: shows the pulsing ☻ marker AND raises the toast
 *    (CONTEXT.md: Attention lane — label state PLUS agent state).
 *  - `"human"` — the inline ☻ marker only (`needs-info` / `needs-triage` are
 *    attention-lane but never raise a notification, spec.md:234).
 *  - `null` — no human needed.
 *
 * `issue` is null when only an agent state is in hand (an issue id without its
 * record, e.g. an orphan pane); the blocked path still fires.
 */
export function attention(issue: Issue | null, agentStatus?: AgentStatus): "human" | "notify" | null {
  if (agentStatus === "blocked") return "notify";
  if (!issue) return null;
  const label = triageOf(issue);
  if (NOTIFY_LABELS.has(label)) return "notify";
  if (HUMAN_ROLES.has(label)) return "human";
  return null;
}