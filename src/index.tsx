// ============================================================================
// herdr-beads pane entry point (issue 09).
//
// herdr spawns this as the `command` of the `beads.issues` `[[panes]]` entry.
// It builds the local-markdown provider from the workspace cwd, claims herdr's
// ctrl+a prefix so it stays reserved, and renders the read-only Issue list.
// Issue 12 adds manual dispatch: the herdr client shells out through
// `$HERDR_BIN_PATH` (injected by herdr; `herdr` on PATH in dev), and the
// DispatchCoordinator claims each Issue before dispatching it to a pane.
// Run standalone:  bun run src/index.tsx
// ============================================================================

import { render, useRenderer } from "@opentui/solid";
import { onMount } from "solid-js";
import { LocalMarkdownProvider } from "./tracker/local-markdown.js";
import { App } from "./App.js";
import { claimHerdrPrefix } from "./prefix.js";
import { HerdrClient, makeProcessRunner } from "./herdr-client.js";
import { ClaimRegistry, DispatchCoordinator } from "./dispatch.js";
import { DEFAULT_PROFILES } from "./profiles.js";

const repoRoot = process.cwd();
const provider = new LocalMarkdownProvider({ repoRoot });
const binPath = process.env.HERDR_BIN_PATH ?? "herdr";
const client = new HerdrClient({ runner: makeProcessRunner(binPath) });
const dispatchCoordinator = new DispatchCoordinator({
  client,
  provider,
  profiles: DEFAULT_PROFILES,
  claims: new ClaimRegistry(),
  cwd: repoRoot,
});

function Root() {
  // Claim ctrl+a on mount — before OpenTUI's own key dispatch (see prefix.ts).
  const renderer = useRenderer();
  onMount(() => claimHerdrPrefix(renderer));

  return (
    <App
      provider={provider}
      dispatchCoordinator={dispatchCoordinator}
      onQuit={() => renderer.destroy()}
    />
  );
}

void render(() => <Root />);
