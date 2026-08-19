// Manual single-issue dispatch (issue 12): the shared claim mutex + the dispatch
// path. `Enter` on a selected Issue → dispatch check → claim → `herdr agent
// start` from the profile (`kind` from a minimal profile + `default_profile`,
// model raw in `args`) → prompt with `/implement {id}` or `/wayfinder {id}`.
// `{id}` is the issue's identity token: the repo-relative `.md` path for the
// local-markdown provider, the tracker's native id for any other provider. The
// body is never embedded in the command — `/implement`/`/wayfinder` parse
// `{id}` themselves.
//
// The automated run-controller (issue 14) shares the ClaimRegistry so manual and
// automated dispatches never double-dispatch the same Issue. Everything here is
// IO-behind-seams: a TrackerProvider (Seam 1) + the injectable herdr client (Seam 3).

import { dispatch } from "#/lib/orchestrator.js";
import { issueLabel } from "#/lib/issues.js";
import { trunc } from "#/lib/format.js";
import { AlreadyClaimed, ClaimBusy, type Issue, type TrackerProvider } from "#/services/tracker/provider.js";
import { HerdrClient } from "#/services/herdr/client.js";
import type { AgentRecord, AgentStatus } from "#/services/herdr/types.js";
import { attentionTransitions, mapAgentStates } from "#/lib/agent-state.js";
import { profileKeyFor, resolveProfile, type ProfilesConfig } from "#/lib/profiles.js";
import { ClaimRegistry } from "#/services/dispatch/claims.js";

/**
 * A valid herdr agent-session name for an issue (the prompt/`agent read`
 * target). herdr requires: lowercase letter first, then [a-z0-9_-], ≤32 chars.
 * The old `#NN` label violated that (starts with `#`), so we derive
 * `<effort>-<num>` instead — which also disambiguates two efforts' "#09".
 * Reads the record's adapter-owned `effort`/`num` facts (Card 2); the caller
 * passes the whole Issue so nothing here parses the id.
 * Exported for the run-controller's transcript ingester (issue 17), which
 * targets the same agent `agent read` takes the name of.
 */
export function sessionNameFor(issue: Issue): string {
  return sanitizeAgentName(`${issue.effort}-${issue.num}`);
}

/** Map arbitrary text onto herdr's agent-name charset (lowercase, [a-z0-9_-],
 *  ≤32, letter-first). */
function sanitizeAgentName(raw: string): string {
  let s = raw.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/(^-+)|(-+$)/g, "");
  if (!s) return "issue";
  if (!/^[a-z]/.test(s)) s = `a-${s}`;
  return s.slice(0, 32);
}

/** Human tab label for the dispatched agent's tab. */
function tabLabelFor(issue: Issue): string {
  return trunc(issue.title, 40);
}

export interface DispatchDeps {
  client: HerdrClient;
  provider: TrackerProvider;
  profiles: ProfilesConfig;
  claims: ClaimRegistry;
  /** Where the dispatched agent tab lands (defaults to the plugin's cwd). */
  cwd?: string;
  /** How long after dispatch before a dead-dispatch check may release an
   *  unconfirmed claim whose tab is gone (lets the agent register first).
   *  Defaults to 10s. */
  deadDispatchGraceMs?: number;
  /** The shell-prompt regex {@link HerdrClient.waitForShell} gates `agent start`
   *  on (defaults to `DEFAULT_PROMPT_REGEX`; override for a non-standard prompt). */
  shellPromptRegex?: string;
  /** How long to wait for the fresh tab's shell prompt before failing the
   *  dispatch (defaults to `DEFAULT_SHELL_READY_TIMEOUT_MS`). */
  shellReadyTimeoutMs?: number;
}

export type DispatchFailureReason =
  | "already-dispatched"
  | "already-claimed"
  | "claim-busy"
  | "not-dispatchable";

export type DispatchResult =
  | {
      ok: true;
      issue: Issue;
      /** The `/implement {id}` / `/wayfinder {id}` prompt sent to the agent. */
      command: string;
      paneId: string;
      kind: string;
      args: string[];
    }
  | { ok: false; issue: Issue; command: string | null; reason: DispatchFailureReason };

/** The inverse of {@link DispatchResult} — stop an in-flight issue and reopen it. */
export type ReleaseResult =
  | { ok: true; issue: Issue; tabClosed: boolean }
  | { ok: false; issue: Issue; message: string };

