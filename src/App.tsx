// ============================================================================
// The primary shell — two-pane list + detail (issues 09 + 10).
//
// Left: a fixed 40% list pane of every Issue, grouped by run-root (the effort
// directory encoded in each id), ghui-style rows (state glyph · #id · truncated
// title · tasks ratio · age). Right: a detail pane (60%) showing the selected
// Issue's labels, blocked-by, agent, tasks, age, and markdown-rendered body.
//
// Keys:  j/k (↑/↓) move · Tab swap the focused pane (border reflects focus)
//        Enter/x/s/S gate behind a confirmation dialog · r reload · q quit
//        (Esc no longer quits — inside a dialog Esc/q cancel, outside it is a
//        no-op; the gate at each verb's top is the single entry to every
//        Confirmable action, so keyboard and mouse can never bypass it.)
//
// Structure (architecture review 2026-08, layered-frontend layout): this file
// is the composition root — the thin Solid render adapter over the
// ShellController seam (services/shell). It owns almost no logic: the data
// pipeline, the view/cursor state, the Confirmable verbs, the mouse/keyboard
// surfaces, and the detail-pane state each live in a hooks/ module; the
// presentational panes live in components/; the pure rules (grouping, list
// state, icon precedence, focus cycling, theme tokens) live in lib/. One cross-
// view theme module (lib/theme.ts) drives the header, list, detail, and footer.
// ============================================================================

import { createSignal, createMemo, Show, onMount, onCleanup, type Component } from "solid-js";
import { TextAttributes } from "@opentui/core";
import { useRenderer, useTerminalDimensions } from "@opentui/solid";
import type { Issue, IssueDetail } from "#/services/tracker/provider.js";
import type { AgentStatus } from "#/services/herdr/types.js";
import type { ShellController } from "#/services/shell/shell.js";
import type { ConfirmDialog } from "#/lib/confirm.js";
import { blockerResolved, issueLabel } from "#/lib/issues.js";
import { trunc } from "#/lib/format.js";
import { attention } from "#/lib/attention.js";
import { THEME, stateColor } from "#/lib/theme.js";
import { copySelection } from "#/lib/selection.js";
import type { AppView } from "#/types.js";
import { useHerdrData } from "#/hooks/useHerdrData.js";
import { useSelection } from "#/hooks/useSelection.js";
import { useVerbs } from "#/hooks/useVerbs.js";
import { usePointer } from "#/hooks/usePointer.js";
import { useKeys } from "#/hooks/useKeys.js";
import { useIssueDetail } from "#/hooks/useIssueDetail.js";
import { ListPane } from "#/components/ListPane.js";
import { TreePane } from "#/components/TreePane.js";
import { DetailPane } from "#/components/DetailPane.js";
import { ConfirmOverlay } from "#/components/ConfirmOverlay.js";
import { RoleText } from "#/components/RoleText.js";

export interface AppProps {
  /** The shell controller — owns the Confirmable verbs, the gate, and the
   *  load/poll pipeline (built in index.tsx with the provider, coordinator,
   *  run-controller, and merged `[confirm]` policy). */
  shell: ShellController;
  /** Pre-loaded issues render synchronously (test seam); production omits it. */
  initialIssues?: Issue[];
  /** Pre-loaded detail for the first selection (test seam); production omits it. */
  initialDetail?: IssueDetail;
  /** Initial view (test seam); production defaults to the primary list. */
  initialView?: AppView;
  /** Initial list cursor (test seam) — the one-shot renderer can't move it, so
   *  smokes that need a non-first-row selection seed it (production starts at
   *  row 0, the first category header). */
  initialCursor?: number;
  /** The confirmation dialog already open on first render (test seam — paints
   *  the overlay over the two-pane shell, mirroring initialIssues/initialDetail);
   *  production starts with no dialog open. */
  initialModal?: ConfirmDialog;
  /** Called on q. Defaults to `renderer.destroy()` (restores the terminal); overridable for tests. */
  onQuit?: () => void;
}

