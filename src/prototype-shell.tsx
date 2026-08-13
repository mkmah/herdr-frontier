// ============================================================================
// PROTOTYPE — THROWAWAY. Not production, not the real plugin.
// Ticket 06 (round 3): "What should herdr-beads's primary shell look like?"
//
// Region model = B (list left, detail right). Round-3 fixes:
//  • Saturated palette (round 2 read monochrome — Nord was too desaturated).
//  • Warnings are ORANGE.
//  • Selection is reactive (was captured once → never updated) AND visible
//    (inverse bar + ▶ marker); was an invisible bg tint before.
//  • Left pane FIXED at 40% (width="40%"), detail takes the rest — content can
//    no longer push the pane width around.
//  • Title truncation adapts to the pane's inner width (re-runs on resize).
//
// Run:  bun run src/prototype-shell.tsx   (or: bun run prototype)
// Keys: [/] or 1/2/3 switch variant · Tab cycle region · j/k or ↑/↓ move
//       Enter launch · q/Esc quit
// ============================================================================

import { createSignal, For, Show, onMount, onCleanup } from "solid-js";
import { TextAttributes } from "@opentui/core";
import { render, useKeyboard, useTerminalDimensions } from "@opentui/solid";

// ---------------------------------------------------------------------------
// Domain shapes
// ---------------------------------------------------------------------------

type AgentState = "idle" | "working" | "blocked" | "done";
type Triage = "ready-for-agent" | "ready-for-human" | "needs-info" | "needs-triage" | "wontfix";
type WfType = "map" | "research" | "grilling" | "prototype" | "task";

interface Ticket {
  id: string;
  title: string;
  runRoot: string;
  triage: Triage;
  wf?: WfType;
  status: "open" | "resolved";
  blockedBy: string[];
  agent: AgentState;
  body: string;
  tasks?: { done: number; total: number };
  ago: string;
}

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const TICKETS: Ticket[] = [
  { id: "01", title: "herdr plugin capabilities", runRoot: "herdr-beads map", triage: "ready-for-agent", wf: "research", status: "resolved", blockedBy: [], agent: "done", ago: "3d", body: "Plugins are out-of-process; TUI surfaced via a [[panes]] entry. Resolved." },
  { id: "02", title: "OpenTUI/Solid capabilities", runRoot: "herdr-beads map", triage: "ready-for-agent", wf: "research", status: "resolved", blockedBy: [], agent: "done", ago: "3d", body: "Full keyboard+mouse, Yoga flexbox, Solid signals. Embedding viable via split-footer. Resolved." },
  { id: "05", title: "tracker-provider interface", runRoot: "herdr-beads map", triage: "ready-for-agent", wf: "grilling", status: "resolved", blockedBy: ["03"], agent: "done", tasks: { done: 5, total: 5 }, ago: "2d", body: "One async TrackerProvider, 7 verbs, one adapter per tracker. Locked in ADR-0001. Resolved." },
  { id: "06", title: "Prototype: core layout & navigation", runRoot: "herdr-beads map", triage: "ready-for-human", wf: "prototype", status: "open", blockedBy: [], agent: "idle", tasks: { done: 2, total: 4 }, ago: "5h", body: "Prototype the primary shell: list + detail, inline animated attention, keyboard nav. This is what you're looking at." },
  { id: "07", title: "Prototype: run-graph view", runRoot: "herdr-beads map", triage: "needs-info", wf: "prototype", status: "open", blockedBy: ["06"], agent: "idle", tasks: { done: 0, total: 3 }, ago: "4h", body: "Hand-rolled dep-graph canvas (FrameBufferRenderable). Blocked on 06; needs-info on whether auto-layout is in scope." },
  { id: "21", title: "Auth provider selection", runRoot: "auth-spec", triage: "ready-for-agent", wf: "research", status: "resolved", blockedBy: [], agent: "done", ago: "1w", body: "Picked OIDC via provider X. Resolved." },
  { id: "22", title: "Token refresh logic with boundary scheduling", runRoot: "auth-spec", triage: "ready-for-agent", status: "open", blockedBy: [], agent: "working", tasks: { done: 2, total: 3 }, ago: "2h", body: "Implement silent refresh + boundary scheduling. Agent is working in pane p:4." },
  { id: "23", title: "Session store schema and migrations", runRoot: "auth-spec", triage: "ready-for-agent", status: "open", blockedBy: ["21"], agent: "idle", tasks: { done: 0, total: 4 }, ago: "1h", body: "Design the session table; blocker 21 just cleared, now on the frontier." },
  { id: "24", title: "Login error states and redirect handling", runRoot: "auth-spec", triage: "needs-info", status: "open", blockedBy: [], agent: "blocked", tasks: { done: 1, total: 5 }, ago: "30m", body: "Agent hit an ambiguous spec on redirect-on-error; flagged blocked for a human decision." },
  { id: "25", title: "Audit log export", runRoot: "auth-spec", triage: "ready-for-human", status: "open", blockedBy: ["22"], agent: "idle", tasks: { done: 4, total: 5 }, ago: "20m", body: "Draft ready for human review before it ships. Your turn." },
];

