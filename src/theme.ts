// Cross-view theme — the single source of truth for herdr-beads' look (issue 10).
//
// Locked by prototype 08: one semantic palette (surface/border/state/text/accent)
// + typography roles (h1/h2/label/body/meta) drive the header, list, detail, and
// footer. Every view reads these tokens; change one value here → the whole app
// re-themes. State colors follow prototype 06's lock: done green, running gold,
// blocked red, frontier cyan, human orange. There is no central OpenTUI theme
// object (research 02), so this module IS our theme.

import { TextAttributes } from "@opentui/core";
import type { Issue } from "./tracker/provider.js";
import type { ListState } from "./display.js";
import { isHumanTurn, listStateOf } from "./display.js";

export const THEME = {
  surface: { bg: "#171b26", panel: "#1e2433" },
  border: { focused: "#7aa2f7", idle: "#3b4252" },
  state: {
    done: "#06d6a0", // green — resolved / complete
    running: "#e9b94e", // gold — claimed, agent on it
    blocked: "#ef476f", // red — unresolved blocker
    frontier: "#48cae4", // cyan — open ∧ unclaimed ∧ unblocked
    human: "#f8961e", // orange — your turn
    humanPulse: "#ffd166", // soft gold — the attention pulse's bright phase
  },
  text: { title: "#e8eef5", body: "#c5cee0", dim: "#5c6678", dimmer: "#434a5c" },
  accent: { brand: "#7aa2f7", id: "#88c0d0", triage: "#bb9af7" },
  // Typography roles — color + weight. Every view renders titles/labels/body/meta
  // through these so type treatment is consistent and lives in one place.
  role: {
    h1: { fg: "#e8eef5", attr: TextAttributes.BOLD },
    h2: { fg: "#7aa2f7", attr: TextAttributes.BOLD },
    label: { fg: "#5c6678", attr: 0 },
    body: { fg: "#c5cee0", attr: 0 },
    meta: { fg: "#5c6678", attr: 0 },
  },
  selBg: "#2e3a52",
} as const;

export type StateKey = ListState | "human";

/** The theme's color for a list state (done/running/blocked/frontier/human). */
export function stateColor(state: StateKey): string {
  return THEME.state[state];
}

/**
 * The icon color for an issue's state glyph — same precedence as the glyph
 * itself (done > human > running > blocked > frontier). `pulse` flips a
 * human-turn icon between orange and soft-gold to draw the eye (prototype 06).
 */
export function iconColorFor(
  issue: Issue,
  isResolved: (id: string) => boolean,
  pulse: boolean,
): string {
  const s = listStateOf(issue, isResolved);
  if (s === "done") return stateColor("done");
  if (isHumanTurn(issue)) return pulse ? THEME.state.humanPulse : stateColor("human");
  return stateColor(s);
}
