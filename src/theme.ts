// Cross-view theme — the single source of truth for herdr-frontier' look (issue 10).
//
// Locked by prototype 08: one semantic palette (surface/border/state/text/accent)
// + typography roles (h1/h2/label/body/meta) drive the header, list, detail, and
// footer. Every view reads these tokens; change one value here → the whole app
// re-themes. State colors follow prototype 06's lock: done green, running gold,
// blocked red, frontier cyan, human orange. There is no central OpenTUI theme
// object (research 02), so this module IS our theme.

import { TextAttributes } from "@opentui/core";
import type { ListState } from "./display.js";

const surface = { bg: "#171b26", panel: "#1e2433", onAccent: "#11151c" };
const border = { focused: "#7aa2f7", idle: "#3b4252" };
const state = {
  done: "#06d6a0", // green — resolved / complete
  running: "#e9b94e", // gold — claimed, agent on it
  blocked: "#ef476f", // red — unresolved blocker
  frontier: "#48cae4", // cyan — open ∧ unclaimed ∧ unblocked
  human: "#f8961e", // orange — your turn
  humanPulse: "#ffd166", // soft gold — the attention pulse's bright phase
};
const text = { title: "#e8eef5", body: "#c5cee0", dim: "#5c6678", dimmer: "#434a5c" };
const accent = { brand: "#7aa2f7", id: "#88c0d0", triage: "#bb9af7" };

// Triage-role chip colors, aliased to the semantic palette so a palette change
// re-themes the chips too (one source of truth).
const triageColorMap: Record<string, string> = {
  "ready-for-agent": state.frontier,
  "ready-for-human": state.human,
  "needs-info": accent.triage,
  "needs-triage": accent.triage,
  "wontfix": state.blocked,
};
const TRIAGE_DEFAULT = text.dim;

// Typography roles — color + weight. Every view renders titles/labels/body/meta
// through these so type treatment is consistent and lives in one place.
const role = {
  h1: { fg: text.title, attr: TextAttributes.BOLD },
  h2: { fg: accent.brand, attr: TextAttributes.BOLD },
  label: { fg: text.dim, attr: 0 },
  body: { fg: text.body, attr: 0 },
  meta: { fg: text.dim, attr: 0 },
};

export const THEME = {
  surface,
  border,
  state,
  text,
  accent,
  role,
  triage: triageColorMap,
  selBg: "#2e3a52",
} as const;

/** Chip/triage background for a canonical label: wayfinder → brand, else the triage palette. */
export function triageColor(label: string): string {
  return label.startsWith("wayfinder:") ? accent.brand : (triageColorMap[label] ?? TRIAGE_DEFAULT);
}

export type StateKey = ListState | "human";

/** The theme's color for a list state or the human-turn state. */
export function stateColor(state: StateKey): string {
  return THEME.state[state];
}

/**
 * The icon's color for a resolved icon state. `pulse` flips a human-turn icon
 * between orange and soft-gold to draw the eye (prototype 06); every other
 * state is a plain stateColor lookup.
 */
export function iconColor(state: StateKey, pulse: boolean): string {
  return state === "human" && pulse ? THEME.state.humanPulse : stateColor(state);
}
