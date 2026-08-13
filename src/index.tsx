// ============================================================================
// herdr-beads pane entry point (issue 09).
//
// herdr spawns this as the `command` of the `beads.issues` `[[panes]]` entry.
// It builds the local-markdown provider from the workspace cwd, claims herdr's
// ctrl+a prefix so it stays reserved, and renders the read-only Issue list.
// Run standalone:  bun run src/index.tsx
// ============================================================================

import { render, useRenderer } from "@opentui/solid";
import { onMount } from "solid-js";
import { LocalMarkdownProvider } from "./tracker/local-markdown.js";
import { App } from "./App.js";
import { claimHerdrPrefix } from "./prefix.js";

const repoRoot = process.cwd();

function Root() {
  // Claim ctrl+a on mount — before OpenTUI's own key dispatch (see prefix.ts).
  const renderer = useRenderer();
  onMount(() => claimHerdrPrefix(renderer));

  return (
    <App
      provider={new LocalMarkdownProvider({ repoRoot })}
      onQuit={() => renderer.destroy()}
    />
  );
}

void render(() => <Root />);
