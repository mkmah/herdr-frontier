// ============================================================================
// herdr-frontier pane entry point (issue 09).
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
import { join } from "node:path";
import { LocalMarkdownProvider } from "./tracker/local-markdown.js";
import { App } from "./App.js";
import { claimHerdrPrefix } from "./prefix.js";
import { HerdrClient, makeProcessRunner } from "./herdr-client.js";
import { ClaimRegistry, DispatchCoordinator } from "./dispatch.js";
import { RunController, FileRunStore, pluginStateDir } from "./run.js";
import { loadPluginConfig } from "./config.js";
import { TranscriptIngester } from "./transcript.js";
import { PLUGIN_CONTEXT_KEY, resolveRepoRoot } from "./workspace.js";

// The workspace herdr opened the pane against (its `workspace_cwd` from
// HERDR_PLUGIN_CONTEXT_JSON), not the pane's process cwd — herdr runs plugin
// panes from the plugin root, so cwd alone would scan the plugin's own dir for
// `.scratch/*/issues/` and find nothing. Standalone (`bun run src/index.tsx`) is
// cwd, as before.
const repoRoot = resolveRepoRoot(process.cwd(), process.env[PLUGIN_CONTEXT_KEY]);
const provider = new LocalMarkdownProvider({ repoRoot });
const binPath = process.env.HERDR_BIN_PATH ?? "herdr";
const client = new HerdrClient({ runner: makeProcessRunner(binPath) });
// Issue 17: the plugin config — two TOML layers (user + repo), merged with
// repo > user precedence. Profiles drive the dispatch kind/model; the
// `transcripts:` block configures the finished-run extractor per agent kind.
// Issue 04 (confirmation gate): the merged `[confirm]` policy flows to the
// shell as its bypass prop — `false` per action suppresses that action's gate.
const config = loadPluginConfig({ repoRoot });
const dispatchCoordinator = new DispatchCoordinator({
  client,
  provider,
  profiles: config.profiles,
  claims: new ClaimRegistry(),
  cwd: repoRoot,
});
// Issue 14: the automated run-controller — same provider, same shared claim
// mutex (the coordinator's ClaimRegistry), state persisted under the plugin
// state dir so a crashed controller rehydrates the same runs on restart.
// Issue 17: the transcript ingester writes each finished run's output back.
const runController = new RunController({
  provider,
  coordinator: dispatchCoordinator,
  store: new FileRunStore({ dir: join(pluginStateDir(), "runs") }),
  transcripts: new TranscriptIngester({ client, provider, repoRoot, config: config.transcripts }),
});

function Root() {
  // Claim ctrl+a on mount — before OpenTUI's own key dispatch (see prefix.ts).
  const renderer = useRenderer();
  onMount(() => claimHerdrPrefix(renderer));

  return (
    <App
      provider={provider}
      dispatchCoordinator={dispatchCoordinator}
      runController={runController}
      confirmPolicy={config.confirm}
      onQuit={() => renderer.destroy()}
    />
  );
}

void render(() => <Root />);
