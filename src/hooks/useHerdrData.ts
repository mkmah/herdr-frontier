// useHerdrData — the controller-facing data pipeline (architecture review
// 2026-08, layered-frontend layout). Owns every piece of state the shell's
// load/poll cycle produces: the issue snapshot, the load/error flags, the live
// agent-state map (issue 13), and the run-controller pulse (issue 14). The
// controller (ShellController) does the work behind one fresh snapshot per
// tick; this hook only applies the returned deltas.
//
// Extracted from App.tsx so the composition root stays a thin wire-up of
// hooks — App.tsx no longer knows the load/poll mechanics.

import { createSignal, onMount, onCleanup } from "solid-js";
import type { ShellController } from "#/services/shell/shell.js";
import type { Issue } from "#/services/tracker/provider.js";
import type { AgentStatus } from "#/services/herdr/types.js";
import { sortIssues } from "#/lib/issues.js";

export function useHerdrData(
  shell: ShellController,
  initialIssues?: Issue[],
  opts: { onReload?: () => void } = {},
) {
  const [issues, setIssues] = createSignal<Issue[]>(initialIssues ?? []);
  const [error, setError] = createSignal<string | null>(null);
  const [loaded, setLoaded] = createSignal<boolean>(!!initialIssues);
  // Live agent state (issue 13): issue-id → agent_status from the ~2s poll.
  // Empty until the first poll; the rows fall back to the issue's own status.
  const [agentStates, setAgentStates] = createSignal<Map<string, AgentStatus>>(new Map());
  // Run-controller pulse (issue 14): bumped after start/stop/step so the detail
  // pane's run-status line remounts with fresh run state.
  const [runVersion, setRunVersion] = createSignal(0);

  async function load() {
    setLoaded(false);
    setError(null);
    const res = await shell.load();
    if (res.ok) {
      setIssues(sortIssues(res.issues));
      opts.onReload?.();
    } else {
      setError(res.error);
    }
    setLoaded(true);
  }

  // Production auto-loads on mount. (The OpenTUI test renderer skips onMount and
  // createEffect, so tests pass `initialIssues`/`initialDetail` to exercise the
  // render synchronously.)
  if (!initialIssues) onMount(load);

  // Background poll — the controller's tick runs the whole reconcile pipeline
  // on one fresh snapshot (claims → dead-dispatch → attention → run-step) and
  // returns the state delta to apply: a fresh issue list, the live agent-state
  // map (rows update live), and a run-status pulse. Silent: a failed tick (null)
  // changes nothing — the next tick retries; never resets selection or flashes
  // a loading state (that's what `r` / load() are for).
  async function poll() {
    const res = await shell.tick();
    if (!res) return;
    setIssues(sortIssues(res.issues));
    setAgentStates(res.agentStates);
    setRunVersion((v) => v + 1);
  }
  onMount(() => {
    const id = setInterval(poll, 2000);
    onCleanup(() => clearInterval(id));
  });

  return {
    issues,
    setIssues,
    error,
    loaded,
    agentStates,
    runVersion,
    /** Bump the run pulse without a poll (start/stop bump it immediately). */
    bumpRun: () => setRunVersion((v) => v + 1),
    load,
  };
}
