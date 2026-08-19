// The pure run-advance state machine (issue 14, Seam 2 in the spec's Testing
// Decisions) — the frontier-of-the-run plus the member status transition,
// unit-tested with plain data and no IO. The controller (/controller.ts) and
// the persistence seam (/store.ts) build on this.

import type { Issue } from "#/services/tracker/provider.js";
import { autoSpawnable, frontier } from "#/lib/orchestrator.js";

/** Lifecycle of a run (CONTEXT.md: Run). */
export type RunStatus = "running" | "completed" | "stopped";

/** One tracked Issue's status within a run. */
export type RunIssueStatus =
  | "pending" // open, auto-spawnable, blockers clear — eligible now
  | "waiting" // HITL turn, or blockers not yet clear — the run waits
  | "dispatched" // claimed/in-flight in a herdr pane
  | "resolved" // done
  | "skipped" // wontfix, or the run-root itself — never work
  | "failed"; // the dispatch threw; retried next tick

/** A tracked Issue's state within a run (the run → issue → pane → status link). */
export interface RunIssueState {
  id: string;
  status: RunIssueStatus;
  /** The herdr pane this run spawned the issue into (the `paneId` mapping). */
  paneId?: string;
  dispatchedAt?: number;
  error?: string;
  /** The agent kind this run dispatched (the profile's `kind` — issue 17). */
  kind?: string;
  /** Issue 17: this member's transcript has been ingested (persisted so a
   *  rehydrated run never writes the same result back twice). */
  ingested?: boolean;
  /** Issue 17: a best-effort ingest failure — surfaced, never fatal. */
  ingestError?: string;
}

/** One run's persisted record — the crash-rehydratable state (spec:240). */
export interface RunState {
  /** Deterministic per run-root (`run-<root>`), so rehydrate finds the same run. */
  id: string;
  /** The run-root: the effort directory the run walks (map/spec/to-tickets). */
  root: string;
  status: RunStatus;
  concurrency: number;
  startedAt: number;
  completedAt?: number;
  issues: RunIssueState[];
}

/** A deterministic run id for a run-root (one run file per run-root; restart
 *  rehydrates the same run instead of forking a new one). */
export function runIdFor(root: string): string {
  return `run-${sanitize(root)}`;
}

function sanitize(s: string): string {
  const out = s.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/(^-+)|(-+$)/g, "");
  return out || "root";
}

/** The Issues a run-root's graph walks: every Issue in the root's effort. */
export function runScope(issues: Issue[], root: string): Issue[] {
  return issues.filter((i) => i.effort === root);
}

/** True when every tracked member is terminal — the run has nothing left to do. */
export function runCompleted(run: RunState): boolean {
  return run.issues.length > 0 && run.issues.every((m) => m.status === "resolved" || m.status === "skipped");
}

export interface AdvanceRunResult {
  /** The reconciled run: members (re)derived from the fresh snapshot. */
  run: RunState;
  /** The members eligible to dispatch this tick, frontier-ordered. */
  eligible: Issue[];
}

/**
 * The pure run-advance state machine (Seam 2): given a run and the fresh issue
 * snapshot, reconcile every member's status and report which are eligible now.
 *  - The graph walk: any scope issue not yet tracked is picked up as a member.
 *  - Status is rederived from the snapshot every tick — `resolved` → resolved,
 *    `claimed` → dispatched (in-flight, pane still running), `open` →
 *    pending/eligible when auto-spawnable and on the frontier, else waiting
 *    (HITL turn or blockers not yet clear). `wontfix` and the `wayfinder:map`
 *    run-root are skipped as never-work. `failed` is transient — rederived
 *    away the next tick.
 *  - The run completes when every member is resolved or skipped.
 */
export function advanceRun(run: RunState, allIssues: Issue[], now: number = Date.now()): AdvanceRunResult {
  const next: RunState = { ...run, issues: run.issues.map((m) => ({ ...m })) };
  const byId = new Map(allIssues.map((i) => [i.id, i]));

  // Graph walk: pick up any scope issue not yet tracked (issues appear
  // mid-run — a wayfinder research spawns the next to-tickets set).
  for (const issue of runScope(allIssues, run.root)) {
    if (!next.issues.some((m) => m.id === issue.id)) next.issues.push({ id: issue.id, status: "pending" });
  }

  const autoFrontier = new Set(frontier(allIssues).filter(autoSpawnable).map((i) => i.id));

  for (const member of next.issues) {
    const fresh = byId.get(member.id);
    if (!fresh) {
      member.status = "skipped"; // the issue vanished — no longer work for the run
      continue;
    }
    if (fresh.status === "resolved") {
      member.status = "resolved";
      continue;
    }
    if (fresh.status === "claimed") {
      member.status = "dispatched"; // in-flight — ours or a foreign claim, both count
      continue;
    }
    // fresh.status === "open"
    if (fresh.labels.includes("wontfix") || fresh.labels.includes("wayfinder:map")) {
      member.status = "skipped"; // terminal, or the run-root itself — never work
      continue;
    }
    if (!autoSpawnable(fresh) || !autoFrontier.has(fresh.id)) {
      member.status = "waiting"; // HITL turn, or a blocker not yet clear
      continue;
    }
    member.status = "pending"; // eligible now
  }

  const eligible = next.issues
    .filter((m) => m.status === "pending")
    .map((m) => byId.get(m.id)!)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

  if (runCompleted(next)) {
    next.status = "completed";
    next.completedAt = next.completedAt ?? now;
  }

  return { run: next, eligible };
}