// ---------------------------------------------------------------------------
// Derived model
// ---------------------------------------------------------------------------

const isResolved = (id: string) => TICKETS.find((t) => t.id === id)?.status === "resolved";

function listState(t: Ticket): "frontier" | "running" | "blocked" | "done" {
  if (t.status === "resolved" || t.agent === "done") return "done";
  if (t.agent === "working") return "running";
  if (t.agent === "blocked" || t.blockedBy.some((b) => !isResolved(b))) return "blocked";
  return "frontier";
}
function inAttention(t: Ticket): boolean {
  return t.triage === "ready-for-human" || t.triage === "needs-info" || t.triage === "needs-triage" || t.agent === "blocked";
}
function launchFor(t: Ticket): string | null {
  if (t.status === "resolved") return null;
  if (t.wf === "map") return null;
  if (t.wf) return `/wayfinder ${t.id}`;
  if (t.triage === "ready-for-agent") return `/implement ${t.id}`;
  return null;
}

const ATTENTION = TICKETS.filter(inAttention);
const RUN_ROOTS = [...new Set(TICKETS.map((t) => t.runRoot))];
const RUNLIST = TICKETS.slice().sort((a, b) => (a.runRoot === b.runRoot ? a.id.localeCompare(b.id) : a.runRoot.localeCompare(b.runRoot)));

// ---------------------------------------------------------------------------
// Saturated palette + glyphs (round 2's Nord read as monochrome)
// ---------------------------------------------------------------------------

const C = {
  focusBorder: "#5e81d5", idleBorder: "#4c566a",
  running: "#e9b94e",    // gold
  blocked: "#ef476f",    // red (also: incomplete task counts)
  done: "#06d6a0",       // green (also: complete task counts)
  frontier: "#48cae4",   // cyan
  attention: "#f8961e",  // ORANGE — warnings, per feedback
  accent: "#7aa2f7",     // blue (headers, ▶ marker)
  id: "#5390d9",         // blue
  title: "#e8eef5",
  dim: "#8b95a7",
  triage: "#bb9af7",
  selBg: "#2e3a52",      // selection highlight (readable behind all segment colors)
};
const G = { running: "⟳", blocked: "✗", done: "✓", frontier: "○", attention: "⚠" };

function humanNeeded(t: Ticket): boolean {
  return t.triage === "ready-for-human" || t.triage === "needs-info" || t.triage === "needs-triage";
}
// One icon per row, in the state-glyph slot — no separate marker column.
// Human-input items show a USER icon (☻) instead of a generic warning.
function iconOf(t: Ticket): string {
  const s = listState(t);
  if (s === "done") return "✓";
  if (humanNeeded(t)) return "☻";
  if (s === "running") return "⟳";
  if (s === "blocked") return "✗";
  return "○";
}
function iconColor(t: Ticket, pulse: boolean): string {
  const s = listState(t);
  if (s === "done") return C.done;
  if (humanNeeded(t)) return pulse ? "#ffd166" : C.attention; // orange ↔ soft-gold pulse
  if (s === "running") return C.running;
  if (s === "blocked") return C.blocked;
  return C.frontier;
}

function trunc(s: string, n: number): string {
  if (n <= 0) return "";
  return s.length <= n ? s : n <= 1 ? "…" : s.slice(0, n - 1) + "…";
}
function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

