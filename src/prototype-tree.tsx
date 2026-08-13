// ============================================================================
// PROTOTYPE — THROWAWAY. Not production, not the real plugin.
// Ticket 07: a dependency tree of a run, two-pane — lean tree (structure +
// node labels) on top, a scrollable detail pane below for the selected ticket.
// Both panes scroll on overflow; the tree auto-scrolls to the cursor.
//
// Run:   bun run src/prototype-tree.tsx   (or: bun run prototype:tree)
// Keys:  j/k move · Tab swap pane · Enter launch · r cycle run-root · q/Esc quit
// ============================================================================

import { createSignal, For, Show, createEffect } from "solid-js";
import { TextAttributes } from "@opentui/core";
import { render, useKeyboard, useTerminalDimensions } from "@opentui/solid";

// ---------------------------------------------------------------------------
// Domain + mock data (copied from prototype-shell.tsx — throwaway)
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
  { id: "07", title: "Prototype: run-graph view", runRoot: "herdr-beads map", triage: "needs-info", wf: "prototype", status: "open", blockedBy: ["06"], agent: "idle", tasks: { done: 0, total: 3 }, ago: "4h", body: "A detail-rich dependency tree (this view). Blocked on 06 while it reframed the question." },
  { id: "08", title: "Prototype: look & feel + mouse", runRoot: "herdr-beads map", triage: "ready-for-agent", wf: "prototype", status: "open", blockedBy: [], agent: "idle", tasks: { done: 0, total: 3 }, ago: "4h", body: "Mouse behavior, ctrl+a reconciliation with herdr, and a cross-view theme." },
  { id: "21", title: "Auth provider selection", runRoot: "auth-spec", triage: "ready-for-agent", wf: "research", status: "resolved", blockedBy: [], agent: "done", ago: "1w", body: "Picked OIDC via provider X. Resolved." },
  { id: "22", title: "Token refresh w/ boundary scheduling", runRoot: "auth-spec", triage: "ready-for-agent", status: "open", blockedBy: [], agent: "working", tasks: { done: 2, total: 3 }, ago: "2h", body: "Silent refresh + boundary scheduling. Agent is working in pane p:4." },
  { id: "23", title: "Session store schema + migrations", runRoot: "auth-spec", triage: "ready-for-agent", status: "open", blockedBy: ["21"], agent: "idle", tasks: { done: 0, total: 4 }, ago: "1h", body: "Blocker 21 just cleared; now on the frontier." },
  { id: "24", title: "Login error + redirect handling", runRoot: "auth-spec", triage: "needs-info", status: "open", blockedBy: [], agent: "blocked", tasks: { done: 1, total: 5 }, ago: "30m", body: "Ambiguous redirect spec; the agent flagged itself blocked for a human decision." },
  { id: "25", title: "Audit log export", runRoot: "auth-spec", triage: "ready-for-human", status: "open", blockedBy: ["22"], agent: "idle", tasks: { done: 4, total: 5 }, ago: "20m", body: "Draft ready for human review before it ships. Your turn." },
];

// Saturated Nord-ish palette
const C = {
  bg: "#171b26", panel: "#1e2433",
  running: "#e9b94e", blocked: "#ef476f", done: "#4c566a",
  frontier: "#48cae4", attention: "#f8961e",
  accent: "#7aa2f7", id: "#88c0d0", title: "#e8eef5",
  dim: "#5c6678", dimmer: "#434a5c", edge: "#3b4252",
  triage: "#bb9af7", selBg: "#2e3a52",
  green: "#06d6a0",
};

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
  if (s === "done") return C.done;
  if (humanNeeded(t)) return C.attention;
  if (s === "running") return C.running;
  if (s === "blocked") return C.blocked;
  return C.frontier;
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
const runTickets = (root: string) => TICKETS.filter((t) => t.runRoot === root);

// ---------------------------------------------------------------------------
// Forest: children = the tickets this one BLOCKS (forward / run-progression)
// ---------------------------------------------------------------------------

