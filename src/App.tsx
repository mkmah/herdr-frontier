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
// One cross-view theme module (./theme.ts) drives the header, list, detail, and
// footer — change a token and the whole app re-themes. All presentation logic
// (grouping, list state, icon precedence, focus cycling) lives in ./logic.ts +
// ./display.ts so it is unit-testable. The Confirmable verbs, the gate, and the
// load/poll pipeline live in ./shell.ts (the ShellController — architecture
// review 2026-08, candidate 1); this file is the thin Solid render adapter over
// that seam: it owns every signal, forwards keys and mouse, and applies the
// outcome records the controller returns.
// ============================================================================

import { createSignal, createMemo, createEffect, For, Show, onMount, onCleanup, type Component } from "solid-js";
import { TextAttributes, type MouseEvent } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid";
import type { Issue, IssueDetail } from "./tracker/provider.js";
import type { AgentStatus } from "./herdr-client.js";
import type { ShellController, ShellOutcome } from "./shell.js";
import { appKeyAction } from "./shell.js";
import { modalKeyAction } from "./confirm.js";
import type { ConfirmButton, ConfirmDialog } from "./confirm.js";
import {
  attention,
  blockerResolved,
  buildRows,
  issueLabel,
  moveCursor,
  rowTitleBudget,
  sortIssues,
  trunc,
} from "./logic.js";
import {
  cycleFocus,
  humanizeAge,
  iconFor,
  trackClick,
  wheelDelta,
  MouseButton,
  type ClickRecord,
  type Focus,
} from "./display.js";
import { iconColor, markdownSyntaxStyle, THEME, stateColor, triageColor } from "./theme.js";
import { buildForest, flattenForest } from "./tree.js";
import { dispatch } from "./orchestrator.js";
import { copySelection } from "./selection.js";

/** The two top-level views: the primary list and the secondary dependency tree. */
export type AppView = "list" | "tree";

// The scrollbox that carries a pane's rows renders its content 2 columns
// narrower than the pane's border-padding math predicts (measured empirically
// at widths 50/58/60/70/100, in both the list and the tree rows — see the width
// comments below). A row's title budget is floored at 0, but a budget even one
// char too generous wraps the row to a second line, so both panes budget this
// inset. The detail pane is exact at −4 because its scrollbox declares its own
// 1+1 padding (see DetailPane), so only the row-carrying scrollboxes use this.
const ROW_SCROLLBOX_INSET = 6;

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
  /** The confirmation dialog already open on first render (test seam — paints
   *  the overlay over the two-pane shell, mirroring initialIssues/initialDetail);
   *  production starts with no dialog open. */
  initialModal?: ConfirmDialog;
  /** Called on q. Defaults to `renderer.destroy()` (restores the terminal); overridable for tests. */
  onQuit?: () => void;
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

/** The confirmation overlay's live state: the dialog to paint + which button
 *  is focused. Confirm is always pre-focused (the rulebook's focusedButton);
 *  the keyboard moves focus between the two ConfirmButtons, and Enter fires
 *  whichever is focused. */
type ModalState = { dialog: ConfirmDialog; focus: ConfirmButton };

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

