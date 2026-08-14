// ============================================================================
// The primary shell — two-pane list + detail (issues 09 + 10).
//
// Left: a fixed 40% list pane of every Issue, grouped by run-root (the effort
// directory encoded in each id), ghui-style rows (state glyph · #id · truncated
// title · tasks ratio · age). Right: a detail pane (60%) showing the selected
// Issue's labels, blocked-by, agent, tasks, age, and body.
//
// Keys:  j/k (↑/↓) move · Tab swap the focused pane (border reflects focus)
//        r reload · q/Esc quit
//
// One cross-view theme module (./theme.ts) drives the header, list, detail, and
// footer — change a token and the whole app re-themes. All presentation logic
// (grouping, list state, icon precedence, focus cycling) lives in ./logic.ts +
// ./display.ts so it is unit-testable; this file is the thin Solid render layer.
// ============================================================================

import { createSignal, createMemo, createEffect, For, Show, onMount, onCleanup, type Component } from "solid-js";
import { MouseButton, TextAttributes, type MouseEvent } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid";
import type { Issue, IssueDetail, TrackerProvider } from "./tracker/provider.js";
import type { AgentStatus } from "./herdr-client.js";
import type { RunController } from "./run.js";
import {
  blockerResolved,
  buildRows,
  effortOf,
  issueNum,
  moveCursor,
  sortIssues,
  trunc,
} from "./logic.js";
import { cycleFocus, humanizeAge, iconFor, isHumanTurn, type Focus } from "./display.js";
import { iconColor, THEME, stateColor, triageColor } from "./theme.js";
import { buildForest, flattenForest, type TreeRow } from "./tree.js";
import { dispatch } from "./orchestrator.js";
import type { DispatchCoordinator } from "./dispatch.js";
import { copySelection } from "./selection.js";

/** The two top-level views: the primary list and the secondary dependency tree. */
export type AppView = "list" | "tree";

export interface AppProps {
  provider: TrackerProvider;
  /** Pre-loaded issues render synchronously (test seam); production omits it. */
  initialIssues?: Issue[];
  /** Pre-loaded detail for the first selection (test seam); production omits it. */
  initialDetail?: IssueDetail;
  /** Initial view (test seam); production defaults to the primary list. */
  initialView?: AppView;
  /** Called on q/Esc. Defaults to `renderer.destroy()` (restores the terminal); overridable for tests. */
  onQuit?: () => void;
  /** Manual single-issue dispatch (issue 12). Production builds one in index.tsx. */
  dispatchCoordinator?: DispatchCoordinator;
  /** Automated run-controller (issue 14). Production builds one in index.tsx. */
  runController?: RunController;
}

/** The detail pane's dispatch feedback, scoped to the issue it dispatched. */
type DispatchUi =
  | { status: "idle" }
  | { status: "running"; issueId: string }
  | { status: "ok"; issueId: string; paneId: string; command: string }
  | { status: "error"; issueId: string; message: string };

/** The detail pane's release/stop feedback, scoped to the issue it released. */
type ReleaseUi =
  | { status: "idle" }
  | { status: "running"; issueId: string }
  | { status: "ok"; issueId: string; tabClosed: boolean }
  | { status: "error"; issueId: string; message: string };

/** Chip background for a canonical label — wayfinder → brand, else the triage palette. */
function Chip(props: { label: string }) {
  return (
    <box backgroundColor={triageColor(props.label)} paddingLeft={1} paddingRight={1} marginRight={1}>
      <text fg={THEME.surface.onAccent} attributes={TextAttributes.BOLD}>{props.label}</text>
    </box>
  );
}

/** Typography-role text — titles/labels/body/meta render through THEME.role. */
const RoleText: Component<{ role: keyof typeof THEME["role"]; children: any; flexGrow?: number }> = (p) => {
  const r = THEME.role[p.role];
  return <text fg={r.fg} attributes={r.attr} flexGrow={p.flexGrow}>{p.children}</text>;
};

// --- key handling (pure, unit-tested) ----------------------------------------

/** The actions a key press can trigger — the single source of truth the
 *  `useKeyboard` handler switches on, extracted so the bindings are testable
 *  (issue 14 stop: `s` starts, shift-`s` stops — never a toggle). */
export type AppKeyAction =
  | "quit"
  | "focus"
  | "down"
  | "up"
  | "dispatch"
  | "release"
  | "run-start"
  | "run-stop"
  | "toggle-view"
  | "reload";

/** Map a parsed key event to its action. shift-`s` reaches us as `name: "s"`
 *  with `shift: true` (raw terminal) or `name: "S"` (kitty protocol); both map
 *  to stop. Returns null for keys the shell ignores. */
