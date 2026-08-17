// Automated run-controller (issue 14): a **run** bound to a **run-root** — on
// this substrate the `.scratch/<effort>` directory a map/spec/to-tickets set
// lives in — that walks the dependency graph and spawns each Issue as its
// blockers clear. The controller shares the manual dispatcher's claim mutex
// (the same ClaimRegistry, so manual and automated dispatches never double-
// dispatch), caps parallel panes per run, and persists run → issue → pane →
// status to the plugin state dir (`HERDR_PLUGIN_STATE_DIR`) so a crashed
// controller rehydrates on restart. Auto-mode spawns only the AFK types
// (`ready-for-agent` → /implement, `wayfinder:research` → /wayfinder);
// everything HITL waits for the human.
//
// Seams (spec Testing Decisions): the pure advance — the frontier-of-the-run
// plus the member status transition — is Seam 2, plain-data unit-tested with
// no IO; the controller is IO-behind-seams: a TrackerProvider (Seam 1), the
// injectable herdr client (Seam 3, reached through the shared
// DispatchCoordinator), and an injectable RunStore (the persistence seam).

import { join } from "node:path";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { Issue, TrackerProvider } from "./tracker/provider.js";
import { effortOf, issueNumber } from "./logic.js";
import { autoSpawnable, frontier } from "./orchestrator.js";
import { sessionNameFor, type DispatchCoordinator } from "./dispatch.js";
import { DEFAULT_PROFILES } from "./profiles.js";
import type { TranscriptIngester } from "./transcript.js";

// --- configuration ----------------------------------------------------------

/** The env var herdr injects with the plugin's writable state dir. */
export const STATE_DIR_KEY = "HERDR_PLUGIN_STATE_DIR";

/** The config key capping parallel panes per run (issue 14 fog: "default +
 *  config key"). Read from the environment when no explicit cap is given. */
export const RUN_CONCURRENCY_KEY = "HERDR_BEADS_MAX_PARALLEL_PANES";

/** Default cap on parallel panes per run (issue 14 fog: default + configurable). */
export const DEFAULT_RUN_CONCURRENCY = 3;

/** How long a terminal (completed/stopped) run record is kept before prune. */
export const DEFAULT_RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** How often stepAll prunes the store (bounded by time, not per tick). */
const PRUNE_INTERVAL_MS = 60_000;

/** The plugin's state dir: `HERDR_PLUGIN_STATE_DIR` if herdr injected it, else a
 *  repo-local fallback (so standalone `bun run src/index.tsx` still persists). */
export function pluginStateDir(): string {
  return process.env[STATE_DIR_KEY] ?? join(process.cwd(), ".herdr-frontier", "state");
}

/** Parse the {@link RUN_CONCURRENCY_KEY} config key into a positive integer,
 *  else undefined (the caller falls back to the default). */
function concurrencyFromEnv(): number | undefined {
  const raw = process.env[RUN_CONCURRENCY_KEY];
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// --- state model ------------------------------------------------------------

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

// --- pure advance (Seam 2) --------------------------------------------------

/** The Issues a run-root's graph walks: every Issue in the root's effort. */
export function runScope(issues: Issue[], root: string): Issue[] {
  return issues.filter((i) => effortOf(i.id) === root);
}

/** True when every tracked member is terminal — the run has nothing left to do. */
function runCompleted(run: RunState): boolean {
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
    .sort((a, b) => issueNumber(a.id) - issueNumber(b.id) || a.id.localeCompare(b.id));

  if (runCompleted(next)) {
    next.status = "completed";
    next.completedAt = next.completedAt ?? now;
  }

  return { run: next, eligible };
}

// --- persistence seam (RunStore) --------------------------------------------

/** The persistence seam: where run records live (the plugin state dir shape). */
export interface RunStore {
  load(root: string): RunState | null;
  save(run: RunState): void;
  all(): RunState[];
  remove(root: string): void;
  /** Delete terminal (completed/stopped) runs older than `maxAgeMs` — the
   *  cleanup that stops the state dir growing unboundedly. Running runs and
   *  recent terminal ones survive. */
  prune(maxAgeMs?: number): void;
}

/** The filesystem store: one JSON file per run-root under the state dir's
 *  `runs/` (one file per run-root keeps growth bounded by the number of
 *  efforts; prune drops terminal runs after the retention window). */
export class FileRunStore implements RunStore {
  private readonly dir: string;

  constructor(opts: { dir: string }) {
    this.dir = opts.dir;
  }

  private fileFor(root: string): string {
    return join(this.dir, `${sanitize(root)}.json`);
  }

  load(root: string): RunState | null {
    try {
      const parsed = JSON.parse(readFileSync(this.fileFor(root), "utf8")) as RunState;
      return parsed.root === root ? parsed : null;
    } catch {
      return null;
    }
  }

  save(run: RunState): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.fileFor(run.root), JSON.stringify(run, null, 2) + "\n", "utf8");
  }

  all(): RunState[] {
    let entries: string[];
    try {
      entries = readdirSync(this.dir);
    } catch {
      return [];
    }
    const out: RunState[] = [];
    for (const f of entries) {
      if (!f.endsWith(".json")) continue;
      try {
        out.push(JSON.parse(readFileSync(join(this.dir, f), "utf8")) as RunState);
      } catch {
        // skip corrupt/partial files — a crash mid-write shouldn't wedge the store
      }
    }
    return out;
  }

  remove(root: string): void {
    rmSync(this.fileFor(root), { force: true });
  }

  prune(maxAgeMs: number = DEFAULT_RUN_RETENTION_MS): void {
    const now = Date.now();
    for (const run of this.all()) {
      if (run.status === "running") continue;
      const endedAt = run.completedAt ?? run.startedAt;
      if (now - endedAt > maxAgeMs) this.remove(run.root);
    }
  }
}

