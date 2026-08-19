// The primary shell's list pane — the definite 40% bordered "Issues" column.
// Feeds its cursor/wheel/mouse to App's handlers; the rows it paints are pure
// derivations (domain/rows, domain/format) fed in from App. Presentational —
// the pane owns no state of its own.

import { type Component, For, Show } from "solid-js";
import { TextAttributes, type MouseEvent } from "@opentui/core";
import type { Issue } from "#/services/tracker/provider.js";
import type { AgentStatus } from "#/services/herdr/types.js";
import type { Row } from "#/lib/rows.js";
import { THEME } from "#/lib/theme.js";
import { IssueRow } from "#/components/IssueRow.js";

export interface ListPaneProps {
  /** The flat render rows (buildRows) — error/empty/group/issue. */
  rows: Row[];
  /** The id of the currently selected issue, if any (row-level selection). */
  selectedId: string | null;
  /** The root of the selected category header, if any — the header rows paint
   *  the same selected background an issue row does (collapsible-categories 01). */
  selectedRoot: string | null;
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

export const ListPane: Component<ListPaneProps> = (p) => (
  <box
    flexDirection="column"
    width="40%"
    flexShrink={0}
    border={true}
    borderStyle="rounded"
    borderColor={p.focused ? THEME.border.focused : THEME.border.idle}
    title=" Issues "
    titleColor={p.focused ? THEME.border.focused : THEME.text.dim}
  >
    <scrollbox ref={p.scrollRef} flexGrow={1} scrollY={true} onMouseScroll={p.onWheel}>
      <For each={p.rows}>
        {(row) => {
          switch (row.kind) {
            case "error":
              return <text fg={THEME.state.blocked} paddingLeft={1}>{` error: ${row.message}`}</text>;
            case "empty":
              return <text fg={THEME.text.dim} paddingLeft={1}> no issues found under .scratch/*/issues/</text>;
            case "group":
              // The header is a selectable row like any other — selected it
              // paints the issue-selection background. Keyed remount so the
              // backgroundColor applies (OpenTUI 0.5.1 repaint quirk, same as
              // IssueRow), and a stable `group:<root>` id so the scrollbox's
              // scrollChildIntoView can find it. The gap above the header is a
              // *margin*, not padding: padding would paint the selection
              // background into the whitespace above the row. `▸` stays
              // decorative until the fold ticket gives it a live state.
              return (
                <Show when={`${p.selectedRoot === row.root ? 1 : 0}`} keyed>
                  {(_k: string) => (
                    <box
                      id={`group:${row.root}`}
                      flexDirection="row"
                      paddingLeft={1}
                      marginTop={1}
                      backgroundColor={p.selectedRoot === row.root ? THEME.selBg : undefined}
                    >
                      <text fg={THEME.accent.triage} attributes={TextAttributes.BOLD}>{`▸ ${row.root}`}</text>
                      <text fg={THEME.text.dim}>{`  ${row.count}`}</text>
                    </box>
                  )}
                </Show>
              );
            case "issue":
              return (
                <IssueRow
                  issue={row.issue}
                  selected={p.selectedId === row.issue.id}
                  innerW={p.innerW}
                  isResolved={p.isResolved(row.issue)}
                  agentStatus={p.agentStatusOf(row.issue.id)}
                  pulse={p.pulse}
                  rowId={row.issue.id}
                  onMouseDown={(e: MouseEvent) => p.onRowMouseDown(e, row.issue.id)}
                />
              );
          }
        }}
      </For>
    </scrollbox>
  </box>
);