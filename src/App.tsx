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
import {
  blockerResolved,
  buildRows,
  issueNum,
  moveCursor,
  sortIssues,
  trunc,
} from "./logic.js";
import { cycleFocus, humanizeAge, iconFor, isHumanTurn, type Focus } from "./display.js";
import { iconColor, THEME, stateColor, triageColor } from "./theme.js";
import { dispatch } from "./orchestrator.js";
import type { DispatchCoordinator } from "./dispatch.js";

export interface AppProps {
  provider: TrackerProvider;
  /** Pre-loaded issues render synchronously (test seam); production omits it. */
  initialIssues?: Issue[];
  /** Pre-loaded detail for the first selection (test seam); production omits it. */
  initialDetail?: IssueDetail;
  /** Called on q/Esc. Defaults to `renderer.destroy()` (restores the terminal); overridable for tests. */
  onQuit?: () => void;
  /** Manual single-issue dispatch (issue 12). Production builds one in index.tsx. */
  dispatchCoordinator?: DispatchCoordinator;
}

/** The detail pane's dispatch feedback, scoped to the issue it dispatched. */
type DispatchUi =
  | { status: "idle" }
  | { status: "running"; issueId: string }
  | { status: "ok"; issueId: string; paneId: string; command: string }
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
  const [tick, setTick] = createSignal(0); // attention pulse

  async function load() {
    setLoaded(false);
    setError(null);
    try {
      setIssues(sortIssues(await props.provider.listIssues()));
      setCursor(0);
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

  const rows = createMemo(() => buildRows({ issues: issues(), loaded: loaded(), error: error() }));
  const selected = () => issues()[cursor()];
  const pulse = () => tick() === 1;

  // A blocker id ("10") resolves against the loaded issue set, scoped to the
  // referencing issue's effort so `"05"` in two efforts can't cross-match.
  const resolvedFor = (issue: Issue) => (id: string) => blockerResolved(id, issue, issues());

  function move(dir: number) {
    setCursor((c) => moveCursor(c, dir, issues().length));
  }

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
        setIssues((prev) => prev.map((i) => (i.id === sel.id ? { ...i, status: "claimed" } : i)));
      } else {
        const msg =
          r.reason === "already-dispatched"
            ? "already dispatched this session"
            : r.reason === "already-claimed"
              ? "already claimed by another dispatcher"
              : "human turn — not auto-dispatched";
        setDispatchState({ status: "error", issueId: sel.id, message: msg });
      }
    } catch (e) {
      setDispatchState({ status: "error", issueId: sel.id, message: e instanceof Error ? e.message : String(e) });
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

  useKeyboard((key) => {
    if (key.name === "q" || key.name === "escape") (props.onQuit ?? (() => renderer.destroy()))();
    else if (key.name === "tab") setFocus((f) => cycleFocus(f));
    else if (key.name === "j" || key.name === "down") move(1);
    else if (key.name === "k" || key.name === "up") move(-1);
    else if (key.name === "return") void doDispatch();
    else if (key.name === "r") void load();
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

  // Key for the detail pane's content. Includes the selection, whether the body
  // read has landed (L/P/E), the pane width (for header re-truncation), and the
  // dispatch state (so the pane remounts when dispatch feedback changes). A keyed
  // <Show> remounts when the key changes — OpenTUI 0.5.1 does not repaint text
  // or props in place, so the pane must remount when the read lands or the
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
    return `${s.id}|${loaded ? "L" : detailLoading() ? "P" : "E"}|${detailInnerW()}|${dispatchPart}`;
  });

  const openCount = () => issues().filter((i) => i.status === "open").length;
  const yourTurn = () => issues().filter(isHumanTurn).length;

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
          const ic = iconFor(issue, resolvedFor(issue));
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

  return (
    <box flexDirection="column" flexGrow={1} live={true} backgroundColor={THEME.surface.bg}>
      {/* header — flexShrink:0 keeps the row from collapsing when a below pane
          overflows; without it OpenTUI 0.5.1 lays the overflowing pane content
          over the header and the header disappears. */}
      <box flexGrow={0} flexShrink={0} flexDirection="row" paddingLeft={1} paddingRight={1} backgroundColor={THEME.surface.panel}>
        <RoleText role="h2">◆ herdr-beads</RoleText>
        <RoleText role="meta">  issues  </RoleText>
        <text fg={THEME.text.title}>{issues().length}</text>
        <RoleText role="meta">  ·  </RoleText>
        <text fg={stateColor("frontier")}>{openCount()} open</text>
        <RoleText role="meta">  ·  </RoleText>
        <text fg={THEME.state.human} attributes={TextAttributes.BOLD}>{yourTurn()} your-turn</text>
        <RoleText role="meta" flexGrow={1}> </RoleText>
      </box>

      {/* two-pane body */}
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
              {() => {
                const sel = selected();
                if (!sel) return null;
                const detailRec = detail();
                const loaded = detailRec && detailRec.id === sel.id;
                const body = loaded ? detailRec.body : null;
                const ic = iconFor(sel, resolvedFor(sel));
                const headerBudget = Math.max(0, detailInnerW() - (2 + issueNum(sel.id).length + 2));
                const outcome = dispatch(sel);
                const dispatchable = outcome.kind === "implement" || outcome.kind === "wayfinder";
                const ds = dispatchState();
                const showDispatch = ds.status !== "idle" && ds.issueId === sel.id;
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
                      {`blocked by: ${sel.blockedBy.length ? sel.blockedBy.join(", ") : "—"}    agent: ${sel.assignee ?? "unclaimed"}${sel.tasks ? `    tasks: ${sel.tasks.done}/${sel.tasks.total}` : ""}${sel.updatedAt != null ? `    ${humanizeAge(sel.updatedAt, Date.now())} ago` : ""}`}
                    </RoleText>
                    <box flexDirection="row" paddingTop={1}>
                      <RoleText role="meta">dispatch: </RoleText>
                      <text
                        fg={dispatchable ? THEME.state.done : THEME.state.human}
                        attributes={TextAttributes.BOLD}
                      >
                        {dispatchable ? outcome.command : "(no auto-dispatch — human turn)"}
                      </text>
                    </box>
                    <text fg={THEME.text.dimmer}>{""}</text>
                    {showDispatch ? (
                      <text
                        fg={
                          ds.status === "ok"
                            ? THEME.state.done
                            : ds.status === "error"
                              ? THEME.state.blocked
                              : THEME.state.running
                        }
                        attributes={TextAttributes.BOLD}
                      >
                        {ds.status === "ok"
                          ? `↳ dispatched to pane ${ds.paneId}`
                          : ds.status === "error"
                            ? `✗ ${ds.message}`
                            : "⟳ dispatching…"}
                      </text>
                    ) : null}
                    {loaded ? (
                      <RoleText role="body">{body}</RoleText>
                    ) : (
                      <RoleText role="body">{detailLoading() ? " loading body…" : ""}</RoleText>
                    )}
                  </box>
                );
              }}
            </Show>
          </scrollbox>
        </box>
      </box>

      {/* footer */}
      <box flexGrow={0} flexDirection="row" paddingLeft={1} paddingRight={1} backgroundColor={THEME.surface.panel}>
        <RoleText role="meta">Tab pane · j/k move · Enter dispatch · r reload · q quit</RoleText>
        <RoleText role="meta" flexGrow={1}> </RoleText>
        <text fg={THEME.accent.id}>
          {selected() ? `${issueNum(selected()!.id)} · ${trunc(selected()!.title, 40)}` : ""}
        </text>
      </box>
    </box>
  );
};
