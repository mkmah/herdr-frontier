// ============================================================================
// Copy-on-select (mirrors opencode's approach).
//
// herdr does NOT copy-on-select for mouse-reporting panes: any OpenTUI app
// reports mouse by default (?1000h ?1002h ?1003h ?1006h), so herdr forwards
// drags into the app instead of anchoring its own selection. opencode therefore
// implements copy-on-select in-app — on mouse-up it reads OpenTUI's renderer
// selection, writes it via OSC 52, and clears the selection. herdr intercepts
// the OSC 52 write, sets the system clipboard, and shows its toast.
//
// OpenTUI builds the selection automatically: Text renderables are `selectable`
// by default, so a left-drag over text anchors and extends a selection; on
// release `renderer.getSelection()?.getSelectedText()` yields the dragged text.
// Mouse events bubble to ancestors (Renderable.processMouseEvent walks parents),
// so a single root-level onMouseUp catches releases over any child.
// ============================================================================

import type { CliRenderer } from "@opentui/core";

/**
 * Copy the current renderer selection to the clipboard. Returns true when text
 * was copied (i.e. the release ended a non-empty drag selection), false for a
 * bare click (no selected text) so callers can keep treating clicks as clicks.
 */
export function copySelection(renderer: CliRenderer): boolean {
  const text = renderer.getSelection()?.getSelectedText();
  if (!text) return false;
  if (!renderer.copyToClipboardOSC52(text)) {
    // The terminal didn't advertise OSC 52 support — write the sequence
    // directly to stdout (what opencode does); herdr still intercepts it.
    process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
  }
  renderer.clearSelection();
  return true;
}