export const App: Component<AppProps> = (props) => {
  const renderer = useRenderer();
  const dims = useTerminalDimensions();
  const [tick, setTick] = createSignal(0); // attention pulse

  // Attention pulse — toggles human-turn icons orange ↔ soft-gold (prototype 06).
  onMount(() => {
    const id = setInterval(() => setTick((t) => t ^ 1), 600);
    onCleanup(() => clearInterval(id));
  });
  const pulse = () => tick() === 1;

  // The controller-facing data pipeline (load/poll/agent-state/run-pulse).
  // `onReload` lets a fresh load reset the cursors back to the top — the
  // selection hook is built after this one, so it's wired through a ref.
  const onReloadRef = { current: null as null | (() => void) };
  const data = useHerdrData(props.shell, props.initialIssues, {
    onReload: () => onReloadRef.current?.(),
  });

  // The live agent_status of an issue's dispatched pane (issue 13), or
  // undefined when it isn't dispatched / its pane isn't tracked.
  const agentStatusOf = (issue: Issue): AgentStatus | undefined => data.agentStates().get(issue.id);
  const agentStatusFor = (id: string): AgentStatus | undefined => data.agentStates().get(id);

  // The view/cursor/selection state both panes and every verb share.
  const sel = useSelection({
    issues: data.issues,
    loaded: data.loaded,
    error: data.error,
    initialView: props.initialView,
    initialCursor: props.initialCursor,
    // The category summary's your-turn count — the same predicate the header's
    // counters use (attention + live agent state).
    isAttention: (issue) => attention(issue, agentStatusOf(issue)) !== null,
  });
  onReloadRef.current = sel.resetCursors;

  // A blocker id ("10") resolves against the loaded issue set, scoped to the
  // referencing issue's effort so `"05"` in two efforts can't cross-match.
  const resolvedFor = (issue: Issue) => (id: string) => blockerResolved(id, issue, data.issues());

  // The four Confirmable verbs, gated through the shell (gate → confirm →
  // feedback signals the panes paint).
  const verbs = useVerbs({
    shell: props.shell,
    selected: sel.selected,
    bumpRun: data.bumpRun,
    setIssues: data.setIssues,
    initialModal: props.initialModal ? { dialog: props.initialModal, focus: "confirm" } : null,
  });

  // The shell's mouse surface (select/focus/wheel/double-click dispatch).
  const pointer = usePointer({
    selectById: sel.selectById,
    selectTreeById: sel.selectTreeById,
    doDispatch: verbs.doDispatch,
    move: sel.move,
    treeMove: sel.treeMove,
    setFocus: sel.setFocus,
  });

  // The detail pane: fetched body, width math, remount key, displayed content.
  const detail = useIssueDetail({
    shell: props.shell,
    selected: sel.selected,
    selectedCategory: sel.selectedCategory,
    initialDetail: props.initialDetail,
    dispatchState: verbs.dispatchState,
    releaseState: verbs.releaseState,
    runVersion: data.runVersion,
    pulse,
    agentStatusOf,
    resolvedFor,
    view: sel.view,
  });

  useKeys({
    onQuit: props.onQuit,
    modal: verbs.modal,
    setModal: verbs.setModal,
    confirmModal: verbs.confirmModal,
    view: sel.view,
    move: sel.move,
    treeMove: sel.treeMove,
    doDispatch: verbs.doDispatch,
    doRelease: verbs.doRelease,
    startRun: verbs.startRun,
    stopRun: verbs.stopRun,
    toggleView: sel.toggleView,
    load: data.load,
    setFocus: sel.setFocus,
  });

  // The confirmation overlay's keyed <Show> key — includes which dialog, the
  // focused button, and the dimensions, so every focus move / open / resize
  // remounts the overlay (OpenTUI 0.5.1 doesn't repaint in place — the shell's
  // established workaround, same as the detail pane and row selection).
  const modalKey = createMemo(() => {
    const m = verbs.modal();
    return m ? `${m.dialog.trigger}|${m.focus}|${dims().width}x${dims().height}` : null;
  });

  const openCount = () => sel.shown().filter((i) => i.status === "open").length;
  const yourTurn = () => sel.shown().filter((i) => attention(i, agentStatusOf(i)) !== null).length;

  return (
    <box flexDirection="column" flexGrow={1} live={true} backgroundColor={THEME.surface.bg} onMouseUp={() => copySelection(renderer)}>
      {/* header — flexShrink:0 keeps the row from collapsing when a below pane
          overflows; without it OpenTUI 0.5.1 lays the overflowing pane content
          over the header and the header disappears. */}
      <box flexGrow={0} flexShrink={0} flexDirection="row" paddingLeft={1} paddingRight={1} backgroundColor={THEME.surface.panel}>
        <RoleText role="h2">◆ herdr-frontier</RoleText>
        {sel.view() === "tree" ? (
          <>
            <RoleText role="meta">  dependency tree  </RoleText>
            <RoleText role="h2">{sel.treeEffort()}</RoleText>
            <RoleText role="meta">  </RoleText>
          </>
        ) : (
          <RoleText role="meta">  issues  </RoleText>
        )}
        <text fg={THEME.text.title}>{sel.shown().length}</text>
        <RoleText role="meta">  ·  </RoleText>
        <text fg={stateColor("frontier")}>{openCount()} open</text>
        <RoleText role="meta">  ·  </RoleText>
        <text fg={THEME.state.human} attributes={TextAttributes.BOLD}>{yourTurn()} your-turn</text>
        <RoleText role="meta" flexGrow={1}> </RoleText>
      </box>

      {/* two-pane body — the primary list+detail shell or the secondary
          dependency-tree shell (issue 15), switched by `t` */}
      <Show
        when={sel.view() === "tree"}
        fallback={
          <box flexDirection="row" flexGrow={1}>
            {/* list pane — definite 40%, flexShrink:0 so content can't push it */}
            <ListPane
              rows={sel.rows()}
              selectedId={sel.selected()?.id ?? null}
              selectedRoot={sel.selectedCategory()?.root ?? null}
              innerW={detail.listInnerW()}
              focused={sel.focus() === "list"}
              pulse={pulse()}
              agentStatusOf={agentStatusFor}
              isResolved={resolvedFor}
              onRowMouseDown={pointer.onRowMouseDown}
              onWheel={pointer.onListWheel}
              scrollRef={sel.listScrollRef}
            />
            {/* detail pane — definite 60% */}
            <DetailPane
              title={sel.selected() ? ` ${issueLabel(sel.selected()!)} ` : " Detail "}
              focused={sel.focus() === "detail"}
              onMouseDown={pointer.onDetailMouseDown}
              detailKey={detail.detailKey()}
              width="60%"
              flexGrow={1}
              flexShrink={0}
              content={detail.detailContent()}
            />
          </box>
        }
      >
        {/* secondary shell: lean tree (top) + detail pane (below) — the locked
            07 run view (issue 15): a forward forest of the list-selected
            issue's run-root, the tree scrolling (auto-scrolling the cursor into
            view) and the detail pane below carrying the selected node's verbose
            record. No spatial graph — structure via connectors, detail via the
            pane (issue 07's lock). */}
        <box flexDirection="column" flexGrow={1}>
          <TreePane
            rows={sel.treeRows()}
            selectedId={sel.selected()?.id ?? null}
            innerW={detail.treeInnerW()}
            focused={sel.focus() === "list"}
            pulse={pulse()}
            agentStatusOf={agentStatusFor}
            isResolved={resolvedFor}
            onRowMouseDown={pointer.onTreeRowMouseDown}
            onWheel={pointer.onTreeWheel}
            scrollRef={sel.treeScrollRef}
          />
          {/* detail pane — the verbose selected-node record, below (~38%) */}
          <DetailPane
            title={sel.selected() ? ` Detail · ${issueLabel(sel.selected()!)} ` : " Detail "}
            focused={sel.focus() === "detail"}
            onMouseDown={pointer.onDetailMouseDown}
            detailKey={detail.detailKey()}
            height="38%"
            content={detail.detailContent()}
          />
        </box>
      </Show>

      {/* footer */}
      <box flexGrow={0} flexDirection="row" paddingLeft={1} paddingRight={1} backgroundColor={THEME.surface.panel}>
        <RoleText role="meta">
          {sel.view() === "tree"
            ? "Tab pane · j/k move · Enter dispatch · x stop+reopen · s run · S stop+release · t list · r reload · q quit"
            : "Tab pane · j/k move · Enter dispatch · x stop+reopen · s run · S stop+release · t tree · r reload · q quit"}
        </RoleText>
        <RoleText role="meta" flexGrow={1}> </RoleText>
        <text fg={THEME.accent.id}>
          {sel.selected() ? `${issueLabel(sel.selected()!)} · ${trunc(sel.selected()!.title, 40)}` : ""}
        </text>
      </box>

      {/* the confirmation overlay — the shell's last child, absolute + zIndex,
          so it layers above both panes and the footer while a dialog is open.
          Keyed remount (see modalKey): every focus move repaints the buttons.
          The fallback is a real (zero-size) element: Solid's server-mode Show
          returns "" — an orphan text node — when `when` is falsy with no
          fallback, the shell's established keyed-<Show> workaround always
          passes one. */}
      <Show when={modalKey()} keyed fallback={<box width={0} height={0} />}>
        {(_k: string) => {
          const m = verbs.modal()!;
          return (
            <ConfirmOverlay
              dialog={m.dialog}
              focus={m.focus}
              onCancel={() => verbs.setModal(null)}
              onConfirm={verbs.confirmModal}
              terminalWidth={dims().width}
            />
          );
        }}
      </Show>
    </box>
  );
};