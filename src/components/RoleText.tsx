// Shared display widgets — the typography-role text and the triage chip. Both
// render exclusively through THEME roles/tokens so a palette change re-themes
// the whole shell. Extracted with the render-layer decomposition (architecture
// review 2026-08, card 3): App, DetailPane, ListPane, TreePane, and the
// ConfirmOverlay all paint through these.

import type { Component } from "solid-js";
import { TextAttributes } from "@opentui/core";
import { THEME, triageColor } from "#/lib/theme.js";

/** Typography-role text — titles/labels/body/meta render through THEME.role. */
export const RoleText: Component<{ role: keyof typeof THEME["role"]; children: any; flexGrow?: number }> = (p) => {
  const r = THEME.role[p.role];
  return <text fg={r.fg} attributes={r.attr} flexGrow={p.flexGrow}>{p.children}</text>;
};

/** Chip background for a canonical label — wayfinder → brand, else the triage palette. */
export function Chip(props: { label: string }) {
  return (
    <box backgroundColor={triageColor(props.label)} paddingLeft={1} paddingRight={1} marginRight={1}>
      <text fg={THEME.surface.onAccent} attributes={TextAttributes.BOLD}>{props.label}</text>
    </box>
  );
}