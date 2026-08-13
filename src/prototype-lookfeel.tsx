// ============================================================================
// PROTOTYPE — THROWAWAY. Not production, not the real plugin.
// Ticket 08: look & feel — the three things 06 left open:
//   1. MOUSE behavior   — click-to-focus/select, wheel-scroll, dbl-click-launch
//   2. ctrl+a handoff   — prependInputHandler reserves herdr's prefix (the
//                         actual intercept + visual handoff, per 01/02)
//   3. CROSS-VIEW THEME — one semantic theme object (palette + type roles)
//                         drives header, list, detail, footer — the 06 list
//                         palette is the reference, now lifted to a module.
//
// Run:   bun run src/prototype-lookfeel.tsx   (or: bun run prototype:look)
// Keys:  j/k move · Tab swap pane · Enter launch · r cycle run-root · q/Esc quit
// Mouse: click = select + focus · double-click = launch · wheel = move cursor
//        press ctrl+a → claimed for herdr (flashes the prefix chip)
// ============================================================================

import { createSignal, For, Show, createEffect, onMount, onCleanup } from "solid-js";
import { TextAttributes, MouseButton } from "@opentui/core";
import type { MouseEvent } from "@opentui/core";
import { render, useKeyboard, useTerminalDimensions, useRenderer } from "@opentui/solid";

// ---------------------------------------------------------------------------
// Domain + mock data (copied from prototype-tree.tsx — throwaway)
// ---------------------------------------------------------------------------

type AgentState = "idle" | "working" | "blocked" | "done";
type Triage = "ready-for-agent" | "ready-for-human" | "needs-info" | "needs-triage" | "wontfix";
type WfType = "map" | "research" | "grilling" | "prototype" | "task";

interface Ticket {
  id: string; title: string; runRoot: string; triage: Triage; wf?: WfType;
  status: "open" | "resolved"; blockedBy: string[]; agent: AgentState;
  body: string; tasks?: { done: number; total: number }; ago: string;
}