// ---------------------------------------------------------------------------
// List row. Reactive selection via <Show>; reads props.selected live.
// Layout (fills exactly `width` cols so selection bg spans the full row):
//   [marker 2][glyph 1][sp][#id][sp][title…padded][sp][meta]
// ---------------------------------------------------------------------------

function TicketRow(props: { t: Ticket; selected: boolean; attentionOn: boolean; width: number }) {
  // Segments are <text> siblings in a row <box> — NOT <span>: in this OpenTUI
  // build <span> does not render fg, while <text> does. Selection = background
  // color ONLY on the <box> (no ▶ marker: it wasted the left column and was
  // hard to spot). Attention is folded into the single icon (a user icon ☻ for
  // human-input items, pulsing) so there's no separate marker column.
  //
  // Reactivity: a keyed <Show> remounts the row when selected/blink/width
  // changes. Children are plain local strings (static → fg applies), and
  // backgroundColor is static at mount (the function-accessor form wasn't
  // applied reactively for this prop).
  const key = () => `${props.selected ? 1 : 0}|${props.attentionOn ? 1 : 0}|${props.width}`;
  return (
    <Show when={key()} keyed>
      {() => {
        const t = props.t;
        const hasTasks = !!t.tasks;
        const tasksDone = hasTasks && t.tasks!.done >= t.tasks!.total;
        const tasksStr = hasTasks ? `${t.tasks!.done}/${t.tasks!.total}` : "";
        const icon = iconOf(t);
        const left = `${icon} #${t.id} `;
        const right = (hasTasks ? ` ${tasksStr}` : "") + ` ${t.ago}`;
        const budget = props.width - left.length - right.length;
        const title = trunc(t.title, Math.max(4, budget));
        return (
          <box flexDirection="row" backgroundColor={props.selected ? C.selBg : undefined}>
            <text fg={iconColor(t, props.attentionOn)}
                  attributes={humanNeeded(t) && props.attentionOn ? TextAttributes.BOLD : 0}>
              {`${icon} `}
            </text>
            <text fg={C.id}>{`#${t.id} `}</text>
            <text fg={C.title} flexGrow={1}>{title}</text>
            <Show when={hasTasks}>
              <text fg={tasksDone ? C.done : C.blocked}>{` ${tasksStr}`}</text>
            </Show>
            <text fg={C.dim}>{` ${t.ago}`}</text>
          </box>
        );
      }}
    </Show>
  );
}

// ---------------------------------------------------------------------------
// Pane / Detail
// ---------------------------------------------------------------------------

function Pane(props: { title: string; focused: boolean; width?: `${number}%`; flexGrow?: number; children: any }) {
  return (
    <box
      border={true}
      borderColor={props.focused ? C.focusBorder : C.idleBorder}
      title={` ${props.title} `}
      width={props.width}
      flexGrow={props.width ? 0 : props.flexGrow ?? 1}
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
    >
      {props.children}
    </box>
  );
}

function Detail(props: { t: Ticket | undefined; focused: boolean; launched: string | null }) {
  return (
    <Pane title="Detail" focused={props.focused} flexGrow={1}>
      <For each={props.t ? [props.t] : []}>
        {(t) => (
          <>
            <text attributes={TextAttributes.BOLD} fg={C.title}>
              #{t.id} — {t.title}
            </text>
            <box flexDirection="row">
              <text fg={C.triage}>{t.triage}</text>
              <text fg={C.dim}> · </text>
              <text fg={C.accent}>{t.wf ? `wayfinder:${t.wf}` : "implement"}</text>
              <text fg={C.dim}> · </text>
              <text fg={listState(t) === "done" ? C.done : C.frontier}>{listState(t)}</text>
            </box>
            <box flexDirection="row">
              <text fg={C.dim}>
                blocked by: {t.blockedBy.length ? t.blockedBy.join(", ") : "—"} · agent: {t.agent}
                {t.tasks ? ` · tasks: ${t.tasks.done}/${t.tasks.total}` : ""} · {t.ago} ago
              </text>
            </box>
            <text fg={C.title}>{""}</text>
            <text fg={C.title}>{t.body}</text>
            <text fg={C.title}>{""}</text>
            <box flexDirection="row">
              <text fg={C.dim}>launch: </text>
              <text attributes={TextAttributes.BOLD} fg={launchFor(t) ? C.done : C.attention}>
                {launchFor(t) ?? "(no auto-dispatch — human turn)"}
              </text>
            </box>
            <text fg={C.dim}>Enter spawns the pane via the command above.</text>
          </>
        )}
      </For>
      {props.t ? null : <text fg={C.dim}>Select a ticket.</text>}
      {props.launched ? (
        <text fg={C.done} attributes={TextAttributes.BOLD}>{"↳ " + props.launched}</text>
      ) : null}
    </Pane>
  );
}

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

