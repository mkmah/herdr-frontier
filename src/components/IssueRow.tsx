// The lean row both panes paint — the list pane's `#id · title · tasks ·
// age` row, and the tree pane's version of the same row with a tree connector
// and depth (issue 15). Selection is a full-row background; a keyed <Show>
// remounts the row when selection/pulse/width change so the backgroundColor
// applies (function accessors aren't applied reactively for this prop in
// OpenTUI 0.5.1). `depth`/`branch`/`rowId` are the tree's additions: depth via
// paddingLeft, a branch connector, and `id` on the box so the scrollboxes'
// scrollChildIntoView can find the row (the list pane passes rowId too, for its
// cursor auto-scroll).
// Pure display — the caller feeds the displayed state (selection, pulse, live
// agent state, blocker resolution); this module never reads App signals.

import { type Component, Show } from "solid-js";
import { TextAttributes, type MouseEvent } from "@opentui/core";
import type { Issue } from "#/services/tracker/provider.js";
import type { AgentStatus } from "#/services/herdr/types.js";
import { issueLabel } from "#/lib/issues.js";
import { humanizeAge, iconFor } from "#/lib/display.js";
import { rowTitleBudget, trunc } from "#/lib/format.js";
import { iconColor, THEME } from "#/lib/theme.js";

export interface IssueRowProps {
  issue: Issue;
  selected: boolean;
  innerW: number;
  /** Blocker membership for the row's issue (the loaded set, effort-scoped). */
  isResolved: (id: string) => boolean;
  /** The dispatched pane's live agent state (issue 13); undefined = no live. */
  agentStatus?: AgentStatus;
  /** The attention pulse — toggles human-turn icons orange ↔ soft-gold. */
  pulse: boolean;
  onMouseDown: (e: MouseEvent) => void;
  /** Tree additions: depth (paddingLeft), branch connector, and row id. */
  depth?: number;
  branch?: string;
  rowId?: string;
  /** The tree's live fold chevron (`▾` expanded / `▸` folded) painted before
   *  the branch connector; a node with no children passes none and shows no
   *  chevron (collapsible-categories 03). */
  chevron?: string;
}

export const IssueRow: Component<IssueRowProps> = (p) => {
  const key = () => `${p.selected ? 1 : 0}|${p.pulse ? 1 : 0}|${p.innerW}|${p.depth ?? 0}|${p.chevron ?? "-"}`;
  return (
    <Show when={key()} keyed>
      {() => {
        const issue = p.issue;
        const depth = p.depth ?? 0;
        const chevron = p.chevron;
        const ic = iconFor(issue, p.isResolved, p.agentStatus);
        const human = ic.state === "human";
        const idStr = issueLabel(issue);
        const tasksStr = issue.tasks ? `${issue.tasks.done}/${issue.tasks.total}` : "";
        const tasksDone = !!issue.tasks && issue.tasks.done >= issue.tasks.total;
        const ageStr = issue.updatedAt != null ? humanizeAge(issue.updatedAt, Date.now()) : "";
        // Reserve every non-collapsing segment (`#id`, tasks, age, the tree's
        // branch connector, fold chevron, and depth padding) at full width; only
        // the title flexes into what remains, floored at 0 so a narrow pane
        // truncates rather than wrap the row to a second line (issue 16).
        const budget = rowTitleBudget({
          innerW: p.innerW,
          branchLen: p.branch ? p.branch.length : 0,
          chevronLen: chevron ? chevron.length + 1 : 0,
          idLen: idStr.length,
          tasksLen: tasksStr.length,
          ageLen: ageStr.length,
          depth,
        });
        return (
          <box
            id={p.rowId}
            flexDirection="row"
            paddingLeft={depth * 2 + 1}
            paddingRight={1}
            backgroundColor={p.selected ? THEME.selBg : undefined}
            onMouseDown={p.onMouseDown}
          >
            {chevron ? (
              <text fg={THEME.accent.triage} attributes={TextAttributes.BOLD} flexShrink={0}>{`${chevron} `}</text>
            ) : null}
            {p.branch ? (
              <text fg={THEME.border.idle} attributes={TextAttributes.BOLD} flexShrink={0}>{p.branch}</text>
            ) : null}
            <text
              fg={iconColor(ic.state, p.pulse)}
              flexShrink={0}
              attributes={human && p.pulse ? TextAttributes.BOLD : 0}
            >
              {`${ic.glyph} `}
            </text>
            <text fg={THEME.accent.id} flexShrink={0}>{idStr}</text>
            <text
              fg={p.selected ? THEME.text.title : THEME.text.body}
              flexGrow={1}
              flexShrink={1}
            >{`  ${trunc(issue.title, budget)}`}</text>
            <text
              fg={tasksDone ? THEME.state.done : THEME.state.blocked}
              flexShrink={0}
            >{tasksStr ? ` ${tasksStr}` : ""}</text>
            <text fg={THEME.text.dim} flexShrink={0}>{ageStr ? ` ${ageStr}` : ""}</text>
          </box>
        );
      }}
    </Show>
  );
};