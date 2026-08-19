// The herdr vocabulary the rest of the app reads — hoisted out of the IO
// adapter so the pure rule layer (domain/) imports its types from a module
// with no side effects, never from the adapter that shells out (architecture
// review 2026-08, card 4). The adapter (./client.ts) imports these too.

/** A spawned-pane agent record parsed from `herdr agent list` JSON. */
export interface AgentRecord {
  agent: string;
  agent_status: AgentStatus;
  pane_id?: string;
  tab_id?: string;
  cwd?: string;
}

/** herdr's `agent_status` vocabulary (research 01). */
export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";