interface Nav { focused: string; detailId: string; attentionOn: boolean; width: number }
function groups() {
  return RUN_ROOTS.map((root) => ({ root, items: RUNLIST.filter((t) => t.runRoot === root) }));
}

// Variant B — chosen: fixed 40% list + detail, inline animated orange attention.
function VariantB(nav: Nav) {
  // inner width of a 40% pane = floor(W*0.4) - 2(border) - 2(padding)
  const innerW = () => Math.max(12, Math.floor(nav.width * 0.4) - 4);
  return (
    <box flexDirection="row" flexGrow={1}>
      <Pane title="Tickets · by run-root" focused={nav.focused === "runs"} width="40%">
        <For each={groups()}>
          {(g) => (
            <>
              <text fg={C.accent} attributes={TextAttributes.UNDERLINE | TextAttributes.BOLD}>{g.root}</text>
              <For each={g.items}>
                {(t) => <TicketRow t={t} selected={nav.detailId === t.id} attentionOn={nav.attentionOn} width={innerW()} />}
              </For>
            </>
          )}
        </For>
      </Pane>
      <Detail t={TICKETS.find((t) => t.id === nav.detailId)!} focused={nav.focused === "detail"} launched={null} />
    </box>
  );
}

// Variant A — 3 columns (attention browsable). Disfavored; kept for comparison.
function VariantA(nav: Nav) {
  const w1 = () => Math.max(12, Math.floor(nav.width * 0.24) - 4);
  const w2 = () => Math.max(14, Math.floor(nav.width * 0.34) - 4);
  return (
    <box flexDirection="row" flexGrow={1}>
      <Pane title="Attention · your turn" focused={nav.focused === "attention"} width="25%">
        <For each={ATTENTION}>
          {(t) => <TicketRow t={t} selected={nav.detailId === t.id} attentionOn={nav.attentionOn} width={w1()} />}
        </For>
        {!ATTENTION.length ? <text fg={C.dim}>Nothing needs you.</text> : null}
      </Pane>
      <Pane title="Runs · by run-root" focused={nav.focused === "runs"} width="35%">
        <For each={groups()}>
          {(g) => (
            <>
              <text fg={C.accent} attributes={TextAttributes.UNDERLINE | TextAttributes.BOLD}>{g.root}</text>
              <For each={g.items}>
                {(t) => <TicketRow t={t} selected={nav.detailId === t.id} attentionOn={nav.attentionOn} width={w2()} />}
              </For>
            </>
          )}
        </For>
      </Pane>
      <Detail t={TICKETS.find((t) => t.id === nav.detailId)!} focused={nav.focused === "detail"} launched={null} />
    </box>
  );
}

// Variant C — explorer + bottom drawer.
function VariantC(nav: Nav) {
  const innerW = () => Math.max(20, nav.width - 4);
  return (
    <box flexDirection="column" flexGrow={1}>
      <Pane title="Tickets · explorer (☻ = your turn)" focused={nav.focused === "runs"} flexGrow={6}>
        <For each={groups()}>
          {(g) => (
            <>
              <text fg={C.accent} attributes={TextAttributes.UNDERLINE | TextAttributes.BOLD}>{g.root}</text>
              <For each={g.items}>
                {(t) => <TicketRow t={t} selected={nav.detailId === t.id} attentionOn={nav.attentionOn} width={innerW()} />}
              </For>
            </>
          )}
        </For>
      </Pane>
      <Detail t={TICKETS.find((t) => t.id === nav.detailId)!} focused={nav.focused === "detail"} launched={null} />
    </box>
  );
}