export class DispatchCoordinator {
  /** The attention watcher's prev-snapshot memory (issue 13) — drives the diff
   *  that decides which issues newly need a human (→ `herdr notification show`).
   *  `null` until the first poll primes the baseline (avoids startup toast spam
   *  for issues that were already human-turn before the pane opened). */
  private prevAttention: { issues: Issue[]; agentStates: Map<string, AgentStatus> } | null = null;

  constructor(private readonly deps: DispatchDeps) {}

  /**
   * Manual dispatch of one Issue (CONTEXT.md: Dispatch): check dispatchability
   * first (never dispatch a human turn), gate on the loaded status, take the
   * in-session mutex, then **claim** it through the provider — the atomic,
   * cross-process mutex intent that writes `Status: claimed` BEFORE any work
   * (issue 12 acceptance #1). With the claim held, drive herdr: tab → wait for
   * its shell prompt → agent start (profile kind + raw args) → prompt with
   * `/implement {id}` / `/wayfinder {id}`. Two claim outcomes are surfaced as
   * failures rather than thrown: a
   * concurrent process that won the race between our load and our call raises
   * {@link AlreadyClaimed} (`already-claimed`, issue 12 acceptance #3); a
   * contended/stale claim lock raises {@link ClaimBusy} (`claim-busy` — no status
   * was written, so the issue is still open and the dispatch is retryable). A
    * herdr failure after a successful claim releases the in-session mutex; the
    * issue stays claimed until {@link DispatchCoordinator.releaseIssue} reopens
    * it (or it's manually reset to `open`).
    */
  async dispatchIssue(issue: Issue): Promise<DispatchResult> {
    const outcome = dispatch(issue);
    if (outcome.kind !== "implement" && outcome.kind !== "wayfinder") {
      return { ok: false, issue, command: null, reason: "not-dispatchable" };
    }
    const command = outcome.command;
    if (issue.status !== "open") {
      return { ok: false, issue, command, reason: "already-claimed" };
    }
    if (!this.deps.claims.tryClaim(issue.id)) {
      return { ok: false, issue, command, reason: "already-dispatched" };
    }
    try {
      // The atomic, cross-process mutex intent: Status → claimed, written before
      // any work. This is the authoritative claim — two processes cannot both
      // flip it — so a race won between our load and here surfaces as
      // AlreadyClaimed (caught below), not a double-dispatch.
      const claimed = await this.deps.provider.claim(issue.id);
      const profile = resolveProfile(this.deps.profiles, profileKeyFor(issue));
      const name = sessionNameFor(issue);
      const { paneId, tabId } = await this.deps.client.createTab({
        cwd: this.deps.cwd ?? process.cwd(),
        label: tabLabelFor(issue),
        focus: false,
      });
      this.deps.claims.setTabId(issue.id, tabId);
      this.deps.claims.setPaneId(issue.id, paneId);
      // `agent start` fast-fails a fresh tab whose shell is still initializing
      // (`agent_pane_busy: not an available shell` — its --timeout only covers
      // post-launch readiness). Wait for the pane's shell prompt first.
      await this.deps.client.waitForShell(paneId, {
        pattern: this.deps.shellPromptRegex,
        timeoutMs: this.deps.shellReadyTimeoutMs,
      });
      await this.deps.client.startAgent({ name, kind: profile.kind, pane: paneId, args: profile.args });
      await this.deps.client.prompt(name, command, paneId);
      return { ok: true, issue: claimed, command, paneId, kind: profile.kind, args: profile.args };
    } catch (e) {
      // A concurrent dispatcher won the claim race — free the in-session mutex
      // and report it; the issue is safely held by the other dispatcher.
      if (e instanceof AlreadyClaimed) {
        this.deps.claims.release(issue.id);
        return { ok: false, issue, command, reason: "already-claimed" };
      }
      // The claim lock is contended or stale (ClaimBusy). The critical section
      // never ran, so no status was written — the issue is still open. Free the
      // in-session mutex; a retry can succeed once the lock clears.
      if (e instanceof ClaimBusy) {
        this.deps.claims.release(issue.id);
        return { ok: false, issue, command, reason: "claim-busy" };
      }
      // The handoff failed AFTER the tab was created (agent start / prompt
      // error, e.g. `agent_pane_busy`). Close the orphan tab we just created so
      // a failed dispatch doesn't leak a bare-shell tab — best-effort, since the
      // claim itself can't be undone (it stays until `releaseIssue`/manual
      // reset). Then free the in-session mutex so a retry is possible.
      const orphanTabId = this.deps.claims.tabIdOf(issue.id);
      if (orphanTabId) {
        try {
          await this.deps.client.closeTab(orphanTabId);
        } catch {
          // swallow — the claim/mutex cleanup below still runs
        }
      }
      this.deps.claims.release(issue.id);
      throw e;
    }
  }

