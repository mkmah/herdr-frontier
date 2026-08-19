// Shared app-level display-state contracts (architecture review 2026-08).
// The types the composition root (App.tsx) threads between the behavior hooks
// and the render layer, plus the verb feedback the detail pane paints. Kept
// in one leaf module so hooks, components, and App import them without cycles.

import type { Issue, IssueDetail } from "#/services/tracker/provider.js";
import type { AgentStatus } from "#/services/herdr/types.js";
import type { RunState } from "#/services/run/advance.js";
import type { ConfirmButton, ConfirmDialog } from "#/lib/confirm.js";

/** The two top-level views: the primary list and the secondary dependency tree. */
export type AppView = "list" | "tree";

/** The detail pane's dispatch feedback, scoped to the issue it dispatched. */
export type DispatchUi =
  | { status: "idle" }
  | { status: "running"; issueId: string }
  | { status: "ok"; issueId: string; paneId: string; command: string }
  | { status: "error"; issueId: string; message: string };

/** The detail pane's release/stop feedback, scoped to the issue it released. */
export type ReleaseUi =
  | { status: "idle" }
  | { status: "running"; issueId: string }
  | { status: "ok"; issueId: string; tabClosed: boolean }
  | { status: "error"; issueId: string; message: string };

/** The confirmation overlay's live state: the dialog to paint + which button
 *  is focused. Confirm is always pre-focused (the rulebook's focusedButton);
 *  the keyboard moves focus between the two ConfirmButtons, and Enter fires
 *  whichever is focused. */
export type ModalState = { dialog: ConfirmDialog; focus: ConfirmButton };

/**
 * The displayed state the detail pane paints — the whole read-only "zoom" view
 * of one issue. App owns the signals behind these; the pane stays presentational.
 */
export interface DetailContentProps {
  /** The selected issue; null when nothing is selected. */
  issue: Issue | null;
  /** The fetched verbose record, when it matches the selection. */
  detail: IssueDetail | null;
  /** A body read is in flight (the " loading body…" placeholder). */
  loading: boolean;
  /** The dispatch/release feedback (App's `dispatchState` / `releaseState`). */
  dispatch: DispatchUi;
  release: ReleaseUi;
  /** The run-controller pulse — remounts the run-status line only (a poll bump
   *  must not recreate the whole pane; the markdown body would flicker). */
  runVersion: number;
  /** The attention pulse — human-turn icons orange ↔ soft-gold. */
  pulse: boolean;
  /** The dispatched pane's live agent state, if any (issue 13). */
  agentStatus?: AgentStatus;
  /** Blocker membership per issue (the loaded set, effort-scoped). */
  isResolved: (issue: Issue) => (id: string) => boolean;
  /** The shell's run-state accessor (the run-status line's subject). */
  runFor: (root: string) => RunState | null;
  /** The pane's inner width (the split differs between the two views). */
  innerW: number;
}
