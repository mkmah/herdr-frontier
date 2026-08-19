// The detail pane — the bordered, titled scrollbox the verbose issue record
// lives in, shared by the list view's right-hand pane and the tree view's
// bottom pane (issue 15). Rendered inside a keyed <Show> so the body paints
// when the read lands (see DetailPaneProps.detailKey).
//
// `DetailContent` paints the selected issue's full record: title, label chips,
// blocked-by/agent/tasks/age, the run status, the resolved launch line,
// dispatch/release feedback, and the body — the issue's whole document rendered
// through OpenTUI's <markdown> element under the header rows. Pure display:
// App feeds the displayed state (signals, polling results, the shell's read
// accessors); this module never touches App's internals.

import { type Component, For, Show } from "solid-js";
import { TextAttributes, type MouseEvent } from "@opentui/core";
import { issueLabel } from "#/lib/issues.js";
import { trunc } from "#/lib/format.js";
import { humanizeAge, iconFor } from "#/lib/display.js";
import { dispatch } from "#/lib/orchestrator.js";
import { iconColor, markdownSyntaxStyle, THEME } from "#/lib/theme.js";
import type { DetailContentProps } from "#/types.js";
import { Chip, RoleText } from "#/components/RoleText.js";

const DetailContent: Component<DetailContentProps> = (p) => {
  const sel = p.issue;
  if (!sel) return null;
  const detailRec = p.detail;
  const loaded = detailRec && detailRec.id === sel.id;
  const ic = iconFor(sel, p.isResolved(sel), p.agentStatus);
  const headerBudget = Math.max(0, p.innerW - (2 + issueLabel(sel).length + 2));
  const outcome = dispatch(sel);
  const dispatchable = outcome.kind === "implement" || outcome.kind === "wayfinder";
  const ds = p.dispatch;
  const showDispatch = ds.status !== "idle" && ds.issueId === sel.id;
  const rs = p.release;
  const showRelease = rs.status !== "idle" && rs.issueId === sel.id;
  return (
    <box flexDirection="column" flexGrow={1}>
      <box flexDirection="row">
        <text fg={iconColor(ic.state, p.pulse)} flexShrink={0} attributes={TextAttributes.BOLD}>
          {`${ic.glyph} `}
        </text>
        <text fg={THEME.accent.id} flexShrink={0}>{issueLabel(sel)}</text>
        <text fg={THEME.text.dim} flexShrink={0}>  </text>
        <RoleText role="h1">{trunc(sel.title, headerBudget)}</RoleText>
      </box>
      <box flexDirection="row" flexWrap="wrap" paddingTop={1} paddingBottom={1}>
        <For each={sel.labels}>
          {(label) => <Chip label={label} />}
        </For>
      </box>
      <RoleText role="meta">
        {(() => {
          const live = p.agentStatus;
          return `blocked by: ${sel.blockedBy.length ? sel.blockedBy.join(", ") : "—"}    agent: ${sel.assignee ?? "unclaimed"}${live ? `    live: ${live}` : ""}${sel.tasks ? `    tasks: ${sel.tasks.done}/${sel.tasks.total}` : ""}${sel.updatedAt != null ? `    ${humanizeAge(sel.updatedAt, Date.now())} ago` : ""}`;
        })()}
      </RoleText>
      <box flexDirection="row" paddingTop={1}>
        <RoleText role="meta">dispatch: </RoleText>
        <text fg={dispatchable ? THEME.state.done : THEME.state.human} attributes={TextAttributes.BOLD}>
          {dispatchable ? outcome.command : "(no auto-dispatch — human turn)"}
        </text>
      </box>
      {/* The run-status line remounts on its own key — the ~2s poll bumps
          runVersion every tick, and remounting just this line keeps the
          counts fresh without recreating the whole pane (which made the
          markdown body below flicker on a timer). */}
      <Show when={`run#${p.runVersion}`} keyed>
        {(_runKey: string) => {
          const run = p.runFor(sel.effort);
          if (!run) return null;
          const inflight = run.issues.filter((i) => i.status === "dispatched").length;
          const pending = run.issues.filter((i) => i.status === "pending").length;
          const done = run.issues.filter((i) => i.status === "resolved").length;
          const failed = run.issues.filter((i) => i.status === "failed").length;
          return (
            <box flexDirection="row" paddingTop={1}>
              <RoleText role="meta">run: </RoleText>
              <text fg={run.status === "running" ? THEME.state.running : THEME.state.done} attributes={TextAttributes.BOLD}>
                {`${run.status} · ${inflight} in-flight · ${pending} pending · ${done} done${failed ? ` · ${failed} failed` : ""}`}
              </text>
            </box>
          );
        }}
      </Show>
      <text fg={THEME.text.dimmer}>{""}</text>
      {showDispatch ? (
        <text
          fg={ds.status === "ok" ? THEME.state.done : ds.status === "error" ? THEME.state.blocked : THEME.state.running}
          attributes={TextAttributes.BOLD}
        >
          {ds.status === "ok"
            ? `↳ dispatched to pane ${ds.paneId}`
            : ds.status === "error"
              ? `✗ ${ds.message}`
              : "⟳ dispatching…"}
        </text>
      ) : null}
      {showRelease ? (
        <text
          fg={rs.status === "ok" ? THEME.state.done : rs.status === "error" ? THEME.state.blocked : THEME.state.running}
          attributes={TextAttributes.BOLD}
        >
          {rs.status === "ok"
            ? rs.tabClosed
              ? "↳ reopened — tab closed"
              : "↳ reopened (tab left open)"
            : rs.status === "error"
              ? `✗ ${rs.message}`
              : "⟳ stopping…"}
        </text>
      ) : null}
      {loaded && detailRec ? (
        // syntaxStyle before content: OpenTUI's reconciler applies JSX props
        // as setters in declaration order, so `content` first would build the
        // blocks before the style lands → one unstyled frame on every mount.
        <markdown
          syntaxStyle={markdownSyntaxStyle()}
          content={detailRec.body}
          fg={THEME.text.body}
        />
      ) : (
        <RoleText role="body">{p.loading ? " loading body…" : ""}</RoleText>
      )}
    </box>
  );
};