const TICKETS: Ticket[] = [
  { id: "01", title: "herdr plugin capabilities", runRoot: "herdr-beads map", triage: "ready-for-agent", wf: "research", status: "resolved", blockedBy: [], agent: "done", ago: "3d", body: "Plugins are out-of-process; the TUI is surfaced via a [[panes]] entry. Agent state comes from poll (~2s) + push events over the socket." },
  { id: "02", title: "OpenTUI/Solid capabilities", runRoot: "herdr-beads map", triage: "ready-for-agent", wf: "research", status: "resolved", blockedBy: [], agent: "done", ago: "3d", body: "Full keyboard + mouse, Yoga flexbox intrinsics, Solid signals for live updates. Embedding is viable via split-footer." },
  { id: "03", title: "tracker-provider surface", runRoot: "herdr-beads map", triage: "ready-for-agent", wf: "research", status: "resolved", blockedBy: [], agent: "done", ago: "3d", body: "Verb x tracker matrix. query-frontier is a client-side compound on every tracker, not a provider verb." },
  { id: "05", title: "tracker-provider interface", runRoot: "herdr-beads map", triage: "ready-for-agent", wf: "grilling", status: "resolved", blockedBy: ["03"], agent: "done", tasks: { done: 5, total: 5 }, ago: "2d", body: "One async TrackerProvider, 7 verbs, one adapter per tracker. Locked in ADR-0001." },
  { id: "06", title: "Prototype: core layout & navigation", runRoot: "herdr-beads map", triage: "ready-for-human", wf: "prototype", status: "open", blockedBy: [], agent: "idle", tasks: { done: 2, total: 4 }, ago: "5h", body: "Two-pane list + detail; inline pulsing attention via a user icon. LOCKED after five rounds." },
  { id: "07", title: "Prototype: run-graph view", runRoot: "herdr-beads map", triage: "needs-info", wf: "prototype", status: "open", blockedBy: ["06"], agent: "idle", tasks: { done: 0, total: 3 }, ago: "4h", body: "A detail-rich dependency tree. Blocked on 06 while it reframed the question." },
  { id: "08", title: "Prototype: look & feel + mouse", runRoot: "herdr-beads map", triage: "ready-for-agent", wf: "prototype", status: "open", blockedBy: [], agent: "idle", tasks: { done: 0, total: 3 }, ago: "4h", body: "Mouse behavior, ctrl+a reconciliation with herdr, and a cross-view theme. (This view.)" },
  { id: "09", title: "Build spec + plugin manifest", runRoot: "herdr-beads map", triage: "ready-for-agent", wf: "task", status: "open", blockedBy: ["05", "06", "08"], agent: "idle", tasks: { done: 0, total: 8 }, ago: "4h", body: "Turn the locked prototype decisions into the build spec and herdr-plugin.toml." },
  { id: "10", title: "Orchestrator run-controller", runRoot: "herdr-beads map", triage: "ready-for-agent", wf: "task", status: "open", blockedBy: ["05"], agent: "idle", tasks: { done: 0, total: 6 }, ago: "3h", body: "Walks the dependency graph, polling agent state ~2s, spawning each issue as blockers clear." },
  { id: "21", title: "Auth provider selection", runRoot: "auth-spec", triage: "ready-for-agent", wf: "research", status: "resolved", blockedBy: [], agent: "done", ago: "1w", body: "Picked OIDC via provider X. Resolved." },
  { id: "22", title: "Token refresh w/ boundary scheduling", runRoot: "auth-spec", triage: "ready-for-agent", status: "open", blockedBy: [], agent: "working", tasks: { done: 2, total: 3 }, ago: "2h", body: "Silent refresh + boundary scheduling. Agent is working in pane p:4." },
  { id: "23", title: "Session store schema + migrations", runRoot: "auth-spec", triage: "ready-for-agent", status: "open", blockedBy: ["21"], agent: "idle", tasks: { done: 0, total: 4 }, ago: "1h", body: "Blocker 21 just cleared; now on the frontier." },
  { id: "24", title: "Login error + redirect handling", runRoot: "auth-spec", triage: "needs-info", status: "open", blockedBy: [], agent: "blocked", tasks: { done: 1, total: 5 }, ago: "30m", body: "Ambiguous redirect spec; the agent flagged itself blocked for a human decision." },
  { id: "25", title: "Audit log export", runRoot: "auth-spec", triage: "ready-for-human", status: "open", blockedBy: ["22"], agent: "idle", tasks: { done: 4, total: 5 }, ago: "20m", body: "Draft ready for human review before it ships. Your turn." },
];

// ---------------------------------------------------------------------------
// CROSS-VIEW THEME — the 06 list palette lifted to one semantic module.
// Surface, border, state, text, and accent roles. Every view below reads these
// tokens; changing a value here re-themes the whole app. This is the answer to
// "base palette/typography consistency beyond the list".
// ---------------------------------------------------------------------------

const THEME = {
  surface: { bg: "#171b26", panel: "#1e2433" },
  border: { focused: "#7aa2f7", idle: "#3b4252" },
  state: {
    done: "#4c566a", running: "#e9b94e", blocked: "#ef476f",
    frontier: "#48cae4", human: "#f8961e", humanPulse: "#ffd166",
    ok: "#06d6a0",
  },
  text: { title: "#e8eef5", body: "#c5cee0", dim: "#5c6678", dimmer: "#434a5c" },
  accent: { brand: "#7aa2f7", id: "#88c0d0", triage: "#bb9af7" },
  // type roles — color + weight. "Typography" in a cell grid = role assignment.
  role: {
    h1:    { fg: "#e8eef5", attr: TextAttributes.BOLD },
    h2:    { fg: "#7aa2f7", attr: TextAttributes.BOLD },
    label: { fg: "#5c6678", attr: 0 },
    body:  { fg: "#c5cee0", attr: 0 },
    meta:  { fg: "#5c6678", attr: 0 },
  },
  selBg: "#2e3a52",
} as const;

