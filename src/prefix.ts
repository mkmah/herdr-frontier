// herdr prefix reconciliation (issue 09 acceptance).
//
// herdr's tmux-style prefix is `ctrl+a` (see `~/.config/herdr/config.toml`).
// When our OpenTUI pane is focused it owns raw stdin, so we must stop OpenTUI
// from acting on `ctrl+a` — keeping the prefix reserved for herdr. We claim it
// with a `prependInputHandler`, which runs at index 0 of the renderer's
// `sequenceHandlers` and, by returning true, short-circuits key dispatch:
//
//   // @opentui/core renderer, handleStdinEvent "key" case:
//   if (this.dispatchSequenceHandlers(event.raw)) return;   // ← our handler wins
//   this._keyHandler.processParsedKey(event.key);           // ← useKeyboard never sees it
//
// `ctrl+a` arrives on the wire as a single `\x01` byte.

import type { CliRenderer } from "@opentui/core";

/** The raw byte sequence herdr's prefix produces. */
export const HERDR_PREFIX = "\x01";

/** True only for herdr's `ctrl+a` prefix byte. Pure — unit-tested directly. */
export function isHerdrPrefix(sequence: string): boolean {
  return sequence === HERDR_PREFIX;
}

/**
 * Register a renderer input handler that claims `ctrl+a` before OpenTUI's own
 * key dispatch. Returns a disposer that removes the handler.
 */
export function claimHerdrPrefix(renderer: CliRenderer): () => void {
  const handler = (sequence: string): boolean => isHerdrPrefix(sequence);
  renderer.prependInputHandler(handler);
  return () => renderer.removeInputHandler(handler);
}
