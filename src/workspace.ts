// The pane's repo root, resolved from herdr's pane context (issue: installed
// panes always run with the *plugin root* as cwd — herdr's plugin-pane contract —
// so `process.cwd()` would scan the plugin's own dir for `.scratch/*/issues/`
// and find nothing). herdr injects the originating workspace in
// `HERDR_PLUGIN_CONTEXT_JSON` (the same shape the herdr SDK's `PluginContext`
// serializes): `workspace_cwd` is the repo the pane was opened against,
// `focused_pane_cwd` the focused pane's cwd at open time. Whichever is present,
// the workspace root wins over the plugin root; standalone runs fall back to
// the process cwd.

export const PLUGIN_CONTEXT_KEY = "HERDR_PLUGIN_CONTEXT_JSON";

/** The herdr SDK `PluginContext` fields we read. */
export interface PluginContextJson {
  workspace_cwd?: string;
  focused_pane_cwd?: string;
}

/** The repo root the pane should read issues from: the herdr-launched
 *  workspace root, else `process.cwd()`. A malformed/absent context falls back
 *  to cwd — the plugin root only ever wins when nothing better is available. */
export function resolveRepoRoot(cwd: string, contextJson: string | undefined): string {
  if (contextJson) {
    try {
      const ctx = JSON.parse(contextJson) as PluginContextJson;
      const root = ctx.workspace_cwd ?? ctx.focused_pane_cwd;
      if (root && root.trim() !== "") return root;
    } catch {
      // malformed context — treat as absent
    }
  }
  return cwd;
}