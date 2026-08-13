// Tests for the herdr prefix claim (issue 09 acceptance):
//   - isHerdrPrefix is a pure predicate (unit).
//   - Registering claimHerdrPrefix makes a renderer consume ctrl+a before key
//     dispatch, so a useKeyboard handler never sees it — while normal keys still
//     pass through. Verified through the real OpenTUI renderer via testRender:
//     useKeyboard subscribes to `renderer.keyInput "keypress"`, which is only
//     emitted from `processParsedKey` — the call our prepend handler skips.

import { describe, it, expect } from "bun:test";
import { testRender } from "@opentui/solid";
import { HERDR_PREFIX, isHerdrPrefix, claimHerdrPrefix } from "./prefix.js";

describe("isHerdrPrefix (unit)", () => {
  it("is true for the ctrl+a prefix byte and false for everything else", () => {
    expect(isHerdrPrefix(HERDR_PREFIX)).toBe(true);
    expect(isHerdrPrefix("\x01")).toBe(true);
    expect(isHerdrPrefix("a")).toBe(false);
    expect(isHerdrPrefix("ctrl+a")).toBe(false); // not the raw byte
    expect(isHerdrPrefix("\x03")).toBe(false); // ctrl+c, not ours
    expect(isHerdrPrefix("")).toBe(false);
  });
});

describe("claimHerdrPrefix (integration via testRender)", () => {
  it("claims ctrl+a before key dispatch yet lets other keys through", async () => {
    const seen: string[] = [];

    const setup = await testRender(() => <text>prefix test</text>);
    await setup.flush();

    // Listen at the key-dispatch layer (what `useKeyboard` subscribes to).
    setup.renderer.keyInput.on("keypress", (event: { name?: string; ctrl?: boolean }) => {
      seen.push(event.ctrl && event.name ? `ctrl+${event.name}` : (event.name ?? "?"));
    });
    // Claim the prefix exactly as the TUI entry point does.
    claimHerdrPrefix(setup.renderer);

    setup.mockInput.pressKey("a", { ctrl: true }); // claimed → never dispatched
    setup.mockInput.pressKey("j");                  // ordinary key → dispatched
    await setup.flush();

    expect(seen).toContain("j");
    expect(seen).not.toContain("ctrl+a");

    setup.renderer.destroy();
  });
});
