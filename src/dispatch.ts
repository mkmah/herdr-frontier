// Manual single-issue dispatch (issue 12): the shared claim mutex + the dispatch
// path. `Enter` on a selected Issue → dispatch check → claim → resolve `{id}` to
// the Issue body (the plugin's job — `/implement` does not parse `{id}`) →
// `herdr agent start` from the profile (`kind` from a minimal profile +
// `default_profile`, model raw in `args`).
//
// The automated run-controller (issue 14) shares the ClaimRegistry so manual and
// automated dispatches never double-dispatch the same Issue. Everything here is
// IO-behind-seams: a TrackerProvider (Seam 1) + the injectable herdr client (Seam 3).

import { dispatch, type DispatchOutcome } from "./orchestrator.js";
import { issueNum, trunc } from "./logic.js";
import { AlreadyClaimed, type Issue, type IssueDetail, type TrackerProvider } from "./tracker/provider.js";
import { HerdrClient } from "./herdr-client.js";
import { profileKeyFor, resolveProfile, type ProfilesConfig } from "./profiles.js";

/**
 * The in-session claim mutex (CONTEXT.md: Claim). The tracker's `claim` verb is
 * the cross-process gate; this registry is the orchestrator-level one — the
 * first gate checked before any dispatch, shared by manual (issue 12) and
 * automated (issue 14) dispatchers.
 */
export class ClaimRegistry {
  private readonly claimed = new Set<string>();

  /** Claim `id` for this session; false when it is already claimed. */
  tryClaim(id: string): boolean {
    if (this.claimed.has(id)) return false;
    this.claimed.add(id);
    return true;
  }

  /** Free `id` so a later dispatch can retry. */
  release(id: string): void {
    this.claimed.delete(id);
  }
}

/** Resolve a dispatch outcome's `{id}` to the Issue body for the agent prompt. */
export function resolvePrompt(outcome: DispatchOutcome, detail: IssueDetail): string | null {
  if (outcome.kind === "wayfinder") return `/wayfinder ${detail.body}`;
  if (outcome.kind === "implement") return `/implement ${detail.body}`;
  return null;
}

/** Short stable agent-session name for an issue (later the prompt target). */
function sessionNameFor(id: string): string {
  return issueNum(id);
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
}

export type DispatchFailureReason = "already-dispatched" | "already-claimed" | "not-dispatchable";

export type DispatchResult =
  | {
      ok: true;
      issue: Issue;
      /** The dispatchable `/implement <id>`/`/wayfinder <id>` command (id form). */
      command: string;
      /** The full prompt sent to the agent (the body resolved into the command). */
      prompt: string;
      paneId: string;
      kind: string;
      args: string[];
    }
  | { ok: false; issue: Issue; command: string | null; reason: DispatchFailureReason };

export class DispatchCoordinator {
  constructor(private readonly deps: DispatchDeps) {}

  /**
   * Manual dispatch of one Issue: check dispatchability first (never claim a
   * human turn), take the shared claim mutex, then claim on the tracker, read
   * the body to resolve `{id}`, and drive herdr: tab → agent start (profile
   * kind + raw args) → prompt. On `{id}`→body resolution failures nothing is
   * claimed; on a claim refusal the mutex is freed for a retry.
   */
  async dispatchIssue(issue: Issue): Promise<DispatchResult> {
    const outcome = dispatch(issue);
    if (outcome.kind !== "implement" && outcome.kind !== "wayfinder") {
      return { ok: false, issue, command: null, reason: "not-dispatchable" };
    }
    if (!this.deps.claims.tryClaim(issue.id)) {
      return { ok: false, issue, command: outcome.command, reason: "already-dispatched" };
    }
    try {
      const claimed = await this.deps.provider.claim(issue.id);
      const detail = await this.deps.provider.readIssue(issue.id);
      const prompt = resolvePrompt(outcome, detail);
      if (prompt === null) {
        return { ok: false, issue, command: outcome.command, reason: "not-dispatchable" };
      }
      const profile = resolveProfile(this.deps.profiles, profileKeyFor(issue));
      const name = sessionNameFor(issue.id);
      const { paneId } = await this.deps.client.createTab({
        cwd: this.deps.cwd ?? process.cwd(),
        label: tabLabelFor(issue),
        focus: false,
      });
      await this.deps.client.startAgent({ name, kind: profile.kind, pane: paneId, args: profile.args });
      await this.deps.client.prompt(name, prompt, paneId);
      return { ok: true, issue: claimed, command: outcome.command, prompt, paneId, kind: profile.kind, args: profile.args };
    } catch (e) {
      if (e instanceof AlreadyClaimed) {
        // We never took the claim — free the mutex so a later dispatch can retry.
        this.deps.claims.release(issue.id);
        return { ok: false, issue, command: outcome.command, reason: "already-claimed" };
      }
      // Any later failure: the tracker-side claim stands (claim before work is
      // the mutex contract), so the in-session gate stays held with it.
      throw e;
    }
  }
}
