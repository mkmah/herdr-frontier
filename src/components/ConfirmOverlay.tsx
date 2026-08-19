// The confirmation overlay (confirmation-gate 05) — the centered modal a
// Confirmable action paints over the whole shell while a dialog is open. The
// dim cover is absolute + zIndex 10 and spans the full screen, so it layers
// above both panes and the footer and nothing under it can take a click; its
// mouse handlers swallow (a click on the dim layer does nothing). Inside, a
// bordered panel carries the rulebook's shape (domain/confirm) — title, context
// line, body, and the `[ Cancel  Confirm ]` row — with the focused button
// marked. Pure display: App feeds the dialog, the focused button, and the
// terminal width (for the panel's cap); the buttons' handlers are App's.
//
// Keyed by App (its `modalKey`) so every focus move remounts — OpenTUI 0.5.1
// doesn't repaint in place.

import { type Component, For } from "solid-js";
import { TextAttributes, type MouseEvent } from "@opentui/core";
import type { ConfirmButton, ConfirmDialog } from "#/lib/confirm.js";
import { MouseButton } from "#/lib/display.js";
import { THEME } from "#/lib/theme.js";
import { RoleText } from "#/components/RoleText.js";

export interface ConfirmOverlayProps {
  dialog: ConfirmDialog;
  focus: ConfirmButton;
  onCancel: () => void;
  onConfirm: () => void;
  /** The terminal width driving the panel's width cap. */
  terminalWidth: number;
}

export const ConfirmOverlay: Component<ConfirmOverlayProps> = ({ dialog: d, focus, onCancel, onConfirm, terminalWidth }) => {
  const swallow = (e: MouseEvent) => e.stopPropagation();
  // The modal width caps sentence-length bodies to a couple of wrapped lines
  // inside the fixed-width panel; the panel stays clear of the shell's edges.
  const modalW = () => Math.max(40, Math.min(72, terminalWidth - 8));
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