const VARIANTS = [
  { key: "B", name: "List + detail (40/60, inline animated attention)", regions: ["runs", "detail"], render: VariantB },
  { key: "A", name: "3 columns — attention browsable (disfavored)", regions: ["attention", "runs", "detail"], render: VariantA },
  { key: "C", name: "Explorer + bottom drawer", regions: ["runs", "detail"], render: VariantC },
];

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

function App() {
  const [vIdx, setVIdx] = createSignal(0);
  const [focused, setFocused] = createSignal("runs");
  const [detailId, setDetailId] = createSignal("06");
  const [launched, setLaunched] = createSignal<string | null>(null);
  const [tick, setTick] = createSignal(0);
  const dims = useTerminalDimensions();

  onMount(() => {
    const id = setInterval(() => setTick((t) => t ^ 1), 600);
    onCleanup(() => clearInterval(id));
  });

  const variant = () => VARIANTS[vIdx()];

  function switchVariant(dir: number) {
    const n = (vIdx() + dir + VARIANTS.length) % VARIANTS.length;
    setVIdx(n);
    setFocused(VARIANTS[n].regions[0]);
    setLaunched(null);
  }
  function cycleRegion(reverse = false) {
    const rs = variant().regions;
    const i = rs.indexOf(focused());
    setFocused(rs[(i + (reverse ? -1 : 1) + rs.length) % rs.length]);
  }
  function moveCursor(dir: number) {
    const list = focused() === "attention" ? ATTENTION : RUNLIST;
    if (!list.length) return;
    const i = list.findIndex((t) => t.id === detailId());
    setDetailId(list[Math.min(list.length - 1, Math.max(0, (i < 0 ? 0 : i) + dir))].id);
  }
  function doLaunch() {
    const t = TICKETS.find((x) => x.id === detailId());
    const cmd = t && launchFor(t);
    setLaunched(cmd ? `${cmd}  →  spawned herdr pane` : "(no auto-dispatch — this one's a human turn)");
  }

  useKeyboard((key) => {
    const s = key.sequence;
    if (key.name === "q" || key.name === "escape") process.exit(0);
    else if (s === "[" || s === "1") switchVariant(-1);
    else if (s === "]" || s === "2") switchVariant(1);
    else if (s === "3") { setVIdx(2); setFocused(VARIANTS[2].regions[0]); }
    else if (key.name === "tab") cycleRegion(key.shift);
    else if (key.name === "j" || key.name === "down") moveCursor(1);
    else if (key.name === "k" || key.name === "up") moveCursor(-1);
    else if (key.name === "return") doLaunch();
  });

  const nav: Nav = {
    get focused() { return focused(); },
    get detailId() { return detailId(); },
    get attentionOn() { return tick() === 1; },
    get width() { return dims().width; },
  };

  return (
    <box flexDirection="column" flexGrow={1} live={true}>
      <box paddingLeft={1} flexGrow={0}>
        <text fg={C.accent} attributes={TextAttributes.BOLD}>herdr-beads</text>
        <text fg={C.dim}> · primary shell prototype · </text>
        <text fg={C.running}>{TICKETS.filter((t) => listState(t) === "running").length} running</text>
        <text fg={C.dim}> · </text>
        <text fg={C.attention} attributes={TextAttributes.BOLD}>{ATTENTION.length} your-turn</text>
      </box>

      {variant().render(nav)}

      <box border={true} borderColor={C.focusBorder} paddingLeft={1} flexGrow={0} flexDirection="row">
        <text fg={C.accent} attributes={TextAttributes.BOLD}>{"◀ [ ▶  "}</text>
        <text fg={C.title} attributes={TextAttributes.BOLD}>
          {`${variant().key} — ${variant().name} (${vIdx() + 1}/${VARIANTS.length})`}
        </text>
        <text fg={C.dim}>{"   [/] or 1/2/3 switch · Tab region · j/k move · Enter launch · q quit"}</text>
      </box>

      <For each={launched() ? [launched()!] : []}>
        {(l) => (
          <box paddingLeft={1} flexGrow={0}>
            <text fg={C.done} attributes={TextAttributes.BOLD}>{"↳ " + l}</text>
          </box>
        )}
      </For>
    </box>
  );
}

render(() => <App />);