// --- controller -------------------------------------------------------------

export interface RunControllerDeps {
  provider: TrackerProvider;
  /** The shared manual dispatcher — its ClaimRegistry is the one mutex both
   *  manual and automated dispatches go through (no double-dispatch). */
  coordinator: DispatchCoordinator;
  store: RunStore;
  /** Max parallel panes per run (default {@link DEFAULT_RUN_CONCURRENCY}; the
   *  {@link RUN_CONCURRENCY_KEY} config key overrides when this is unset). */
  concurrency?: number;
  /** Issue 17: the transcript ingester — a resolved member's finished-run
   *  output is extracted and written back (best-effort; absent → no ingest). */
  transcripts?: TranscriptIngester;
}

/**
 * The automated run-controller (CONTEXT.md: Run). `start` binds a run to a
 * run-root; the App's poll loop calls `stepAll` each tick, and the controller
 * walks the root's graph — dispatching each eligible member through the shared
 * `DispatchCoordinator` (claim-before-dispatch, one claim mutex with manual
 * mode) up to the concurrency cap, and persisting run → issue → pane → status
 * after every step so a crashed controller rehydrates the same run on restart.
 */
export class RunController {
  private readonly deps: RunControllerDeps;
  private lastPruneAt = 0;

  constructor(deps: RunControllerDeps) {
    this.deps = deps;
  }

  /** The persisted run for a run-root, if any. */
  load(root: string): RunState | null {
    return this.deps.store.load(root);
  }

  /** The store's currently running runs — the subset every run-wide verb
   *  (stop-all / step-all) works on, and the confirmation gate's skip fact. */
  private running(): RunState[] {
    return this.deps.store.all().filter((r) => r.status === "running");
  }

  /** How many runs are currently running (confirmation gate 02 — run-stop's
   *  structural-skip fact): zero for an empty store, and only `running` runs
   *  count — stopped and completed ones never do. Read-only, against the
   *  controller's store. */
  get runningRuns(): number {
    return this.running().length;
  }

  /** The per-run concurrency cap a run started through this controller would
   *  use (the run-start dialog's copy names it): the deps override, else the
   *  {@link RUN_CONCURRENCY_KEY} env key, else the default. Read-only. */
  get concurrency(): number {
    return this.deps.concurrency ?? concurrencyFromEnv() ?? DEFAULT_RUN_CONCURRENCY;
  }

  /** The total in-flight (dispatched) member count across all running runs —
   *  the run-stop dialog's copy names it. Read-only, against the store;
   *  stopped and completed runs never count (they release nothing). */
  get inflightCount(): number {
    return this.running().reduce((n, r) => n + r.issues.filter((m) => m.status === "dispatched").length, 0);
  }

  /**
   * Start a run bound to a run-root: snapshot its graph and persist it. While
   * a run is already running this is idempotent (returns it) — a rehydrated
   * run is never forked. A completed/stopped run is replaced by a fresh one.
   */
  async start(root: string): Promise<RunState> {
    const existing = this.deps.store.load(root);
    if (existing?.status === "running") return existing;
    const all = await this.deps.provider.listIssues();
    const run: RunState = {
      id: runIdFor(root),
      root,
      status: "running",
      // The controller's effective cap — the same read-only source the
      // run-start confirmation dialog's copy names, so the two can't drift.
      concurrency: this.concurrency,
      startedAt: Date.now(),
      issues: [],
    };
    const { run: advanced } = advanceRun(run, all);
    this.deps.store.save(advanced);
    return advanced;
  }

  /** Stop a run — it idles until restarted (no further dispatch). */
  async stop(root: string): Promise<RunState | null> {
    const run = this.deps.store.load(root);
    if (!run) return null;
    const stopped: RunState = { ...run, status: "stopped" };
    this.deps.store.save(stopped);
    return stopped;
  }

