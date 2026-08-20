// The secondary view's tree pane — the bordered "Dependencies" column above
// the detail pane in the two-pane dependency-tree shell (issue 15). Paints the
// flattened forward-forest rows (domain/tree), feeding cursor/wheel/mouse to
// App's handlers. Presentational — no state of its own.

import { type Component, For } from "solid-js";
import { type MouseEvent } from "@opentui/core";
import type { Issue } from "#/services/tracker/provider.js";
import type { AgentStatus } from "#/services/herdr/types.js";
import type { TreeRow } from "#/lib/tree.js";
import { THEME } from "#/lib/theme.js";
import { IssueRow } from "#/components/IssueRow.js";

export interface TreePaneProps {
  /** The flat render rows — the fold-aware tree rows (collapsible-categories 03):
   *  `foldForest(buildForest(…), collapsed)`; a folded node keeps its own row
   *  and prunes its descendants, and rows carry their per-node chevron state. */
  rows: TreeRow[];
  /** The id of the currently selected node, if any. */
  selectedId: string | null;
  /** The row budget inner width (dims minus the scrollbox inset). */
  innerW: number;
  focused: boolean;
  pulse: boolean;
  /** The dispatched pane's live agent state, if any (issue 13). */
  agentStatusOf: (id: string) => AgentStatus | undefined;
  /** Blocker membership per issue (the loaded set, effort-scoped). */
  isResolved: (issue: Issue) => (id: string) => boolean;
  onRowMouseDown: (e: MouseEvent, id: string) => void;
  onWheel: (e: MouseEvent) => void;
  /** The scrollbox element ref — App auto-scrolls the cursor row into view. */
  scrollRef: (el: any) => void;
}

export const TreePane: Component<TreePaneProps> = (p) => (
  <box
    flexDirection="column"
    flexGrow={1}
    border={true}
    borderStyle="rounded"
    borderColor={p.focused ? THEME.border.focused : THEME.border.idle}
    title=" Dependencies "
    titleColor={p.focused ? THEME.border.focused : THEME.text.dim}
  >
    <scrollbox ref={p.scrollRef} flexGrow={1} scrollY={true} onMouseScroll={p.onWheel}>
      <For each={p.rows}>
        {(row) => (
          <IssueRow
            issue={row.issue}
            selected={p.selectedId === row.issue.id}
            innerW={p.innerW}
            isResolved={p.isResolved(row.issue)}
            agentStatus={p.agentStatusOf(row.issue.id)}
            pulse={p.pulse}
            depth={row.depth}
            branch={row.branch}
            chevron={row.hasChildren ? (row.folded ? "▸" : "▾") : undefined}
            rowId={row.issue.id}
            onMouseDown={(e: MouseEvent) => p.onRowMouseDown(e, row.issue.id)}
          />
        )}
      </For>
    </scrollbox>
  </box>
);