  /**
   * Stop an in-flight Issue and reopen it (the inverse of {@link dispatchIssue}):
   * release the tracker claim (`Status:` → `open`, atomic), then close the herdr
   * tab THIS session spawned for it (best-effort), then free the in-session
   * mutex so the issue is re-dispatchable. The provider release is authoritative
   * — on its failure (e.g. {@link ClaimBusy}) nothing else happens: the issue
   * stays claimed, the tab keeps running, and the mutex stays held (retryable).
   * A foreign/stale claim (no tab tracked in this session) is reopened but its
   * tab — which we didn't create — is left untouched.
   */
  async releaseIssue(issue: Issue): Promise<ReleaseResult> {
    let released: Issue;
    try {
      released = await this.deps.provider.release(issue.id);
    } catch (e) {
      return { ok: false, issue, message: e instanceof Error ? e.message : String(e) };
    }
    // Close the tab this dispatch created, if any. Best-effort: a failed close
    // (already gone, herdr error) doesn't block the reopen — the issue is open
    // and re-dispatchable; the orphan tab is a minor leak the user can close.
    const tabId = this.deps.claims.tabIdOf(issue.id);
    let tabClosed = false;
    if (tabId) {
      try {
        await this.deps.client.closeTab(tabId);
        tabClosed = true;
      } catch {
        // swallow — see above
      }
    }
    this.deps.claims.release(issue.id);
    return { ok: true, issue: released, tabClosed };
  }

  /**
   * Sync the in-session mutex with tracker status after a reload/poll. The
   * implement skill resolves the issue from another pane when it finishes; this
   * releases ids whose work is done (`resolved`) or was reset back to `open`
   * after we had confirmed our claim (`claimed` → `open`), so they can be
   * re-dispatched. An `open` id that was never confirmed is still in the
   * pre-reload window (claim just written, not yet observed) — keep it.
   */
  reconcileClaims(issues: Issue[]): void {
    for (const id of this.deps.claims.ids()) {
      const issue = issues.find((i) => i.id === id);
      if (!issue) continue; // not in the loaded set — leave as-is
      if (issue.status === "claimed") {
        this.deps.claims.confirm(id);
      } else if (issue.status === "resolved") {
        this.deps.claims.release(id);
      } else if (issue.status === "open" && this.deps.claims.isConfirmed(id)) {
        this.deps.claims.release(id); // was in-flight, now reset → re-dispatchable
      }
    }
  }

  /**
   * The ~2s poll's whole reconcile (architecture review 2026-08, card 3): the
   * fresh snapshot's claims, the dead-dispatch cleanup, and the attention
   * diff + notification side effect — with ONE `herdr agent list` read feeding
   * both the dead-dispatch check and the live agent-state map (two reconcilers
   * used to spawn the CLI twice per tick). The shell controller's tick calls
   * this, then steps the run-controller on the same snapshot.
   *
   * Returns the fresh issue-id → `AgentStatus` map so the caller can feed it
   * into the signal that drives the list rows live.
   */
  async reconcileTick(freshIssues: Issue[]): Promise<Map<string, AgentStatus>> {
    this.reconcileClaims(freshIssues);
    const agents = await this.deps.client.listAgents();
    await this.reconcileDeadDispatches(agents);
    return this.reconcileAttention(freshIssues, agents);
  }