  /** Stop every running run (the dedicated stop key). Returns how many were
   *  stopped. Stopping is per-run root; the poll steps all stored runs, so a
   *  stop-all is the reliable "end the auto-dispatch" control. */
  async stopAll(): Promise<number> {
    let stopped = 0;
    for (const run of this.running()) {
      await this.stop(run.root);
      stopped += 1;
    }
    return stopped;
  }

  /** Stop every running run AND release each run's in-flight panes back to open
   *  (close tab + drop claim + reopen the issue) — the one-key version of
   *  pressing x on every dispatched issue. Halting new dispatch alone leaves the
   *  already-spawned agents running and reacting to edits, which reads as "stop
   *  did nothing". Release is best-effort per pane — a stuck pane is an orphan
   *  the user can close, but it never blocks the other releases or the stop. */
  async stopAllAndRelease(): Promise<number> {
    const runs = this.running();
    for (const run of runs) {
      await this.stop(run.root);
      for (const member of run.issues) {
        if (member.status !== "dispatched") continue;
        const issue = await this.deps.provider.readIssue(member.id).catch(() => null);
        if (!issue) continue;
        try {
          await this.deps.coordinator.releaseIssue(issue);
        } catch {
          // best-effort — the run is stopped regardless
        }
      }
    }
    return runs.length;
  }

  /**
   * Step every running run one tick. Accepts the poll loop's fresh snapshot so
   * the run's work rides on the issues the UI already loaded. A failing run
   * marks its member `failed` (surfaced in the detail pane) — it never wedges
   * the poll. Returns the number of running runs stepped.
   */
  async stepAll(fresh?: Issue[]): Promise<number> {
    const runs = this.running();
    if (runs.length === 0) return 0;
    if (Date.now() - this.lastPruneAt > PRUNE_INTERVAL_MS) {
      this.deps.store.prune();
      this.lastPruneAt = Date.now();
    }
    const all = fresh ?? (await this.deps.provider.listIssues());
    for (const run of runs) {
      try {
        await this.stepWith(run.root, all);
      } catch {
        // A run-wide failure is retried next tick; one broken run never wedges
        // the loop (member-level dispatch errors are already caught in stepWith).
      }
    }
    return runs.length;
  }

  private async stepWith(root: string, all: Issue[]): Promise<void> {
    const run = this.deps.store.load(root);
    if (!run || run.status !== "running") return;

    const { run: next, eligible } = advanceRun(run, all);

    for (const issue of eligible) {
      // The concurrency cap: never more than `next.concurrency` members in
      // flight at once — each dispatch marks its member `dispatched`, so the
      // count below is the live in-flight tally.
      if (next.issues.filter((m) => m.status === "dispatched").length >= next.concurrency) break;
      const member = next.issues.find((m) => m.id === issue.id);
      if (!member) continue;
      try {
        // The shared claim-mutex path: claim (atomic, cross-process) before the
        // agent starts — exactly what manual dispatch does, so the two never
        // double-dispatch. AlreadyClaimed / ClaimBusy / already-dispatched just
        // leave the member waiting for a later tick.
        const result = await this.deps.coordinator.dispatchIssue(issue);
        if (result.ok) {
          member.status = "dispatched";
          member.paneId = result.paneId;
          member.kind = result.kind;
          member.dispatchedAt = Date.now();
          member.error = undefined;
        } else if (result.reason === "not-dispatchable") {
          member.status = "skipped"; // a label changed between advance and dispatch
        } else {
          member.status = "waiting"; // already-dispatched / already-claimed / claim-busy
        }
      } catch (e) {
        member.status = "failed";
        member.error = e instanceof Error ? e.message : String(e);
      }
    }

    // Issue 17: ingest each member whose work the run now sees as finished —
    // the snapshot shows `resolved`, so the ingester writes the extracted
    // result back as a comment. Best-effort: a failed read/extract/write is
    // recorded on the member and retried next tick; it never wedges the run.
    if (this.deps.transcripts) {
      for (const member of next.issues) {
        if (member.status !== "resolved" || member.ingested) continue;
        try {
          await this.deps.transcripts.ingest({
            id: member.id,
            kind: member.kind ?? DEFAULT_PROFILES.default_profile.kind,
            agentName: sessionNameFor(member.id),
          });
          member.ingested = true;
          member.ingestError = undefined;
        } catch (e) {
          member.ingestError = e instanceof Error ? e.message : String(e);
        }
      }
    }

    if (runCompleted(next)) {
      next.status = "completed";
      next.completedAt = next.completedAt ?? Date.now();
    }
    this.deps.store.save(next);
  }
}