interface TreeNode { t: Ticket; children: TreeNode[] }
function buildForest(pool: Ticket[]): TreeNode[] {
  const roots = pool.filter((t) => !t.blockedBy.some((b) => pool.find((p) => p.id === b)));
  const expand = (t: Ticket): TreeNode => ({
    t, children: pool.filter((c) => c.blockedBy.includes(t.id)).map(expand),
  });
  return roots.map(expand);
}
interface NodeRow { t: Ticket; depth: number; branch: string }
function flatten(nodes: TreeNode[], depth: number, out: NodeRow[]) {
  nodes.forEach((n, i) => {
    const last = i === nodes.length - 1;
    out.push({ t: n.t, depth, branch: depth === 0 ? "" : last ? "└─ " : "├─ " });
    if (n.children.length) flatten(n.children, depth + 1, out);
  });
}

// ---------------------------------------------------------------------------
// Small presentational helpers
// ---------------------------------------------------------------------------

function Chip(props: { label: string; bg: string; fg?: string }) {
  return (
    <box backgroundColor={props.bg} paddingLeft={1} paddingRight={1} marginRight={1}>
      <text fg={props.fg ?? "#11151c"} attributes={TextAttributes.BOLD}>{props.label}</text>
    </box>
  );
}

function Pane(props: { title: string; focused: boolean; children: any; height?: `${number}%`; flexGrow?: number }) {
  return (
    <box
      flexDirection="column"
      flexGrow={props.flexGrow ?? 0}
      height={props.height}
      border={true}
      borderStyle="rounded"
      borderColor={props.focused ? C.accent : C.edge}
      title={` ${props.title} `}
      titleColor={props.focused ? C.accent : C.dim}
    >
      {props.children}
    </box>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const RUN_ROOTS = [...new Set(TICKETS.map((t) => t.runRoot))];

function App() {
  const dims = useTerminalDimensions();
  const [rootIdx, setRootIdx] = createSignal(0);
  const [cursor, setCursor] = createSignal(0);
  const [focus, setFocus] = createSignal<"tree" | "detail">("tree");
  const [launched, setLaunched] = createSignal<string | null>(null);
  let treeScroll: any = null;

  const pool = () => runTickets(RUN_ROOTS[rootIdx()]);
  const cursorId = () => pool()[cursor()]?.id;
  const selected = () => pool()[cursor()];

  const rows = () => {
    const out: NodeRow[] = [];
    flatten(buildForest(pool()), 0, out);
    return out;
  };

  // keep the cursor row in view when it moves / the run changes
  createEffect(() => {
    const id = cursorId();
    if (id && treeScroll) {
      try { treeScroll.scrollChildIntoView(id); } catch { /* prototype: best-effort */ }
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
  function doLaunch() {
    const t = pool()[cursor()];
    const cmd = t && launchFor(t);
    setLaunched(cmd ? `${cmd}  →  spawned herdr pane` : "(no auto-dispatch — human turn)");
  }

  useKeyboard((key) => {
    if (key.name === "q" || key.name === "escape") process.exit(0);
    else if (key.name === "tab") setFocus((f) => (f === "tree" ? "detail" : "tree"));
    else if (key.name === "j" || key.name === "down") move(1);
    else if (key.name === "k" || key.name === "up") move(-1);
    else if (key.name === "r") cycleRoot(1);
    else if (key.name === "return") doLaunch();
  });

  const root = () => RUN_ROOTS[rootIdx()];
  const running = () => pool().filter((t) => listState(t) === "running").length;
  const yourTurn = () => pool().filter(humanNeeded).length;

  return (
    <box flexDirection="column" flexGrow={1} live={true} backgroundColor={C.bg}>
      {/* header */}
      <box flexGrow={0} paddingLeft={1} paddingRight={1} flexDirection="row">
        <text fg={C.accent} attributes={TextAttributes.BOLD}>◆ herdr-beads</text>
        <text fg={C.dim}>  dependency tree  </text>
        <text fg={C.triage} attributes={TextAttributes.BOLD}>{root()}</text>
        <text fg={C.dim}>  ·  </text>
        <text fg={C.title}>{pool().length} issues</text>
        <text fg={C.dim}>  ·  </text>
        <text fg={C.running}>{running()} running</text>
        <text fg={C.dim}>  ·  </text>
        <text fg={C.attention} attributes={TextAttributes.BOLD}>{yourTurn()} your-turn</text>
        <text fg={C.dimmer} flexGrow={1}> </text>
        <text fg={C.dim}>j/k move · Tab pane · r run · Enter launch · q quit</text>
      </box>

      {/* tree pane (lean: structure + node labels only) */}
      <Pane title="Dependencies" focused={focus() === "tree"} flexGrow={1}>
        <scrollbox ref={(el: any) => (treeScroll = el)} flexGrow={1} scrollY={true}>
          <For each={rows()}>
            {(r) => {
              const t = r.t;
              const sel = () => cursorId() === t.id;
              const hasTasks = !!t.tasks;
              const tasksDone = hasTasks && t.tasks!.done >= t.tasks!.total;
              return (
                <box id={t.id} flexDirection="row" paddingLeft={r.depth * 2 + 1} paddingRight={1}
                     backgroundColor={sel() ? C.selBg : undefined}>
                  <text fg={C.edge} attributes={TextAttributes.BOLD}>{r.branch}</text>
                  <text fg={stateColor(t)} attributes={TextAttributes.BOLD}>{`${iconOf(t)} `}</text>
                  <text fg={C.id}>{`#${t.id}`}</text>
                  <text fg={sel() ? C.title : "#c5cee0"}>{`  ${trunc(t.title, 40)}`}</text>
                  <text fg={C.dimmer} flexGrow={1}> </text>
                  <Show when={hasTasks}>
                    <text fg={tasksDone ? C.green : C.blocked}>{`${t.tasks!.done}/${t.tasks!.total}`}</text>
                    <text fg={C.dimmer}>  </text>
                  </Show>
                  <text fg={C.dim}>{t.ago}</text>
                </box>
              );
            }}
          </For>
        </scrollbox>
      </Pane>

      {/* detail pane (the verbose stuff: labels, deps, body, launch) */}
      <Pane title={selected() ? `Detail · #${selected()!.id}` : "Detail"} focused={focus() === "detail"} height="38%">
        <scrollbox flexGrow={1} scrollY={true} paddingTop={0} paddingBottom={0}>
          <Show when={selected()} keyed>
            {(t) => {
              const lf = launchFor(t);
              return (
                <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
                  <box flexDirection="row">
                    <text fg={stateColor(t)} attributes={TextAttributes.BOLD}>{`${iconOf(t)} #${t.id}`}</text>
                    <text fg={C.dim}>  </text>
                    <text fg={C.title} attributes={TextAttributes.BOLD}>{t.title}</text>
                  </box>
                  {/* label chips */}
                  <box flexDirection="row" paddingTop={1} paddingBottom={1}>
                    <Chip label={t.triage} bg={C.triage} />
                    <Chip label={t.wf ? `wayfinder:${t.wf}` : "implement"} bg={C.accent} />
                    <Chip label={listState(t)} bg={stateColor(t)} />
                    <Chip label={t.status} bg={t.status === "resolved" ? C.done : C.dimmer} fg="#e8eef5" />
                  </box>
                  <text fg={C.dim}>
                    {`blocked by: ${t.blockedBy.length ? t.blockedBy.join(", ") : "—"}    agent: ${t.agent}${t.tasks ? `    tasks: ${t.tasks.done}/${t.tasks.total}` : ""}    ${t.ago} ago`}
                  </text>
                  <text fg={C.dimmer}>{""}</text>
                  <text fg="#c5cee0">{t.body}</text>
                  <text fg={C.dimmer}>{""}</text>
                  <box flexDirection="row">
                    <text fg={C.dim}>{"launch  "}</text>
                    <text fg={lf ? C.green : C.attention} attributes={TextAttributes.BOLD}>
                      {lf ?? "(no auto-dispatch — human turn)"}
                    </text>
                  </box>
                  <Show when={launched()}>
                    <text fg={C.green} attributes={TextAttributes.BOLD}>{"↳ " + launched()!}</text>
                  </Show>
                </box>
              );
            }}
          </Show>
        </scrollbox>
      </Pane>
    </box>
  );
}

render(() => <App />);