export interface DetailPaneProps {
  title: string;
  focused: boolean;
  onMouseDown: (e: MouseEvent) => void;
  /** The remount key — selection, read state, focus, width total (see App's
   *  `detailKey`). Null shows the empty-state fallback. */
  detailKey: string | null;
  width?: `${number}%`;
  height?: `${number}%`;
  flexGrow?: number;
  flexShrink?: number;
  /** The displayed state the scrollbox paints once a selection is in. */
  content: DetailContentProps | null;
}

/**
 * The bordered, titled scrollbox the DetailContent lives in — shared by the
 * list view's right-hand pane and the tree view's bottom pane (issue 15).
 * `width`/`height` distinguish the two layouts (60% column vs 38% below).
 */
export const DetailPane: Component<DetailPaneProps> = (p) => (
  <box
    flexDirection="column"
    width={p.width}
    height={p.height}
    flexGrow={p.flexGrow}
    flexShrink={p.flexShrink}
    border={true}
    borderStyle="rounded"
    borderColor={p.focused ? THEME.border.focused : THEME.border.idle}
    title={p.title}
    titleColor={p.focused ? THEME.border.focused : THEME.text.dim}
    onMouseDown={p.onMouseDown}
  >
    <scrollbox flexGrow={1} scrollY={true} paddingLeft={1} paddingRight={1}>
      <Show when={p.detailKey} keyed fallback={<text fg={THEME.text.dim}> select an issue…</text>}>
        {(_k: string) => (
          <DetailContent {...(p.content as DetailContentProps)} />
        )}
      </Show>
    </scrollbox>
  </box>
);