export function appKeyAction(key: { name?: string; shift?: boolean }): AppKeyAction | null {
  if (key.name === "q" || key.name === "escape") return "quit";
  if (key.name === "tab") return "focus";
  if (key.name === "j" || key.name === "down") return "down";
  if (key.name === "k" || key.name === "up") return "up";
  if (key.name === "return") return "dispatch";
  if (key.name === "x") return "release";
  if (key.name === "s" && !key.shift) return "run-start";
  if (key.name === "S" || (key.name === "s" && key.shift)) return "run-stop";
  if (key.name === "t") return "toggle-view";
  if (key.name === "r") return "reload";
  return null;
}

export const App: Component<AppProps> = (props) => {
  const renderer = useRenderer();
  const dims = useTerminalDimensions();
  const [issues, setIssues] = createSignal<Issue[]>(props.initialIssues ?? []);
  const [error, setError] = createSignal<string | null>(null);
  const [cursor, setCursor] = createSignal(0);
  const [loaded, setLoaded] = createSignal<boolean>(!!props.initialIssues);
  const [focus, setFocus] = createSignal<Focus>("list");
  const [detail, setDetail] = createSignal<IssueDetail | null>(props.initialDetail ?? null);
  const [detailLoading, setDetailLoading] = createSignal(false);
  const [dispatchState, setDispatchState] = createSignal<DispatchUi>({ status: "idle" });
  const [releaseState, setReleaseState] = createSignal<ReleaseUi>({ status: "idle" });
  const [tick, setTick] = createSignal(0); // attention pulse
  // Live agent state (issue 13): issue-id → agent_status from the ~2s poll.
  // Empty until the first poll; the rows fall back to the issue's own status.
  const [agentStates, setAgentStates] = createSignal<Map<string, AgentStatus>>(new Map());
  // Run-controller pulse (issue 14): bumped after start/stop/step so the detail
  // pane's run-status line remounts with fresh run state.
  const [runVersion, setRunVersion] = createSignal(0);
  // Secondary view (issue 15): the dependency tree, toggled from the primary
  // list with `t`. Production defaults to the list; `initialView` is a test seam.
  const [view, setView] = createSignal<AppView>(props.initialView ?? "list");
  // The tree view's cursor over the flattened forward-forest rows.
  const [treeCursor, setTreeCursor] = createSignal(0);
  // The tree scrollbox ref — auto-scrolls the cursor row into view (issue 15).
  let treeScroll: any = null;

  async function load() {
    setLoaded(false);
    setError(null);
    try {
      const fresh = sortIssues(await props.provider.listIssues());
      setIssues(fresh);
      setCursor(0);
      setTreeCursor(0);
      props.dispatchCoordinator?.reconcileClaims(fresh);
      await props.dispatchCoordinator?.reconcileDeadDispatches();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoaded(true);
    }
  }

  // Production auto-loads on mount. (The OpenTUI test renderer skips onMount and
  // createEffect, so tests pass `initialIssues`/`initialDetail` to exercise the
  // render synchronously.)
  if (!props.initialIssues) onMount(load);

  // Attention pulse — toggles human-turn icons orange ↔ soft-gold (prototype 06).
  onMount(() => {
    const id = setInterval(() => setTick((t) => t ^ 1), 600);
    onCleanup(() => clearInterval(id));
  });

  // Background poll — the coordinator claims on dispatch (`open→claimed`) and
  // the implement skill resolves on completion (`claimed→resolved`), both from
  // other panes; refresh so the list reflects reality, and reconcile the
  // in-session claim mutex so an issue reset back to open becomes
  // re-dispatchable. Issue 13: the ~2s poll also feeds each dispatched issue's
  // live agent_status into the `agentStates` signal (rows update live) and
  // fires a herdr notification when an issue newly needs a human (became
  // `ready-for-human` or its dispatched agent went `blocked`) — the ~2s cadence
  // is the proven reference pattern (research 01). Silent: never resets
  // selection or flashes a loading state (that's what `r` / load() are for).
  async function poll() {
    if (!props.dispatchCoordinator) return;
    try {
      const fresh = sortIssues(await props.provider.listIssues());
      setIssues(fresh);
      props.dispatchCoordinator.reconcileClaims(fresh);
      await props.dispatchCoordinator.reconcileDeadDispatches();
      // Agent-state poll + attention transitions → notifications (issue 13).
      // reconcileAttention returns the fresh agent-state map; feed it into the
      // signal so the list rows render live status.
      const states = await props.dispatchCoordinator.reconcileAttention(fresh);
      setAgentStates(states);
      // Automated run-controller (issue 14): step every running run on the same
      // fresh snapshot — dispatch each issue whose blockers have cleared, up to
      // the per-run concurrency cap. Runs share the coordinator's claim mutex.
      await props.runController?.stepAll(fresh);
      setRunVersion((v) => v + 1);
    } catch {
      // Background poll failures are non-fatal — the next tick retries.
    }
  }
  onMount(() => {
    const id = setInterval(poll, 2000);
    onCleanup(() => clearInterval(id));
  });

  const rows = createMemo(() => buildRows({ issues: issues(), loaded: loaded(), error: error() }));
  const listSelected = () => issues()[cursor()];
  // The tree view's pool: the issues of the list-selected issue's run-root
  // (its effort directory). Rooted on the list cursor, so toggling in and out
  // of the tree never chases the tree cursor around.
  const treeRoot = createMemo(() => effortOf(listSelected()?.id ?? ""));
  const treePool = createMemo(() => issues().filter((i) => effortOf(i.id) === treeRoot()));
  const treeRows = createMemo(() => flattenForest(buildForest(treePool())));
  const treeSelected = () => treeRows()[treeCursor()]?.issue;
  // The currently selected issue — view-aware, shared by the detail pane, the
  // dispatch/release/run verbs, and the footer. In the list view it is the
  // list cursor; in the tree view the tree cursor over the forest rows.
  const selected = () => (view() === "tree" ? treeSelected() : listSelected());
  // The issues the header's counters describe — all of them in the list view,
  // the tree pool's run-root scope in the tree view.
  const shown = () => (view() === "tree" ? treePool() : issues());
  const pulse = () => tick() === 1;
  // The live agent_status of an issue's dispatched pane (issue 13), or
  // undefined when it isn't dispatched / its pane isn't tracked.
  const agentStatusOf = (issue: Issue): AgentStatus | undefined => agentStates().get(issue.id);

  // A blocker id ("10") resolves against the loaded issue set, scoped to the
  // referencing issue's effort so `"05"` in two efforts can't cross-match.
  const resolvedFor = (issue: Issue) => (id: string) => blockerResolved(id, issue, issues());

  function move(dir: number) {
    setCursor((c) => moveCursor(c, dir, issues().length));
  }

  // The tree view's cursor moves over the flattened forest rows (issue 15).
  function treeMove(dir: number) {
    setTreeCursor((c) => moveCursor(c, dir, treeRows().length));
  }

  // `t` toggles between the primary list and the dependency tree (issue 15).
  // Entering the tree starts at its first row; the list cursor is untouched so
  // returning lands back where you were.
  function toggleView() {
    const next = view() === "list" ? "tree" : "list";
    setView(next);
    if (next === "tree") setTreeCursor(0);
  }

  // Keep the tree cursor inside the (possibly shrinking) forest as the poll
  // refresh changes the rows, and auto-scroll the cursor row into view.
  createEffect(() => {
    const n = treeRows().length;
    setTreeCursor((c) => Math.min(c, Math.max(0, n - 1)));
  });
  createEffect(() => {
    const id = treeSelected()?.id;
    if (id && treeScroll) {
      try {
        treeScroll.scrollChildIntoView(id);
      } catch {
        // best-effort — a scrollbox quirk must not break cursor movement
      }
    }
  });

  // --- manual dispatch (issue 12) ------------------------------------------
  // `Enter` (or double-click) dispatches the selected Issue: claim → resolve
  // `{id}` → `agent start` from the profile. The coordinator owns the shared
  // claim mutex; we only render its outcome and reflect the claim in the list so
  // the row flips to "running" without a full reload.
  async function doDispatch() {
    const sel = selected();
    if (!sel || !props.dispatchCoordinator) return;
    setDispatchState({ status: "running", issueId: sel.id });
    try {
      const r = await props.dispatchCoordinator.dispatchIssue(sel);
      if (r.ok) {
        setDispatchState({ status: "ok", issueId: sel.id, paneId: r.paneId, command: r.command });
        // The coordinator has already atomically claimed (`Status: claimed`) via
        // the provider before agent start; the background poll reflects it in the
        // list row. Resolution (`→ resolved`) is the implement skill's, later.
      } else {
        const msg =
          r.reason === "already-dispatched"
            ? "already dispatched this session"
            : r.reason === "already-claimed"
              ? "already claimed by another dispatcher"
              : r.reason === "claim-busy"
                ? "claim lock busy — try again"
                : "human turn — not auto-dispatched";
        setDispatchState({ status: "error", issueId: sel.id, message: msg });
      }
    } catch (e) {
      setDispatchState({ status: "error", issueId: sel.id, message: e instanceof Error ? e.message : String(e) });
    }
  }

  // --- stop / reopen an in-flight issue (the inverse of dispatch) ----------
  // `x` reopens the selected Issue (status → open) and closes the herdr tab this
  // session spawned for it. The provider release is authoritative; we optimistically
  // reflect the reopen in the list so the row flips back without a full reload
  // (which would reset the cursor). The background poll reconciles anything stale.
  async function doRelease() {
    const sel = selected();
    if (!sel || !props.dispatchCoordinator) return;
    setReleaseState({ status: "running", issueId: sel.id });
    try {
      const r = await props.dispatchCoordinator.releaseIssue(sel);
      if (r.ok) {
        setReleaseState({ status: "ok", issueId: sel.id, tabClosed: r.tabClosed });
        setIssues((prev) => prev.map((i) => (i.id === sel.id ? { ...i, status: "open" } : i)));
      } else {
        setReleaseState({ status: "error", issueId: sel.id, message: r.message });
      }
    } catch (e) {
      setReleaseState({ status: "error", issueId: sel.id, message: e instanceof Error ? e.message : String(e) });
    }
  }

  // --- automated run (issue 14) --------------------------------------------
  // `s` starts a run bound to the selected Issue's run-root (its effort — the
  // directory a map/spec/to-tickets set lives in); `S` (shift-s) stops every
  // running run AND releases each in-flight pane it dispatched (close tab +
  // reopen the issue) — the one-key version of pressing x on every issue.
  // Starting is idempotent — a running run is returned untouched, so `s` never
  // toggles a run off. The controller walks the graph, dispatching each issue
  // as its blockers clear; the poll loop steps it. Stopping is a deliberate,
  // separate key: the poll steps ALL stored runs, so stop-all is the reliable
  // end to the auto-dispatch, and releasing the in-flight work is what makes
  // "stop" actually feel like it stopped.
  async function startRun() {
    const sel = selected();
    if (!sel || !props.runController) return;
    try {
      await props.runController.start(effortOf(sel.id));
      setRunVersion((v) => v + 1);
    } catch {
      // surfaced next poll — start failures are non-fatal
    }
  }
  async function stopRun() {
    if (!props.runController) return;
    try {
      await props.runController.stopAllAndRelease();
      setRunVersion((v) => v + 1);
    } catch {
      // surfaced next poll — stop failures are non-fatal
    }
  }

  // --- mouse support (prototype 08's behavior, applied to the real shell) ---
  // Click a row = select + focus the list. Wheel over the list = move the
  // cursor. Click the detail pane = focus detail. Double-click a row = dispatch
  // (the prototype's dispatch slot, wired to the real client now).
  function selectById(id: string) {
    const idx = issues().findIndex((i) => i.id === id);
    if (idx >= 0) setCursor(idx);
  }
  let lastClick: { id: string; at: number } | null = null;
  function onRowMouseDown(e: MouseEvent, id: string) {
    if (e.button !== MouseButton.LEFT) return;
    setFocus("list");
    selectById(id);
    const now = Date.now();
    if (lastClick && lastClick.id === id && now - lastClick.at < 400) {
      lastClick = null;
      void doDispatch();
    } else {
      lastClick = { id, at: now };
    }
  }
  function onListWheel(e: MouseEvent) {
    if (e.button === MouseButton.WHEEL_UP) move(-1);
    else if (e.button === MouseButton.WHEEL_DOWN) move(1);
  }
  function onDetailMouseDown(e: MouseEvent) {
    if (e.button === MouseButton.LEFT) setFocus("detail");
  }
  // Tree-view mouse (issue 15): click a row = select + focus the tree, double-
  // click = dispatch, wheel = move the cursor — the list pane's behavior
  // applied to the forest rows.
  function selectTreeById(id: string) {
    const idx = treeRows().findIndex((r) => r.issue.id === id);
    if (idx >= 0) setTreeCursor(idx);
  }
  let lastTreeClick: { id: string; at: number } | null = null;
  function onTreeRowMouseDown(e: MouseEvent, id: string) {
    if (e.button !== MouseButton.LEFT) return;
    setFocus("list");
    selectTreeById(id);
    const now = Date.now();
    if (lastTreeClick && lastTreeClick.id === id && now - lastTreeClick.at < 400) {
      lastTreeClick = null;
      void doDispatch();
    } else {
      lastTreeClick = { id, at: now };
    }
  }
  function onTreeWheel(e: MouseEvent) {
    if (e.button === MouseButton.WHEEL_UP) treeMove(-1);
    else if (e.button === MouseButton.WHEEL_DOWN) treeMove(1);
  }

  useKeyboard((key) => {
    switch (appKeyAction(key)) {
      case "quit":
        (props.onQuit ?? (() => renderer.destroy()))();
        break;
      case "focus":
        setFocus((f) => cycleFocus(f));
        break;
      case "down":
        if (view() === "tree") treeMove(1);
        else move(1);
        break;
      case "up":
        if (view() === "tree") treeMove(-1);
        else move(-1);
        break;
      case "dispatch":
        void doDispatch();
        break;
      case "release":
        void doRelease();
        break;
      case "run-start":
        void startRun();
        break;
      case "run-stop":
        void stopRun();
        break;
      case "toggle-view":
        toggleView();
        break;
      case "reload":
        void load();
        break;
    }
  });

  // Load the selected Issue's full body whenever the selection changes. Each
  // read is guarded by the requested id: a read that resolves after a newer one
  // was requested (fast cursor moves) is discarded so the detail pane can never
  // show a body that doesn't match the selected title.
  let loadedDetailId: string | null = null;
  createEffect(() => {
    const sel = selected();
    if (!sel || props.initialDetail || sel.id === loadedDetailId) return;
    loadedDetailId = sel.id;
    const wantedId = sel.id;
    setDetail(null);
    setDetailLoading(true);
    void props.provider
      .readIssue(wantedId)
      .then((d) => {
        if (selected()?.id === wantedId) setDetail(d);
      })
      .catch(() => {
        if (selected()?.id === wantedId) setDetail(null);
      })
      .finally(() => {
        if (selected()?.id === wantedId) setDetailLoading(false);
      });
  });

  // Widths. Both panes are definite — list 40%, detail 60% — so content can't
  // push the split around; flexGrow absorbs only a column of rounding slack.
  const listPaneW = () => Math.max(0, Math.floor(dims().width * 0.4));
  const detailPaneW = () => Math.max(0, Math.floor(dims().width * 0.6));
  const listInnerW = () => Math.max(0, listPaneW() - 4); // 2 border + 2 padding
  const detailInnerW = () => Math.max(0, detailPaneW() - 4);
  // The tree view spans the full width: both its lean tree pane and its detail
  // pane below use the whole column (issue 15).
  const treeInnerW = () => Math.max(0, dims().width - 4);
  const treeDetailInnerW = () => Math.max(0, dims().width - 4);
  // The detail pane's inner width — which split it sits in depends on the view.
  const detailInnerWFor = () => (view() === "tree" ? treeDetailInnerW() : detailInnerW());

  // Key for the detail pane's content. Includes the selection, whether the body
  // read has landed (L/P/E), the pane width (for header re-truncation), and the
  // dispatch/release feedback (so the pane remounts when either changes). A
  // keyed <Show> remounts when the key changes — OpenTUI 0.5.1 does not repaint
  // text or props in place, so the pane must remount when the read lands or the
  // loaded body would never appear (same workaround as the list-row selection
  // background and pulse).
  const detailKey = createMemo(() => {
    const s = selected();
    if (!s) return null;
    const d = detail();
    const loaded = d && d.id === s.id;
    const ds = dispatchState();
    const dispatchPart =
      ds.status === "idle" ? "I" : ds.status === "running" ? "R" : ds.status === "ok" ? `ok:${ds.paneId}` : "E";
    const rs = releaseState();
    const releasePart = rs.status === "idle" ? "I" : rs.status === "running" ? "R" : rs.status === "ok" ? `ok:${rs.tabClosed ? 1 : 0}` : "E";
    return `${s.id}|${loaded ? "L" : detailLoading() ? "P" : "E"}|${detailInnerWFor()}|${dispatchPart}|${releasePart}|${runVersion()}`;
  });

  const openCount = () => shown().filter((i) => i.status === "open").length;
  const yourTurn = () => shown().filter((i) => isHumanTurn(i, agentStatusOf(i))).length;

  // --- list row -----------------------------------------------------------
  // Selection is a full-row background; a keyed <Show> remounts the row when
  // selection/pulse/width change so the backgroundColor applies (function
  // accessors aren't applied reactively for this prop in OpenTUI 0.5.1).
  const IssueRow: Component<{ issue: Issue; selected: boolean; innerW: number; onMouseDown: (e: MouseEvent) => void }> = (p) => {
    const key = () => `${p.selected ? 1 : 0}|${pulse() ? 1 : 0}|${p.innerW}`;
    return (
      <Show when={key()} keyed>
        {() => {
          const issue = p.issue;
          const ic = iconFor(issue, resolvedFor(issue), agentStatusOf(issue));
          const human = ic.state === "human";
          const idStr = issueNum(issue.id);
          const tasksStr = issue.tasks ? `${issue.tasks.done}/${issue.tasks.total}` : "";
          const tasksDone = !!issue.tasks && issue.tasks.done >= issue.tasks.total;
          const ageStr = issue.updatedAt != null ? humanizeAge(issue.updatedAt, Date.now()) : "";
          const fixed =
            2 + idStr.length + 2 + (tasksStr ? tasksStr.length + 1 : 0) + (ageStr ? ageStr.length + 1 : 0);
          const budget = Math.max(0, p.innerW - fixed);
          return (
            <box
              flexDirection="row"
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={p.selected ? THEME.selBg : undefined}
              onMouseDown={p.onMouseDown}
            >
              <text
                fg={iconColor(ic.state, pulse())}
                flexShrink={0}
                attributes={human && pulse() ? TextAttributes.BOLD : 0}
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

  // --- detail pane content --------------------------------------------------
  // The verbose record for the selected issue, shared by the list view's
  // right-hand pane and the tree view's bottom pane (issue 15): title, label
  // chips, blocked-by/agent/tasks/age, the run status, the resolved launch
  // line, dispatch/release feedback, and the body. `innerW` is the pane's
  // inner width (the split differs between the two views). Rendered inside a
  // keyed <Show> (see detailKey) so the body paints when the read lands.
  const DetailContent: Component<{ innerW: number }> = ({ innerW }) => {
    const sel = selected();
    if (!sel) return null;
    const detailRec = detail();
    const loaded = detailRec && detailRec.id === sel.id;
    const body = loaded ? detailRec.body : null;
    const ic = iconFor(sel, resolvedFor(sel), agentStatusOf(sel));
    const headerBudget = Math.max(0, innerW - (2 + issueNum(sel.id).length + 2));
    const outcome = dispatch(sel);
    const dispatchable = outcome.kind === "implement" || outcome.kind === "wayfinder";
    const ds = dispatchState();
    const showDispatch = ds.status !== "idle" && ds.issueId === sel.id;
    const rs = releaseState();
    const showRelease = rs.status !== "idle" && rs.issueId === sel.id;
    return (
      <box flexDirection="column" flexGrow={1}>
        <box flexDirection="row">
          <text fg={iconColor(ic.state, pulse())} flexShrink={0} attributes={TextAttributes.BOLD}>
            {`${ic.glyph} `}
          </text>
          <text fg={THEME.accent.id} flexShrink={0}>{issueNum(sel.id)}</text>
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
            const live = agentStatusOf(sel);
            return `blocked by: ${sel.blockedBy.length ? sel.blockedBy.join(", ") : "—"}    agent: ${sel.assignee ?? "unclaimed"}${live ? `    live: ${live}` : ""}${sel.tasks ? `    tasks: ${sel.tasks.done}/${sel.tasks.total}` : ""}${sel.updatedAt != null ? `    ${humanizeAge(sel.updatedAt, Date.now())} ago` : ""}`;
          })()}
        </RoleText>
        <box flexDirection="row" paddingTop={1}>
          <RoleText role="meta">dispatch: </RoleText>
          <text fg={dispatchable ? THEME.state.done : THEME.state.human} attributes={TextAttributes.BOLD}>
            {dispatchable ? outcome.command : "(no auto-dispatch — human turn)"}
          </text>
        </box>
        {(() => {
          const run = props.runController?.load(effortOf(sel.id));
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
        })()}
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
        {loaded ? <RoleText role="body">{body}</RoleText> : <RoleText role="body">{detailLoading() ? " loading body…" : ""}</RoleText>}
      </box>
    );
  };

  // --- tree row ------------------------------------------------------------
  // The lean row the tree view paints (issue 15): tree connector · icon ·
  // #id · title · tasks · age, depth via paddingLeft, full-row selection bg.
  // `id` on the box lets the scrollbox's scrollChildIntoView find the row.
  const TreeRowC: Component<{ row: TreeRow; selected: boolean; innerW: number; onMouseDown: (e: MouseEvent) => void }> = (p) => {
    const key = () => `${p.selected ? 1 : 0}|${pulse() ? 1 : 0}|${p.innerW}`;
    return (
      <Show when={key()} keyed>
        {() => {
          const issue = p.row.issue;
          const ic = iconFor(issue, resolvedFor(issue), agentStatusOf(issue));
          const human = ic.state === "human";
          const idStr = issueNum(issue.id);
          const tasksStr = issue.tasks ? `${issue.tasks.done}/${issue.tasks.total}` : "";
          const tasksDone = !!issue.tasks && issue.tasks.done >= issue.tasks.total;
          const ageStr = issue.updatedAt != null ? humanizeAge(issue.updatedAt, Date.now()) : "";
          const fixed =
            2 + idStr.length + 2 + (tasksStr ? tasksStr.length + 1 : 0) + (ageStr ? ageStr.length + 1 : 0);
          const budget = Math.max(0, p.innerW - fixed - p.row.depth * 2);
          return (
            <box
              id={issue.id}
              flexDirection="row"
              paddingLeft={p.row.depth * 2 + 1}
              paddingRight={1}
              backgroundColor={p.selected ? THEME.selBg : undefined}
              onMouseDown={p.onMouseDown}
            >
              <text fg={THEME.border.idle} attributes={TextAttributes.BOLD} flexShrink={0}>{p.row.branch}</text>
              <text
                fg={iconColor(ic.state, pulse())}
                flexShrink={0}
                attributes={human && pulse() ? TextAttributes.BOLD : 0}
              >
                {`${ic.glyph} `}
              </text>
              <text fg={THEME.accent.id} flexShrink={0}>{idStr}</text>
              <text fg={p.selected ? THEME.text.title : THEME.text.body} flexGrow={1} flexShrink={1}>
                {`  ${trunc(issue.title, budget)}`}
              </text>
              <text fg={tasksDone ? THEME.state.done : THEME.state.blocked} flexShrink={0}>
                {tasksStr ? ` ${tasksStr}` : ""}
              </text>
              <text fg={THEME.text.dim} flexShrink={0}>{ageStr ? ` ${ageStr}` : ""}</text>
            </box>
          );
        }}
      </Show>
    );
  };

  // --- primary shell: list (40%) + detail (60%) -----------------------------
  const ListShell: Component = () => (
    <box flexDirection="row" flexGrow={1}>
      {/* list pane — definite 40%, flexShrink:0 so content can't push it */}
      <box
        flexDirection="column"
        width="40%"
        flexShrink={0}
        border={true}
        borderStyle="rounded"
        borderColor={focus() === "list" ? THEME.border.focused : THEME.border.idle}
        title=" Issues "
        titleColor={focus() === "list" ? THEME.border.focused : THEME.text.dim}
      >
        <scrollbox flexGrow={1} scrollY={true} onMouseScroll={onListWheel}>
          <For each={rows()}>
            {(row) => {
              switch (row.kind) {
                case "error":
                  return <text fg={THEME.state.blocked} paddingLeft={1}>{` error: ${row.message}`}</text>;
                case "empty":
                  return <text fg={THEME.text.dim} paddingLeft={1}> no issues found under .scratch/*/issues/</text>;
                case "group":
                  return (
                    <box flexDirection="row" paddingLeft={1} paddingTop={1}>
                      <text fg={THEME.accent.triage} attributes={TextAttributes.BOLD}>{`▸ ${row.root}`}</text>
                      <text fg={THEME.text.dim}>{`  ${row.count}`}</text>
                    </box>
                  );
                case "issue":
                  return (
                    <IssueRow
                      issue={row.issue}
                      selected={selected()?.id === row.issue.id}
                      innerW={listInnerW()}
                      onMouseDown={(e: MouseEvent) => onRowMouseDown(e, row.issue.id)}
                    />
                  );
              }
            }}
          </For>
        </scrollbox>
      </box>

      {/* detail pane — definite 60% */}
      <box
        flexDirection="column"
        width="60%"
        flexShrink={0}
        flexGrow={1}
        border={true}
        borderStyle="rounded"
        borderColor={focus() === "detail" ? THEME.border.focused : THEME.border.idle}
        title={selected() ? ` ${issueNum(selected()!.id)} ` : " Detail "}
        titleColor={focus() === "detail" ? THEME.border.focused : THEME.text.dim}
        onMouseDown={onDetailMouseDown}
      >
        <scrollbox flexGrow={1} scrollY={true} paddingLeft={1} paddingRight={1}>
          <Show when={detailKey()} keyed fallback={<text fg={THEME.text.dim}> select an issue…</text>}>
            {() => <DetailContent innerW={detailInnerW()} />}
          </Show>
        </scrollbox>
      </box>
    </box>
  );

  // --- secondary shell: lean tree (top) + detail pane (below) ---------------
  // The locked 07 run view (issue 15): a forward forest of the list-selected
  // issue's run-root, rendered two-pane — the lean tree scrolls (auto-scrolling
  // the cursor into view), and the detail pane below carries the selected
  // node's verbose record. No spatial graph — structure via connectors, detail
  // via the pane (issue 07's lock).
  const TreeShell: Component = () => (
    <box flexDirection="column" flexGrow={1}>
      {/* tree pane — lean: structure + node labels only */}
      <box
        flexDirection="column"
        flexGrow={1}
        border={true}
        borderStyle="rounded"
        borderColor={focus() === "list" ? THEME.border.focused : THEME.border.idle}
        title=" Dependencies "
        titleColor={focus() === "list" ? THEME.border.focused : THEME.text.dim}
      >
        <scrollbox ref={(el) => (treeScroll = el)} flexGrow={1} scrollY={true} onMouseScroll={onTreeWheel}>
          <For each={treeRows()}>
            {(row) => (
              <TreeRowC
                row={row}
                selected={selected()?.id === row.issue.id}
                innerW={treeInnerW()}
                onMouseDown={(e: MouseEvent) => onTreeRowMouseDown(e, row.issue.id)}
              />
            )}
          </For>
        </scrollbox>
      </box>

      {/* detail pane — the verbose selected-node record, below (~38%) */}
      <box
        flexDirection="column"
        height="38%"
        border={true}
        borderStyle="rounded"
        borderColor={focus() === "detail" ? THEME.border.focused : THEME.border.idle}
        title={selected() ? ` Detail · ${issueNum(selected()!.id)} ` : " Detail "}
        titleColor={focus() === "detail" ? THEME.border.focused : THEME.text.dim}
        onMouseDown={onDetailMouseDown}
      >
        <scrollbox flexGrow={1} scrollY={true} paddingLeft={1} paddingRight={1}>
          <Show when={detailKey()} keyed fallback={<text fg={THEME.text.dim}> select an issue…</text>}>
            {() => <DetailContent innerW={treeDetailInnerW()} />}
          </Show>
        </scrollbox>
      </box>
    </box>
  );

  return (
    <box flexDirection="column" flexGrow={1} live={true} backgroundColor={THEME.surface.bg} onMouseUp={() => copySelection(renderer)}>
      {/* header — flexShrink:0 keeps the row from collapsing when a below pane
          overflows; without it OpenTUI 0.5.1 lays the overflowing pane content
          over the header and the header disappears. */}
      <box flexGrow={0} flexShrink={0} flexDirection="row" paddingLeft={1} paddingRight={1} backgroundColor={THEME.surface.panel}>
        <RoleText role="h2">◆ herdr-beads</RoleText>
        {view() === "tree" ? (
          <>
            <RoleText role="meta">  dependency tree  </RoleText>
            <RoleText role="h2">{treeRoot()}</RoleText>
            <RoleText role="meta">  </RoleText>
          </>
        ) : (
          <RoleText role="meta">  issues  </RoleText>
        )}
        <text fg={THEME.text.title}>{shown().length}</text>
        <RoleText role="meta">  ·  </RoleText>
        <text fg={stateColor("frontier")}>{openCount()} open</text>
        <RoleText role="meta">  ·  </RoleText>
        <text fg={THEME.state.human} attributes={TextAttributes.BOLD}>{yourTurn()} your-turn</text>
        <RoleText role="meta" flexGrow={1}> </RoleText>
      </box>

      {/* two-pane body — the primary list+detail shell or the secondary
          dependency-tree shell (issue 15), switched by `t` */}
      <Show when={view() === "tree"} fallback={<ListShell />}>
        <TreeShell />
      </Show>

      {/* footer */}
      <box flexGrow={0} flexDirection="row" paddingLeft={1} paddingRight={1} backgroundColor={THEME.surface.panel}>
        <RoleText role="meta">
          {view() === "tree"
            ? "Tab pane · j/k move · Enter dispatch · x stop+reopen · s run · S stop+release · t list · r reload · q quit"
            : "Tab pane · j/k move · Enter dispatch · x stop+reopen · s run · S stop+release · t tree · r reload · q quit"}
        </RoleText>
        <RoleText role="meta" flexGrow={1}> </RoleText>
        <text fg={THEME.accent.id}>
          {selected() ? `${issueNum(selected()!.id)} · ${trunc(selected()!.title, 40)}` : ""}
        </text>
      </box>
    </box>
  );
};