const isResolved = (id: string) => TICKETS.find((t) => t.id === id)?.status === "resolved";
function listState(t: Ticket): "frontier" | "running" | "blocked" | "done" {
  if (t.status === "resolved" || t.agent === "done") return "done";
  if (t.agent === "working") return "running";
  if (t.agent === "blocked" || t.blockedBy.some((b) => !isResolved(b))) return "blocked";
  return "frontier";
}
function humanNeeded(t: Ticket): boolean {
  return t.triage === "ready-for-human" || t.triage === "needs-info" || t.triage === "needs-triage";
}
function stateColor(t: Ticket): string {
  const s = listState(t);
  if (s === "done") return THEME.state.done;
  if (humanNeeded(t)) return THEME.state.human;
  if (s === "running") return THEME.state.running;
  if (s === "blocked") return THEME.state.blocked;
  return THEME.state.frontier;
}
function iconOf(t: Ticket): string {
  const s = listState(t);
  if (s === "done") return "✓";
  if (humanNeeded(t)) return "☻";
  if (s === "running") return "⟳";
  if (s === "blocked") return "✗";
  return "○";
}
function launchFor(t: Ticket): string | null {
  if (t.status === "resolved") return null;
  if (t.wf === "map") return null;
  if (t.wf) return `/wayfinder ${t.id}`;
  if (t.triage === "ready-for-agent") return `/implement ${t.id}`;
  return null;
}
function trunc(s: string, n: number): string {
  if (n <= 0) return "";
  return s.length <= n ? s : n <= 1 ? "…" : s.slice(0, n - 1) + "…";
}

// ---------------------------------------------------------------------------
// Small presentational helpers — all theme-driven
// ---------------------------------------------------------------------------

// Typography-role text: the "type system" the cross-view-theme requirement
// asks for. Every view renders titles/labels/body/meta through this so type
// treatment is consistent and lives in one place (THEME.role), not inline.
function T(props: { role: keyof typeof THEME["role"]; children: any; flexGrow?: number }) {
  const r = THEME.role[props.role];
  return <text fg={r.fg} attributes={r.attr} flexGrow={props.flexGrow}>{props.children}</text>;
}

function Chip(props: { label: string; bg: string; fg?: string }) {
  return (
    <box backgroundColor={props.bg} paddingLeft={1} paddingRight={1} marginRight={1}>
      <text fg={props.fg ?? "#11151c"} attributes={TextAttributes.BOLD}>{props.label}</text>
    </box>
  );
}

