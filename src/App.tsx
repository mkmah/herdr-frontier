// ============================================================================
// The read-only Issue list — herdr-beads' first real pane (issue 09).
//
// Renders every Issue from a TrackerProvider, grouped by run-root (the effort
// directory encoded in each id). This is the tracer-bullet UI: it proves an
// OpenTUI/Solid app renders inside a herdr pane, the prefix is claimed, and the
// provider feeds real data. No detail pane, no dispatch, no live agent state —
// those land in later issues (10+).
//
// Keys:  j/k move · r reload · q/Esc quit
//
// Note: all presentation logic (grouping, triage, cursor) lives in ./logic.ts
// so it is unit-testable; this file is the thin Solid render layer.
// ============================================================================

import { createSignal, createMemo, For, onMount, type Component } from "solid-js";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import type { Issue, TrackerProvider } from "./tracker/provider.js";
import {
  buildRows,
  issueNum,
  moveCursor,
  sortIssues,
  statusColor,
  statusGlyph,
  triageColor,
  triageOf,
  trunc,
} from "./logic.js";

// Saturated Nord-ish palette — shared with the prototypes for a cohesive look.
const C = {
  bg: "#171b26",
  brand: "#7aa2f7",
  id: "#88c0d0",
  triage: "#bb9af7",
  title: "#e8eef5",
  body: "#c5cee0",
  dim: "#5c6678",
  dimmer: "#434a5c",
  edge: "#3b4252",
  selBg: "#2e3a52",
  blocked: "#ef476f",
};

export interface AppProps {
  provider: TrackerProvider;
  /** Pre-loaded issues render synchronously (test seam); production omits it. */
  initialIssues?: Issue[];
  /** Called on q/Esc. Defaults to `process.exit(0)`; overridable for tests. */
  onQuit?: () => void;
}

export const App: Component<AppProps> = (props) => {
  const [issues, setIssues] = createSignal<Issue[]>(props.initialIssues ?? []);
  const [error, setError] = createSignal<string | null>(null);
  const [cursor, setCursor] = createSignal(0);
  const [loaded, setLoaded] = createSignal<boolean>(!!props.initialIssues);

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

  // Production auto-loads on mount. (The OpenTUI test renderer skips onMount,
  // so tests pass `initialIssues` to exercise the render synchronously.)
  if (!props.initialIssues) onMount(load);

  const rows = createMemo(() => buildRows({ issues: issues(), loaded: loaded(), error: error() }));
  const selected = () => issues()[cursor()];

  function move(dir: number) {
    setCursor((c) => moveCursor(c, dir, issues().length));
  }

  useKeyboard((key) => {
    if (key.name === "q" || key.name === "escape") (props.onQuit ?? (() => process.exit(0)))();
    else if (key.name === "j" || key.name === "down") move(1);
    else if (key.name === "k" || key.name === "up") move(-1);
    else if (key.name === "r") void load();
  });

  const openCount = () => issues().filter((i) => i.status === "open").length;

  const GroupHeader: Component<{ root: string; count: number }> = (p) => (
    <box flexDirection="row" paddingLeft={1} paddingTop={1}>
      <text fg={C.triage} attributes={TextAttributes.BOLD}>{`▸ ${p.root}`}</text>
      <text fg={C.dim}>{`  ${p.count}`}</text>
    </box>
  );

  const IssueLine: Component<{ issue: Issue; selected: boolean }> = (p) => {
    const triage = () => triageOf(p.issue);
    const blocked = () => p.issue.blockedBy.length;
    return (
      <box
        flexDirection="row"
        paddingLeft={2}
        paddingRight={1}
        backgroundColor={p.selected ? C.selBg : undefined}
      >
        <text fg={statusColor(p.issue.status)} attributes={TextAttributes.BOLD}>
          {statusGlyph(p.issue.status)}
        </text>
        <text fg={C.id}>{`${issueNum(p.issue.id)} `}</text>
        <text fg={p.selected ? C.title : C.body}>{trunc(p.issue.title, 52)}</text>
        <text fg={C.dimmer} flexGrow={1}> </text>
        <text fg={triageColor(triage())}>{triage()}</text>
        <text fg={C.dim}>{blocked() > 0 ? `  ⤓ ${blocked()}` : ""}</text>
      </box>
    );
  };

  return (
    <box flexDirection="column" flexGrow={1} live={true} backgroundColor={C.bg}>
      {/* header */}
      <box flexGrow={0} paddingLeft={1} paddingRight={1} flexDirection="row">
        <text fg={C.brand} attributes={TextAttributes.BOLD}>◆ herdr-beads</text>
        <text fg={C.dim}>  issues  </text>
        <text fg={C.title}>{issues().length}</text>
        <text fg={C.dim}>  ·  </text>
        <text fg={statusColor("open")}>{openCount()} open</text>
        <text fg={C.dimmer} flexGrow={1}> </text>
        <text fg={C.dim}>j/k move · r reload · q quit</text>
      </box>

      {/* list, grouped by run-root */}
      <box flexGrow={1} flexDirection="column" border={true} borderStyle="rounded" borderColor={C.edge}>
        <scrollbox flexGrow={1} scrollY={true}>
          <For each={rows()}>
            {(row) => {
              switch (row.kind) {
                case "error":
                  return <text fg={C.blocked} paddingLeft={1}>{` error: ${row.message}`}</text>;
                case "empty":
                  return <text fg={C.dim} paddingLeft={1}> no issues found under .scratch/*/issues/</text>;
                case "group":
                  return <GroupHeader root={row.root} count={row.count} />;
                case "issue":
                  return <IssueLine issue={row.issue} selected={selected()?.id === row.issue.id} />;
              }
            }}
          </For>
        </scrollbox>
      </box>

      {/* footer: selected detail line (always rendered so the box tree is stable) */}
      <box flexGrow={0} paddingLeft={1} paddingRight={1} flexDirection="row">
        <text fg={C.id}>{selected() ? `${issueNum(selected()!.id)} ` : ""}</text>
        <text fg={C.title} attributes={TextAttributes.BOLD}>
          {selected() ? trunc(selected()!.title, 60) : ""}
        </text>
        <text fg={C.dimmer} flexGrow={1}> </text>
        <text fg={C.dim}>
          {selected()
            ? `type: ${selected()!.type} · blocked by: ${selected()!.blockedBy.length ? selected()!.blockedBy.join(",") : "—"}`
            : ""}
        </text>
      </box>
    </box>
  );
};