// --- key handling (./shell.ts owns the action vocabulary — appKeyAction) -----

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
  // The confirmation overlay (confirmation-gate 05): null = no dialog; else the
  // dialog to paint plus which button is focused. Confirm is always pre-focused
  // (the rulebook's focusedButton); `initialModal` seeds it for the render-smoke
  // seam. State changes here never move selection or the pane focus — cancel
  // costs nothing.
  const [modal, setModal] = createSignal<ModalState | null>(
    props.initialModal ? { dialog: props.initialModal, focus: "confirm" } : null,
  );
  // Scrollbox refs — auto-scroll the cursor row into view: the list pane's on
  // cursor movement, the tree's on tree-cursor movement (issue 15 / 16).
  let listScroll: any = null;
  let treeScroll: any = null;

  async function load() {
    setLoaded(false);
    setError(null);
    const res = await props.shell.load();
    if (res.ok) {
      const fresh = sortIssues(res.issues);
      setIssues(fresh);
      setCursor(0);
      setTreeCursor(0);
    } else {
      setError(res.error);
    }
    setLoaded(true);
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

  // Background poll — the controller's tick runs the whole reconcile pipeline
  // on one fresh snapshot (claims → dead-dispatch → attention → run-step) and
  // returns the state delta to apply: a fresh issue list, the live agent-state
  // map (rows update live), and a run-status pulse. Silent: a failed tick (null)
  // changes nothing — the next tick retries; never resets selection or flashes
  // a loading state (that's what `r` / load() are for).
  async function poll() {
    const res = await props.shell.tick();
    if (!res) return;
    setIssues(sortIssues(res.issues));
    setAgentStates(res.agentStates);
    setRunVersion((v) => v + 1);
  }
  onMount(() => {
    const id = setInterval(poll, 2000);
    onCleanup(() => clearInterval(id));
  });

  const rows = createMemo(() => buildRows({ issues: issues(), loaded: loaded(), error: error() }));
  const listSelected = () => issues()[cursor()];
  // The tree view's pool: the issues of the list-selected issue's effort
  // directory (the run-root's graph lives in `.scratch/<effort>/issues/`;
  // logic.ts reserves "run-root" for the root *issue*, so this is the effort
  // dir, not the root). Rooted on the list cursor, so toggling in and out of
  // the tree never chases the tree cursor around.
  const treeEffort = createMemo(() => listSelected()?.effort ?? "");
  const treePool = createMemo(() => issues().filter((i) => i.effort === treeEffort()));
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
  // Auto-scroll the tree cursor into view (issue 15). Reads the row *and* its
  // depth so a poll that keeps the selected id but shifts its row re-scrolls.
  createEffect(() => {
    const row = treeRows()[treeCursor()];
    const depth = row?.depth;
    if (row && treeScroll) {
      try {
        treeScroll.scrollChildIntoView(row.issue.id);
      } catch {
        // best-effort — a scrollbox quirk must not break cursor movement
      }
    }
  });
  // Auto-scroll the list cursor into view (issue 16) — the list pane's rows
  // can outgrow the pane, so the cursor follows selection, wheel, and mouse.
  createEffect(() => {
    const row = rows()[cursor()];
    if (row && row.kind === "issue" && listScroll) {
      try {
        listScroll.scrollChildIntoView(row.issue.id);
      } catch {
        // best-effort — a scrollbox quirk must not break cursor movement
      }
    }
  });

  // --- the four Confirmable verbs, gated through the shell ------------------
  // `Enter`/double-click = dispatch, `x` = release, `s`/`S` = run
  // start/stop. Every verb enters through the shell's `request` — the
  // confirmation gate's single entry, so keyboard and mouse (both views) ride
  // the same path — and runs its body through the shell's `confirm`. The shell
  // returns outcome records; this component only paints their signals.

  /** Open the gate's dialog — Confirm is always pre-focused (the rulebook
   *  locks it; there is no other first-focus). */
  function openModal(dialog: ConfirmDialog) {
    setModal({ dialog, focus: dialog.focusedButton });
  }

  // --- manual dispatch -----------------------------------------------------
  // `Enter` (or double-click) dispatches the selected Issue: claim → resolve
  // `{id}` → `agent start` from the profile. The coordinator (behind the shell)
  // owns the shared claim mutex; we only render its outcome and reflect the
  // claim in the list so the row flips to "running" without a full reload.
  function doDispatch() {
    const sel = selected();
    if (!sel) return;
    const gate = props.shell.request("dispatch", sel);
    if (gate.kind === "dialog") { openModal(gate.dialog); return; }
    void runDispatch(sel);
  }
  async function runDispatch(sel: Issue) {
    setDispatchState({ status: "running", issueId: sel.id });
    try {
      const outcome = await props.shell.confirm("dispatch", sel);
      if (outcome.verb !== "dispatch") return;
      const r = outcome.result;
      if (r.ok) {
        setDispatchState({ status: "ok", issueId: r.issue.id, paneId: r.paneId, command: r.command });
        // The coordinator has already atomically claimed (`Status: claimed`) via
        // the provider before agent start; the background poll reflects it in
        // the list row. Resolution (`→ resolved`) is the implement skill's, later.
      } else {
        const msg =
          r.reason === "already-dispatched"
            ? "already dispatched this session"
            : r.reason === "already-claimed"
              ? "already claimed by another dispatcher"
              : r.reason === "claim-busy"
                ? "claim lock busy — try again"
                : "human turn — not auto-dispatched";
        setDispatchState({ status: "error", issueId: r.issue.id, message: msg });
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
  function doRelease() {
    const sel = selected();
    if (!sel) return;
    const gate = props.shell.request("release", sel);
    if (gate.kind === "dialog") { openModal(gate.dialog); return; }
    void runRelease(sel);
  }
  async function runRelease(sel: Issue) {
    setReleaseState({ status: "running", issueId: sel.id });
    try {
      const outcome = await props.shell.confirm("release", sel);
      if (outcome.verb !== "release") return;
      const r = outcome.result;
      if (r.ok) {
        setReleaseState({ status: "ok", issueId: r.issue.id, tabClosed: r.tabClosed });
        setIssues((prev) => prev.map((i) => (i.id === r.issue.id ? { ...i, status: "open" } : i)));
      } else {
        setReleaseState({ status: "error", issueId: r.issue.id, message: r.message });
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
  // as its blockers clear; the poll loop steps it.
  function startRun() {
    const sel = selected();
    if (!sel) return;
    const gate = props.shell.request("run-start", sel);
    if (gate.kind === "dialog") { openModal(gate.dialog); return; }
    void runStart(sel);
  }
  async function runStart(sel: Issue) {
    try {
      await props.shell.confirm("run-start", sel);
      setRunVersion((v) => v + 1);
    } catch {
      // surfaced next poll — start failures are non-fatal
    }
  }
  function stopRun() {
    const gate = props.shell.request("run-stop");
    if (gate.kind === "dialog") { openModal(gate.dialog); return; }
    void runStop();
  }
  async function runStop() {
    try {
      await props.shell.confirm("run-stop");
      setRunVersion((v) => v + 1);
    } catch {
      // surfaced next poll — stop failures are non-fatal
    }
  }

  /** Confirm the open dialog: run the confirmed verb's body on the current
   *  selection. The ~2s poll has kept reconciling live state behind the dialog,
   *  so a state change under it just makes the confirmed action a no-op,
   *  surfaced through the existing detail-pane feedback (never a second
   *  dialog). */
  function confirmModal() {
    const m = modal();
    if (!m) return;
    setModal(null);
    switch (m.dialog.trigger) {
      case "dispatch": {
        const sel = selected();
        if (sel) void runDispatch(sel);
        break;
      }
      case "release": {
        const sel = selected();
        if (sel) void runRelease(sel);
        break;
      }
      case "run-start": {
        const sel = selected();
        if (sel) void runStart(sel);
        break;
      }
      case "run-stop":
        void runStop();
        break;
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
  let lastClick: ClickRecord | null = null;
  function onRowMouseDown(e: MouseEvent, id: string) {
    if (e.button !== MouseButton.LEFT) return;
    setFocus("list");
    selectById(id);
    const click = trackClick(lastClick, id, Date.now());
    lastClick = click.next;
    if (click.double) void doDispatch();
  }
  function onListWheel(e: MouseEvent) {
    move(wheelDelta(e.button));
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
  let lastTreeClick: ClickRecord | null = null;
  function onTreeRowMouseDown(e: MouseEvent, id: string) {
    if (e.button !== MouseButton.LEFT) return;
    setFocus("list");
    selectTreeById(id);
    const click = trackClick(lastTreeClick, id, Date.now());
    lastTreeClick = click.next;
    if (click.double) void doDispatch();
  }
  function onTreeWheel(e: MouseEvent) {
    treeMove(wheelDelta(e.button));
  }

  useKeyboard((key) => {
    const m = modal();
    if (m) {
      // While a dialog is open every key routes here and only here — the dead
      // key swallow: any key the modal doesn't map does nothing, so no cursor
      // motion, view toggle, reload, quit, or Confirmable action can fire
      // behind the overlay. Only the move/confirm/cancel keys reach the shell.
      switch (modalKeyAction(key)) {
        case "left":
          setModal({ dialog: m.dialog, focus: "cancel" });
          break;
        case "right":
          setModal({ dialog: m.dialog, focus: "confirm" });
          break;
        case "confirm":
          // Enter activates the *focused* button — Confirm pre-focused, but a
          // focused Cancel makes Enter cancel (and Esc/q always cancel).
          if (m.focus === "cancel") setModal(null);
          else confirmModal();
          break;
        case "cancel":
          // Esc/q — cancel, never quit: appKeyAction is unreachable here.
          setModal(null);
          break;
        case null:
          break;
      }
      return;
    }
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
    void props.shell
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
  // The list rows sit in a scrollbox whose content is `ROW_SCROLLBOX_INSET`
  // columns narrower than the pane inner (measured empirically — same as the
  // tree rows, see treeInnerW below), so the list budgets 2 fewer than
  // "pane − border − padding" would suggest. A row budget that's even one char
  // too generous wraps the row to a second line.
  const listInnerW = () => Math.max(0, listPaneW() - ROW_SCROLLBOX_INSET);
  const detailInnerW = () => Math.max(0, detailPaneW() - 4);
  // The tree view spans the full width: both its lean tree pane and its detail
  // pane below use the whole column (issue 15). The tree rows sit in a
  // scrollbox whose content is `ROW_SCROLLBOX_INSET` columns narrower than the
  // pane inner — measured, like the list: at width 58 a 40-char child title is
  // the widest that fits on one line, exactly what `dims − 6` budgets.
  const treeInnerW = () => Math.max(0, dims().width - ROW_SCROLLBOX_INSET);
  const treeDetailInnerW = () => Math.max(0, dims().width - 4);
  // The detail pane's inner width — which split it sits in depends on the view.
  const detailInnerWFor = () => (view() === "tree" ? treeDetailInnerW() : detailInnerW());

  // Key for the detail pane's content. Includes the selection, whether the body
  // read has landed (L/P/E), the pane width (for header re-truncation), and the
  // dispatch/release feedback (so the pane remounts when either changes). The
  // run-controller pulse is deliberately NOT here — it bumps every ~2s poll, so
  // including it would remount the whole pane (markdown body included) on a
  // timer and the markdown visibly flickers; the run-status line remounts on
  // its own key instead (see DetailContent).
  // OpenTUI 0.5.1 does not repaint text or props in place, so the pane must
  // remount when the read lands or the loaded body would never appear (same
  // workaround as the list-row selection background and pulse). NOTE: the keyed
  // <Show>'s children must take the key as an argument (see DetailPane) — a
  // zero-arg arrow makes Solid return the same fn reference on every key change,
  // so the pane silently never remounts.
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
    return `${s.id}|${loaded ? "L" : detailLoading() ? "P" : "E"}|${detailInnerWFor()}|${dispatchPart}|${releasePart}`;
  });

  // The confirmation overlay's keyed <Show> key — includes which dialog, the
  // focused button, and the dimensions, so every focus move / open / resize
  // remounts the overlay (OpenTUI 0.5.1 doesn't repaint in place — the shell's
  // established workaround, same as the detail pane and row selection).
  const modalKey = createMemo(() => {
    const m = modal();
    return m ? `${m.dialog.trigger}|${m.focus}|${dims().width}x${dims().height}` : null;
  });

  const openCount = () => shown().filter((i) => i.status === "open").length;
  const yourTurn = () => shown().filter((i) => attention(i, agentStatusOf(i)) !== null).length;

  // --- issue row ------------------------------------------------------------
  // The lean row both views paint — the list pane's `#id · title · tasks ·
  // age` row, and (issue 15) the tree pane's version of the same row with a
  // tree connector and depth. Selection is a full-row background; a keyed
  // <Show> remounts the row when selection/pulse/width change so the
  // backgroundColor applies (function accessors aren't applied reactively for
  // this prop in OpenTUI 0.5.1). `depth`/`branch`/`rowId` are the tree's
  // additions: depth via paddingLeft, a branch connector, and `id` on the box
  // so the scrollboxes' scrollChildIntoView can find the row (the list pane
  // passes rowId too, for its cursor auto-scroll).
  const IssueRow: Component<{
    issue: Issue;
    selected: boolean;
    innerW: number;
    onMouseDown: (e: MouseEvent) => void;
    depth?: number;
    branch?: string;
    rowId?: string;
  }> = (p) => {
    const key = () => `${p.selected ? 1 : 0}|${pulse() ? 1 : 0}|${p.innerW}|${p.depth ?? 0}`;
    return (
      <Show when={key()} keyed>
        {() => {
          const issue = p.issue;
          const depth = p.depth ?? 0;
          const ic = iconFor(issue, resolvedFor(issue), agentStatusOf(issue));
          const human = ic.state === "human";
          const idStr = issueLabel(issue);
          const tasksStr = issue.tasks ? `${issue.tasks.done}/${issue.tasks.total}` : "";
          const tasksDone = !!issue.tasks && issue.tasks.done >= issue.tasks.total;
          const ageStr = issue.updatedAt != null ? humanizeAge(issue.updatedAt, Date.now()) : "";
          // Reserve every non-collapsing segment (`#id`, tasks, age, the tree's
          // branch connector and depth padding) at full width; only the title
          // flexes into what remains, floored at 0 so a narrow pane truncates
          // rather than wrap the row to a second line (issue 16).
          const budget = rowTitleBudget({
            innerW: p.innerW,
            branchLen: p.branch ? p.branch.length : 0,
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
              {p.branch ? (
                <text fg={THEME.border.idle} attributes={TextAttributes.BOLD} flexShrink={0}>{p.branch}</text>
              ) : null}
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
  // line, dispatch/release feedback, and the body — the issue's whole document
  // rendered through OpenTUI's <markdown> element under the header rows.
  // `innerW` is the pane's inner width (the split differs between the two
  // views). Rendered inside a keyed <Show> (see detailKey) so the body paints
  // when the read lands.
  const DetailContent: Component<{ innerW: number }> = ({ innerW }) => {
    const sel = selected();
    if (!sel) return null;
    const detailRec = detail();
    const loaded = detailRec && detailRec.id === sel.id;
    const ic = iconFor(sel, resolvedFor(sel), agentStatusOf(sel));
    const headerBudget = Math.max(0, innerW - (2 + issueLabel(sel).length + 2));
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
        {/* The run-status line remounts on its own key — the ~2s poll bumps
            runVersion every tick, and remounting just this line keeps the
            counts fresh without recreating the whole pane (which made the
            markdown body below flicker on a timer). */}
        <Show when={`run#${runVersion()}`} keyed>
          {(_runKey: string) => {
            const run = props.shell.runFor(sel.effort);
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
          <RoleText role="body">{detailLoading() ? " loading body…" : ""}</RoleText>
        )}
      </box>
    );
  };

  // --- detail pane container -----------------------------------------------
  // The bordered, titled scrollbox the DetailContent lives in — shared by the
  // list view's right-hand pane and the tree view's bottom pane (issue 15).
  // `width`/`height` distinguish the two layouts (60% column vs 38% below).
  const DetailPane: Component<{
    innerW: number;
    title: string;
    width?: `${number}%`;
    height?: `${number}%`;
    flexGrow?: number;
    flexShrink?: number;
  }> = (p) => (
    <box
      flexDirection="column"
      width={p.width}
      height={p.height}
      flexGrow={p.flexGrow}
      flexShrink={p.flexShrink}
      border={true}
      borderStyle="rounded"
      borderColor={focus() === "detail" ? THEME.border.focused : THEME.border.idle}
      title={p.title}
      titleColor={focus() === "detail" ? THEME.border.focused : THEME.text.dim}
      onMouseDown={onDetailMouseDown}
    >
      <scrollbox flexGrow={1} scrollY={true} paddingLeft={1} paddingRight={1}>
        <Show when={detailKey()} keyed fallback={<text fg={THEME.text.dim}> select an issue…</text>}>
          {(_k: string) => <DetailContent innerW={p.innerW} />}
        </Show>
      </scrollbox>
    </box>
  );

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
        <scrollbox ref={(el) => (listScroll = el)} flexGrow={1} scrollY={true} onMouseScroll={onListWheel}>
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
                      rowId={row.issue.id}
                      onMouseDown={(e: MouseEvent) => onRowMouseDown(e, row.issue.id)}
                    />
                  );
              }
            }}
          </For>
        </scrollbox>
      </box>

      {/* detail pane — definite 60% */}
      <DetailPane
        innerW={detailInnerW()}
        title={selected() ? ` ${issueLabel(selected()!)} ` : " Detail "}
        width="60%"
        flexGrow={1}
        flexShrink={0}
      />
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
              <IssueRow
                issue={row.issue}
                selected={selected()?.id === row.issue.id}
                innerW={treeInnerW()}
                depth={row.depth}
                branch={row.branch}
                rowId={row.issue.id}
                onMouseDown={(e: MouseEvent) => onTreeRowMouseDown(e, row.issue.id)}
              />
            )}
          </For>
        </scrollbox>
      </box>

      {/* detail pane — the verbose selected-node record, below (~38%) */}
      <DetailPane
        innerW={treeDetailInnerW()}
        title={selected() ? ` Detail · ${issueLabel(selected()!)} ` : " Detail "}
        height="38%"
      />
    </box>
  );

  // --- confirmation overlay (confirmation-gate 05) --------------------------
  // The centered modal painted over the whole shell while a dialog is open.
  // The dim cover is absolute + zIndex 10 and spans the full screen, so it
  // layers above both panes and the footer and nothing under it can take a
  // click; its mouse handlers swallow (a click on the dim layer does nothing).
  // Inside, a bordered panel carries the rulebook's shape — title, context
  // line, body, and the `[ Cancel  Confirm ]` row — with the focused button
  // marked (color + a `▶` caret, so the one-shot renderer can see it too).
  const ConfirmOverlay: Component<{
    dialog: ConfirmDialog;
    focus: ConfirmButton;
    onCancel: () => void;
    onConfirm: () => void;
  }> = ({ dialog: d, focus, onCancel, onConfirm }) => {
    const swallow = (e: MouseEvent) => e.stopPropagation();
    // The modal width caps sentence-length bodies to a couple of wrapped lines
    // inside the fixed-width panel; the panel stays clear of the shell's edges.
    const modalW = () => Math.max(40, Math.min(72, dims().width - 8));
    const buttons: ConfirmButton[] = ["cancel", "confirm"];
    return (
      <box
        position="absolute"
        top={0}
        left={0}
        width="100%"
        height="100%"
        zIndex={10}
        alignItems="center"
        justifyContent="center"
        backgroundColor={THEME.surface.dim}
        onMouseDown={swallow}
        onMouseUp={swallow}
      >
        <box
          flexDirection="column"
          width={modalW()}
          backgroundColor={THEME.surface.panel}
          border={true}
          borderStyle="rounded"
          borderColor={THEME.border.focused}
          paddingLeft={3}
          paddingRight={3}
          paddingTop={1}
          paddingBottom={1}
        >
          <RoleText role="h1">{d.title}</RoleText>
          <RoleText role="meta">{d.context}</RoleText>
          <RoleText role="body">{d.body}</RoleText>
          <box flexDirection="row" justifyContent="center" paddingTop={1}>
            <For each={buttons}>
              {(which) => {
                const focused = focus === which;
                const label = which === "cancel" ? d.cancelLabel : d.confirmLabel;
                return (
                  <box
                    flexDirection="row"
                    paddingLeft={1}
                    paddingRight={1}
                    marginLeft={1}
                    marginRight={1}
                    backgroundColor={focused ? THEME.selBg : undefined}
                    onMouseDown={(e: MouseEvent) => {
                      if (e.button !== MouseButton.LEFT) return;
                      e.stopPropagation();
                      if (which === "cancel") onCancel();
                      else onConfirm();
                    }}
                  >
                    <text
                      fg={focused ? THEME.text.title : THEME.text.dim}
                      attributes={focused ? TextAttributes.BOLD : 0}
                    >
                      {focused ? `▶ ${label}` : `[ ${label} ]`}
                    </text>
                  </box>
                );
              }}
            </For>
          </box>
        </box>
      </box>
    );
  };

  return (
    <box flexDirection="column" flexGrow={1} live={true} backgroundColor={THEME.surface.bg} onMouseUp={() => copySelection(renderer)}>
      {/* header — flexShrink:0 keeps the row from collapsing when a below pane
          overflows; without it OpenTUI 0.5.1 lays the overflowing pane content
          over the header and the header disappears. */}
      <box flexGrow={0} flexShrink={0} flexDirection="row" paddingLeft={1} paddingRight={1} backgroundColor={THEME.surface.panel}>
        <RoleText role="h2">◆ herdr-frontier</RoleText>
        {view() === "tree" ? (
          <>
            <RoleText role="meta">  dependency tree  </RoleText>
            <RoleText role="h2">{treeEffort()}</RoleText>
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
          {selected() ? `${issueLabel(selected()!)} · ${trunc(selected()!.title, 40)}` : ""}
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
          const m = modal()!;
          return (
            <ConfirmOverlay
              dialog={m.dialog}
              focus={m.focus}
              onCancel={() => setModal(null)}
              onConfirm={confirmModal}
            />
          );
        }}
      </Show>
    </box>
  );
};