function Pane(props: { title: string; focused: boolean; children: any; height?: `${number}%`; width?: `${number}%`; flexGrow?: number; onMouseDown?: (e: MouseEvent) => void }) {
  return (
    <box
      flexDirection="column"
      flexGrow={props.flexGrow ?? 0}
      flexShrink={props.width ? 0 : 1}
      height={props.height}
      width={props.width}
      border={true}
      borderStyle="rounded"
      borderColor={props.focused ? THEME.border.focused : THEME.border.idle}
      title={` ${props.title} `}
      titleColor={props.focused ? THEME.border.focused : THEME.text.dim}
      onMouseDown={props.onMouseDown}
    >
      {props.children}
    </box>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const RUN_ROOTS = [...new Set(TICKETS.map((t) => t.runRoot))];
const CTRL_A = "\x01"; // Ctrl+A raw byte — the sequence prependInputHandler sees
const DBL_CLICK_MS = 350;

function App() {
  const dims = useTerminalDimensions();
  const renderer = useRenderer();

  const [rootIdx, setRootIdx] = createSignal(0);
  const [cursor, setCursor] = createSignal(0);
  const [focus, setFocus] = createSignal<"list" | "detail">("list");
  const [launched, setLaunched] = createSignal<string | null>(null);
  const [tick, setTick] = createSignal(0); // attention pulse
  // ctrl+a handoff state — what the prefix claim did, and when
  const [prefixHits, setPrefixHits] = createSignal<number>(0);
  const [prefixFlash, setPrefixFlash] = createSignal<number>(0);
  // last mouse action — surfaced so it's observable in a pty screenshot
  const [mouseLog, setMouseLog] = createSignal<string>("—");
  let treeScroll: any = null;

  const pool = () => TICKETS.filter((t) => t.runRoot === RUN_ROOTS[rootIdx()]);
  const cursorId = () => pool()[cursor()]?.id;
  const selected = () => pool()[cursor()];

  // attention pulse + prefix-flash decay
  onMount(() => {
    const id = setInterval(() => {
      setTick((t) => t ^ 1);
      setPrefixFlash((f) => (f > 0 ? f - 1 : 0));
    }, 450);
    onCleanup(() => clearInterval(id));
  });

  // THE ctrl+a RECONCILIATION: claim herdr's prefix before OpenTUI's own key
  // dispatch sees it. Returning true consumes the sequence — OpenTUI never gets
  // it as a KeyEvent, so the host (herdr) owns ctrl+a entirely. This is the
  // handoff 01/02 said to prototype: a prependInputHandler reserves it.
  onMount(() => {
    const handler = (sequence: string): boolean => {
      if (sequence === CTRL_A) {
        setPrefixHits((n) => n + 1);
        setPrefixFlash(3); // light the chip for ~3 frames
        setMouseLog("ctrl+a → claimed for herdr");
        return true; // consumed — not passed downstream
      }
      return false;
    };
    renderer.prependInputHandler(handler);
    onCleanup(() => renderer.removeInputHandler(handler));
  });

  // keep the cursor row in view when it moves / the run changes
  createEffect(() => {
    const id = cursorId();
    if (id && treeScroll) {
      try { treeScroll.scrollChildIntoView(id); } catch { /* prototype */ }
    }
  });

  function move(dir: number) {
    const n = pool().length;
    if (!n) return;
    setCursor((c) => Math.min(n - 1, Math.max(0, c + dir)));
    setLaunched(null);
  }
  function cycleRoot(dir: number) {
    setRootIdx((r) => (r + dir + RUN_ROOTS.length) % RUN_ROOTS.length);
    setCursor(0);
    setLaunched(null);
  }
  function selectId(id: string) {
    const i = pool().findIndex((t) => t.id === id);
    if (i >= 0) { setCursor(i); setLaunched(null); }
  }
  function doLaunch() {
    const t = pool()[cursor()];
    const cmd = t && launchFor(t);
    setLaunched(cmd ? `${cmd}  →  spawned herdr pane` : "(no auto-dispatch — human turn)");
    setMouseLog(cmd ? `launched #${t!.id}` : `#${t?.id} is a human turn`);
  }

  // ---- mouse handlers ------------------------------------------------------
  // Single click on a row = select + focus list. Double-click = launch.
  // Wheel over the list = move the cursor (selection follows the scroll).
  let lastClickId = "";
  let lastClickAt = 0;
  function onRowMouseDown(e: MouseEvent, id: string) {
    if (e.button !== MouseButton.LEFT) return;
    setFocus("list");
    const now = Date.now();
    const dbl = id === lastClickId && now - lastClickAt < DBL_CLICK_MS;
    lastClickId = id; lastClickAt = now;
    selectId(id);
    if (dbl) { doLaunch(); setMouseLog(`dbl-click launch #${id}`); }
    else setMouseLog(`click select #${id}`);
  }
  function onListWheel(e: MouseEvent) {
    if (e.button === MouseButton.WHEEL_UP) { move(-1); setMouseLog("wheel ↑"); }
    else if (e.button === MouseButton.WHEEL_DOWN) { move(1); setMouseLog("wheel ↓"); }
  }
  function onDetailMouseDown(e: MouseEvent) {
    if (e.button === MouseButton.LEFT) { setFocus("detail"); setMouseLog("focus detail"); }
  }

  // ---- keyboard (ctrl+a never reaches here — claimed upstream) -------------
  useKeyboard((key) => {
    if (key.name === "q" || key.name === "escape") renderer.destroy();
    else if (key.name === "tab") setFocus((f) => (f === "list" ? "detail" : "list"));
    else if (key.name === "j" || key.name === "down") move(1);
    else if (key.name === "k" || key.name === "up") move(-1);
    else if (key.name === "r") cycleRoot(1);
    else if (key.name === "return") doLaunch();
  });

  const root = () => RUN_ROOTS[rootIdx()];
  const running = () => pool().filter((t) => listState(t) === "running").length;
  const yourTurn = () => pool().filter(humanNeeded).length;
  const attentionOn = () => tick() === 1;

  return (
    <box flexDirection="column" flexGrow={1} live={true} backgroundColor={THEME.surface.bg}>
      {/* ---- header (theme-driven) ---- */}
      <box flexGrow={0} paddingLeft={1} paddingRight={1} flexDirection="row" backgroundColor={THEME.surface.panel}>
        <T role="h2">◆ herdr-beads</T>
        <text fg={THEME.text.dim}>  look & feel  </text>
        <text fg={THEME.accent.triage} attributes={TextAttributes.BOLD}>{root()}</text>
        <text fg={THEME.text.dim}>  ·  </text>
        <text fg={THEME.text.title}>{pool().length} issues</text>
        <text fg={THEME.text.dim}>  ·  </text>
        <text fg={THEME.state.running}>{running()} running</text>
        <text fg={THEME.text.dim}>  ·  </text>
        <text fg={THEME.state.human} attributes={TextAttributes.BOLD}>{yourTurn()} your-turn</text>
        <text fg={THEME.text.dimmer} flexGrow={1}> </text>
        {/* ctrl+a prefix chip — flashes when the handoff fires */}
        <box backgroundColor={prefixFlash() > 0 ? THEME.state.human : THEME.text.dimmer} paddingLeft={1} paddingRight={1}>
          <text fg={prefixFlash() > 0 ? "#11151c" : THEME.text.body} attributes={TextAttributes.BOLD}>
            {`ctrl+a → herdr${prefixHits() ? ` ×${prefixHits()}` : ""}`}
          </text>
        </box>
      </box>

      {/* ---- list + detail ---- */}
      <box flexDirection="row" flexGrow={1}>
        <Pane title="Tickets · click / wheel / dbl-click" focused={focus() === "list"} flexGrow={1}>
          <scrollbox
            ref={(el: any) => (treeScroll = el)}
            flexGrow={1}
            scrollY={true}
            onMouseScroll={onListWheel}
          >
            <For each={pool()}>
              {(t) => {
                const sel = () => cursorId() === t.id;
                const hasTasks = !!t.tasks;
                const tasksDone = hasTasks && t.tasks!.done >= t.tasks!.total;
                // list pane = the half left after detail's 50%; content = that minus border+padding.
                const rowW = () => Math.max(8, dims().width - Math.floor(dims().width * 0.5) - 4);
                const idStr = `#${t.id}`;
                const tasksStr = hasTasks ? `${t.tasks!.done}/${t.tasks!.total}` : "";
                const fixed = 2 + idStr.length + (tasksStr ? tasksStr.length + 2 : 0) + t.ago.length + 1 + 2;
                const titleBudget = () => Math.max(0, rowW() - fixed);
                return (
                  <box
                    id={t.id}
                    flexDirection="row"
                    paddingLeft={1}
                    paddingRight={1}
                    backgroundColor={sel() ? THEME.selBg : undefined}
                    onMouseDown={(e: MouseEvent) => onRowMouseDown(e, t.id)}
                  >
                    <text
                      flexShrink={0}
                      fg={humanNeeded(t) ? (attentionOn() ? THEME.state.humanPulse : THEME.state.human) : stateColor(t)}
                      attributes={humanNeeded(t) && attentionOn() ? TextAttributes.BOLD : 0}
                    >
                      {`${iconOf(t)} `}
                    </text>
                    <text fg={THEME.accent.id} flexShrink={0}>{idStr}</text>
                    <text fg={sel() ? THEME.text.title : THEME.text.body} flexGrow={1} flexShrink={1}>{`  ${trunc(t.title, titleBudget())}`}</text>
                    <Show when={hasTasks}>
                      <text fg={tasksDone ? THEME.state.ok : THEME.state.blocked} flexShrink={0}>{tasksStr}</text>
                      <text fg={THEME.text.dimmer} flexShrink={0}>  </text>
                    </Show>
                    <text fg={THEME.text.dim} flexShrink={0}>{` ${t.ago}`}</text>
                  </box>
                );
              }}
            </For>
          </scrollbox>
        </Pane>

        <Pane title={selected() ? `Detail · #${selected()!.id}` : "Detail"} focused={focus() === "detail"} width="50%" onMouseDown={onDetailMouseDown}>
          <scrollbox flexGrow={1} scrollY={true} paddingLeft={1} paddingRight={1}>
            <Show when={selected()} keyed>
              {(t: Ticket) => {
                const lf = launchFor(t);
                return (
                  <box flexDirection="column" flexGrow={1}>
                    <box flexDirection="row">
                      <text fg={stateColor(t)} attributes={TextAttributes.BOLD} flexShrink={0}>{`${iconOf(t)} #${t.id}`}</text>
                      <text fg={THEME.text.dim} flexShrink={0}>  </text>
                      <T role="h1">{trunc(t.title, Math.max(4, Math.floor(dims().width * 0.5) - 4 - `${iconOf(t)} #${t.id}`.length - 2))}</T>
                    </box>
                    <box flexDirection="row" flexWrap="wrap" paddingTop={1} paddingBottom={1}>
                      <Chip label={t.triage} bg={THEME.accent.triage} />
                      <Chip label={t.wf ? `wayfinder:${t.wf}` : "implement"} bg={THEME.accent.brand} />
                      <Chip label={listState(t)} bg={stateColor(t)} />
                      <Chip label={t.status} bg={t.status === "resolved" ? THEME.state.done : THEME.text.dimmer} fg="#e8eef5" />
                    </box>
                    <text fg={THEME.text.dim}>
                      {`blocked by: ${t.blockedBy.length ? t.blockedBy.join(", ") : "—"}    agent: ${t.agent}${t.tasks ? `    tasks: ${t.tasks.done}/${t.tasks.total}` : ""}    ${t.ago} ago`}
                    </text>
                    <text fg={THEME.text.dimmer}>{""}</text>
                    <T role="body">{t.body}</T>
                    <text fg={THEME.text.dimmer}>{""}</text>
                    <box flexDirection="row">
                      <T role="label">{"launch  "}</T>
                      <text fg={lf ? THEME.state.ok : THEME.state.human} attributes={TextAttributes.BOLD}>
                        {lf ?? "(no auto-dispatch — human turn)"}
                      </text>
                    </box>
                    <Show when={launched()}>
                      <text fg={THEME.state.ok} attributes={TextAttributes.BOLD}>{"↳ " + launched()!}</text>
                    </Show>
                  </box>
                );
              }}
            </Show>
          </scrollbox>
        </Pane>
      </box>

      {/* ---- footer status bar (theme-driven; shows mouse + prefix state) ---- */}
      <box flexGrow={0} flexDirection="row" paddingLeft={1} paddingRight={1} backgroundColor={THEME.surface.panel}>
        <text fg={THEME.accent.brand} attributes={TextAttributes.BOLD}>mouse</text>
        <text fg={THEME.text.dim}>  {mouseLog()}</text>
        <text fg={THEME.text.dimmer} flexGrow={1}> </text>
        <T role="meta">click select · dbl-click launch · wheel move · Tab pane · j/k move · Enter launch · q quit</T>
      </box>
    </box>
  );
}

render(() => <App />);