  /**
   * Release dispatches whose herdr tab was closed before our claim was first
   * observed on a reload (status never reached `claimed` in this session's
   * view). Without this, closing a tab in that window would leave the issue
   * pinned as "already dispatched" forever. Confirmed dispatches are skipped —
   * the tracker status owns those. A grace window (default 10s) after dispatch
   * avoids racing the agent's registration in `herdr agent list`.
   */
  private async reconcileDeadDispatches(agents: AgentRecord[]): Promise<void> {
    const grace = this.deps.deadDispatchGraceMs ?? 10_000;
    const now = Date.now();
    const candidates = this.deps.claims.ids().filter((id) => {
      if (this.deps.claims.isConfirmed(id)) return false; // claim observed — status owns it
      const at = this.deps.claims.dispatchedAtOf(id);
      return at != null && now - at >= grace && this.deps.claims.paneIdOf(id) != null;
    });
    if (candidates.length === 0) return;
    const alive = new Set(agents.map((a) => a.pane_id).filter((p): p is string => typeof p === "string"));
    for (const id of candidates) {
      const pane = this.deps.claims.paneIdOf(id);
      if (pane && !alive.has(pane)) {
        this.deps.claims.release(id); // tab closed / agent gone before claim observed
      }
    }
  }

  /**
   * The ~2s poll's payload (issue 13): for each in-flight dispatch, the
   * `agent_status` (`working`/`idle`/`blocked`/`done`) of the herdr pane it
   * landed in — fed into Solid signals so the list rows update live. The
   * coordinator owns the issue-id → pane-id mapping (the `ClaimRegistry`); the
   * pure pane→status mapping lives in `agent-state.ts`. An issue whose pane is
   * gone (tab closed / agent vanished) simply drops out, which the display
   * layer reads as "no live state" and falls back to the issue's own status.
   */
  private mapAgentStates(agents: AgentRecord[]): Map<string, AgentStatus> {
    const issueToPane = new Map<string, string>();
    for (const id of this.deps.claims.ids()) {
      const pane = this.deps.claims.paneIdOf(id);
      if (pane) issueToPane.set(id, pane);
    }
    return mapAgentStates(agents, issueToPane);
  }

  /**
   * The attention watcher's per-tick reconcile (issue 13): diff the fresh agent
   * states + issue snapshot against the previous tick's, and fire a `herdr
   * notification show` toast for each issue that newly needs a human — an Issue
   * that became `ready-for-human` (label change) or a dispatched agent that
   * went `blocked` (agent-status change). Idempotent across polls
   * (stays-blocked / stays-human doesn't re-fire). `agents` is the tick's one
   * shared `agent list` read, already fetched by {@link reconcileTick}.
   *
   * Returns the fresh issue-id → `AgentStatus` map so the caller can feed it
   * into the Solid signal that drives the list rows live. The pure diff lives
   * in `attentionTransitions` (agent-state.ts); this method owns the
   * prev-snapshot memory + the notification side effect, keeping the herdr
   * client behind the coordinator seam. Notification failures are swallowed
   * (best-effort — the toast is a side-channel, not on the dispatch critical
   * path).
   */
  private async reconcileAttention(
    freshIssues: Issue[],
    agents: AgentRecord[],
  ): Promise<Map<string, AgentStatus>> {
    const agentStates = this.mapAgentStates(agents);
    // First poll — prime the baseline without firing. Otherwise every issue
    // that was already human-turn before the pane opened would toast at startup.
    if (this.prevAttention === null) {
      this.prevAttention = { issues: freshIssues, agentStates };
      return agentStates;
    }
    const newAttention = attentionTransitions({
      prevIssues: this.prevAttention.issues,
      nextIssues: freshIssues,
      prevStates: this.prevAttention.agentStates,
      nextStates: agentStates,
    });
    this.prevAttention = { issues: freshIssues, agentStates };
    for (const issue of newAttention) {
      try {
        await this.deps.client.showNotification({
          title: attentionTitle(issue, agentStates.get(issue.id)),
          body: issue.title,
          sound: "request", // the human-handoff beat (research 01 §4)
        });
      } catch {
        // swallow — the toast is best-effort; the inline ☻ marker still surfaces it
      }
    }
    return agentStates;
  }
}

/**
 * The toast title for a newly-needs-human issue. Carries the short `#id` (the
 * row's identity) plus the kind of attention — `ready for human` (label) or
 * `agent blocked` (agent state) — so the user knows which trigger fired.
 */
function attentionTitle(issue: Issue, agentStatus?: AgentStatus): string {
  const why = agentStatus === "blocked" ? "agent blocked" : "ready for human";
  return `herdr-frontier: ${issueLabel(issue)} ${why}`;
}
