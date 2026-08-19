// Issue-identity and resolution helpers — the pure derivations over the
// record's adapter-owned `num` / `effort` fields (Card 2: policy never parses
// the id itself). Labels, short `#id`s, triage classification, and blocker
// resolution. No IO.

import type { Issue } from "#/services/tracker/provider.js";

/** The row's short `#id` label — read from the record's adapter-owned `num`,
 *  never parsed here (Card 2). */
export function issueLabel(issue: Issue): string {
  return `#${issue.num}`;
}

/**
 * Match a tracker-supplied blocker ref (a full id or a bare numeric prefix like
 * `"05"`) to its short `#label`. Refs arrive from the tracker as raw strings,
 * so this one id-format rule lives on the policy side — the adapter could fully
 * resolve refs at parse time (a future seam test); policy still compares by
 * label.
 */
export function refLabel(ref: string): string {
  const file = ref.split("/").pop() ?? ref;
  const digits = file.match(/^(\d+)/)?.[1];
  return digits ? `#${digits}` : `#${file.replace(/\.md$/, "")}`;
}

/** The triage role label for an issue (first non-wayfinder label, else needs-triage). */
export function triageOf(issue: Issue): string {
  return issue.labels.find((l) => !l.startsWith("wayfinder:")) ?? "needs-triage";
}

/** Sort issues by run-root then title (stable display order across reloads). */
export function sortIssues(issues: Issue[]): Issue[] {
  return [...issues].sort((a, b) => (a.effort + a.title).localeCompare(b.effort + b.title));
}

/**
 * Is a blockedBy id resolved for `issue`, per the loaded issue set? A blocker id
 * is matched as a full id first, else by its `refLabel` — but only against
 * issues in the same effort directory, so `"05"` in two efforts can't resolve
 * each other's blockers. An id that resolves to nothing is unresolved.
 */
export function blockerResolved(blockerId: string, issue: Issue, issues: Issue[]): boolean {
  const exact = issues.find((i) => i.id === blockerId);
  if (exact) return exact.status === "resolved";
  const num = refLabel(blockerId);
  return issues.some(
    (i) => i.status === "resolved" && i.effort === issue.effort && issueLabel(i) === num,
  );
}