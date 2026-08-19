// Herdr client — a narrow wrapper over the `herdr` CLI (`HERDR_BIN_PATH`), the
// plugin's documented way to call back (issue 12, Seam 3 in the spec's Testing
// Decisions). The whole module talks to herdr through one **injectable runner**
// (`HerdrRunner`), so dispatch and state-poll are unit-tested against recorded
// CLI fixtures (canned `agent list` JSON, `agent read` snapshots) with no live
// herdr server. Production uses `makeProcessRunner(HERDR_BIN_PATH)`.
//
// Surface (mirrors wayfinder's `herdr.rs`): tab create → `agent start --kind
// --pane [-- <model args>]` → prompt via the **prompt-API shim** (introspects
// `herdr api schema` to branch between the older `agent prompt` and the newer
// `agent send` + `pane send-keys enter`); poll `agent list`, read snapshots.
// The `AgentRecord` / `AgentStatus` vocabulary lives in ./types.ts (card 4) so
// the pure rule layer never reads types from this IO module.

import type { AgentRecord, AgentStatus } from "#/services/herdr/types.js";

/** One herdr CLI invocation's outcome. */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** The injectable seam: run one `herdr <args...>` vector. */
export type HerdrRunner = (args: string[]) => Promise<RunResult>;

/** A typed wrapper error carrying the failing arg vector. */
export class HerdrError extends Error {
  constructor(
    public readonly args: string[],
    message: string,
    public readonly stderr: string = "",
  ) {
    super(message);
    this.name = "HerdrError";
  }
}

/** Options for {@link HerdrClient.waitForShell} — the gate that lets a
 *  freshly-created tab's shell reach its prompt before `agent start`. */
export interface WaitForShellOptions {
  /** Rust-regex matching a shell-prompt line. Defaults to
   *  {@link DEFAULT_PROMPT_REGEX}. */
  pattern?: string;
  /** How long to keep polling before failing. Defaults to
   *  {@link DEFAULT_SHELL_READY_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/**
 * The default shell-prompt regex: a prompt-suffix character at line end. Matches
 * fish/starship `❯`, zsh `%`, bash/zsh `$`/`#`, and `> ` without matching
 * rc-file output mid-line. `pane wait-output` matches per line.
 */
export const DEFAULT_PROMPT_REGEX = "[❯➜$#%>]\\s*$";

/** Default window for the fresh tab's shell to reach its prompt. */
export const DEFAULT_SHELL_READY_TIMEOUT_MS = 30_000;

/** Build the `agent start` vector for a profile dispatch. */
export interface StartOptions {
  /** Agent session name (later the prompt target). */
  name: string;
  /** The agent kind from the profile (one of herdr's 21 kinds). */
  kind: string;
  /** Existing pane at a shell prompt (`herdr tab create`'s root pane). */
  pane: string;
  /** Profile model passed raw after `--` — 1:1 with herdr's passthrough. */
  args?: string[];
  timeoutMs?: number;
}

/**
 * Options for {@link HerdrClient.showNotification}. The toast's title is the
 * one required positional; the rest mirror herdr's `notification show` flags
 * (research 01 §4). `sound: "request"` is the natural fit for the
 * ready-for-human / agent-blocked handoff beat.
 */
export interface ShowNotificationOptions {
  /** The toast title — the single required positional (`notification show <TITLE>`). */
  title: string;
  body?: string;
  sound?: "none" | "done" | "request";
}

/**
 * `agent start <name> --kind <kind> --pane <pane> [-- <args>]`. On the older
 * `argv` variant of the schema the kind moves into the passthrough args
 * (`-- <kind> <args>`), mirroring wayfinder's portability shim (research 01 §2).
 */
export function agentStartVector(o: StartOptions, api: "kind" | "argv" = "kind"): string[] {
  const v =
    api === "kind"
      ? ["agent", "start", o.name, "--kind", o.kind, "--pane", o.pane]
      : ["agent", "start", o.name, "--pane", o.pane];
  if (o.timeoutMs != null) v.push("--timeout", String(o.timeoutMs));
  const passthrough = api === "argv" ? [o.kind, ...(o.args ?? [])] : (o.args ?? []);
  if (passthrough.length > 0) v.push("--", ...passthrough);
  return v;
}

/** Spawn `$HERDR_BIN_PATH` as a child and capture stdout/stderr + exit code. */
export function makeProcessRunner(binPath: string): HerdrRunner {
  return async (args: string[]) => {
    const proc = Bun.spawn([binPath, ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { code, stdout, stderr };
  };
}

export class HerdrClient {
  private readonly runner: HerdrRunner;
  private schemaJson: unknown | null | undefined; // undefined = not yet fetched
  private startApi: "kind" | "argv" | undefined;
  private promptApi: "send" | "prompt" | undefined;

  constructor(opts: { runner: HerdrRunner }) {
    this.runner = opts.runner;
  }

  // --- raw exec ------------------------------------------------------------

  /** Run a vector; throw `HerdrError` on a non-zero exit. Returns stdout. */
  private async run(args: string[]): Promise<string> {
    const res = await this.runner(args);
    if (res.code !== 0) {
      const tail = (res.stderr || res.stdout).slice(0, 400);
      throw new HerdrError(args, `herdr ${args.join(" ")} exited ${res.code}: ${tail}`, res.stderr);
    }
    return res.stdout;
  }

  /** Run a JSON-producing vector and return its `result`, typed. */
  private async call<T = unknown>(args: string[]): Promise<T> {
    const stdout = await this.run(args);
    let parsed: { result?: T };
    try {
      parsed = JSON.parse(stdout) as { result?: T };
    } catch {
      throw new HerdrError(args, `herdr ${args.join(" ")} did not return JSON: ${stdout.slice(0, 300)}`);
    }
    if (parsed.result === undefined) {
      throw new HerdrError(args, `herdr ${args.join(" ")} returned no result: ${stdout.slice(0, 300)}`);
    }
    return parsed.result;
  }

  // --- schema introspection (the shim's inputs) ----------------------------

  /** The parsed `herdr api schema --json`, cached; null when it can't be read. */
  private async schema(): Promise<unknown | null> {
    if (this.schemaJson === undefined) {
      try {
        this.schemaJson = JSON.parse(await this.run(["api", "schema", "--json"]));
      } catch {
        this.schemaJson = null;
      }
    }
    return this.schemaJson;
  }

  /**
   * `AgentStartParams` properties, per the live schema. Distinguishes the
   * `--kind` variant (>= the wayfinder port) from the older `argv` variant.
   */
  async detectStartApi(): Promise<"kind" | "argv"> {
    if (this.startApi) return this.startApi;
    const props = await this.schemaProps("AgentStartParams");
    this.startApi = props && "kind" in props ? "kind" : "argv";
    return this.startApi;
  }

  /**
   * The prompt-API shim's decision: newer schemas expose `AgentSendParams`
   * (`agent send` + `pane send-keys enter`); older ones fall back to
   * `agent prompt`. Same detection as the reference wayfinder plugin.
   */
  async detectPromptApi(): Promise<"send" | "prompt"> {
    if (this.promptApi) return this.promptApi;
    const props = await this.schemaProps("AgentSendParams");
    this.promptApi = props && "text" in props ? "send" : "prompt";
    return this.promptApi;
  }

  /** A schema def's `properties`, or null when the def is absent. */
  async schemaProps(def: string): Promise<Record<string, unknown> | null> {
    const s = (await this.schema()) as
      | { schemas?: { request?: { $defs?: Record<string, { properties?: Record<string, unknown> }> } } }
      | null;
    return s?.schemas?.request?.$defs?.[def]?.properties ?? null;
  }

  // --- agents (state-poll) -------------------------------------------------

  /** `herdr agent list` → records (the ~2s poll's state source). */
  async listAgents(): Promise<AgentRecord[]> {
    const result = await this.call<{ agents?: AgentRecord[] }>(["agent", "list"]);
    return result.agents ?? [];
  }

  /** The `agent_status` for one pane, or "unknown" when no agent owns it. */
  async agentStatusByPane(paneId: string): Promise<AgentStatus> {
    const rec = (await this.listAgents()).find((a) => a.pane_id === paneId);
    return rec?.agent_status ?? "unknown";
  }

  /** `herdr agent read` snapshot → the stripped terminal text. */
  async readAgent(target: string, lines?: number): Promise<string> {
    const args = ["agent", "read", target];
    if (lines != null) args.push("--lines", String(lines));
    const result = await this.call<{ read?: { text?: string } }>(args);
    return result.read?.text ?? "";
  }

  // --- dispatch ------------------------------------------------------------

  /** `herdr tab create` → the tab + root pane the agent will land in. */
  async createTab(o: { cwd: string; label: string; focus?: boolean }): Promise<{ tabId: string; paneId: string }> {
    const args = ["tab", "create", "--cwd", o.cwd, "--label", o.label];
    args.push(o.focus ? "--focus" : "--no-focus");
    const result = await this.call<{ tab?: { tab_id?: string }; root_pane?: { pane_id?: string } }>(args);
    const tabId = result.tab?.tab_id;
    const paneId = result.root_pane?.pane_id;
    if (typeof tabId !== "string" || typeof paneId !== "string") {
      throw new HerdrError(args, `herdr tab create did not return tab/root_pane ids`);
    }
    return { tabId, paneId };
  }

  /** `herdr tab close <tab_id>` — closes the tab (and its panes) a dispatch spawned. */
  async closeTab(tabId: string): Promise<void> {
    await this.run(["tab", "close", tabId]);
  }

  /**
   * `herdr notification show <title> [--body --sound]` — the
   * ready-for-human / agent-blocked handoff toast (issue 13). herdr exposes
   * only `show` (no list/dismiss/mute), so this is fire-and-forget. The title
   * is one positional arg (no shell quoting concerns — the runner execs the
   * vector directly, never through a shell).
   */
  async showNotification(o: ShowNotificationOptions): Promise<void> {
    const args = ["notification", "show", o.title];
    if (o.body != null) args.push("--body", o.body);
    if (o.sound != null) args.push("--sound", o.sound);
    await this.run(args);
  }

  /**
   * Wait until the pane's shell is at its prompt (`pane wait-output` — matches
   * existing output immediately, then polls the pane). herdr 0.8.0's `agent
   * start` pre-checks "available shell" synchronously and fast-fails a freshly
   * created tab's still-initializing shell with `agent_pane_busy` / "not an
   * available shell" — its `--timeout` only covers post-launch interactive
   * readiness, not this pre-check (validated live). So the prompt must be seen
   * HERE, before {@link startAgent}. Throws when `pane wait-output` exits
   * non-zero (e.g. the pane never reaches a prompt within `timeoutMs`).
   */
  async waitForShell(paneId: string, o: WaitForShellOptions = {}): Promise<void> {
    const args = [
      "pane", "wait-output", paneId,
      "--regex", o.pattern ?? DEFAULT_PROMPT_REGEX,
      "--source", "recent",
      "--timeout", String(o.timeoutMs ?? DEFAULT_SHELL_READY_TIMEOUT_MS),
    ];
    await this.run(args);
  }

  /**
   * Start the agent in a pane: `agent start`, shaped to the server's schema.
   * herdr expects the pane to ALREADY be at its interactive shell prompt — the
   * `--timeout` here only bounds the post-launch wait for the agent to render
   * its TUI; it does NOT cover a still-initializing shell (that fast-fails with
   * `agent_pane_busy`). Dispatch therefore calls {@link waitForShell} on the
   * freshly-created tab's pane first. Defaults `timeoutMs` to 120s (matches the
   * reference wayfinder driver's hard-coded 120s, `herdr.rs agent_start_kind`);
   * an explicit `o.timeoutMs` overrides it.
   */
  async startAgent(o: StartOptions): Promise<void> {
    const api = await this.detectStartApi();
    const opts: StartOptions = { ...o, timeoutMs: o.timeoutMs ?? 120_000 };
    await this.run(agentStartVector(opts, api));
  }

  /**
   * Prompt a running agent. Branches on the detected schema: newer → `agent
   * send` + `pane send-keys enter`; older → `agent prompt`. Both paths run
   * strictly — a failed send surfaces as a failed dispatch rather than a
   * silent no-op.
   */
  async prompt(target: string, text: string, paneId?: string): Promise<void> {
    const api = await this.detectPromptApi();
    if (api === "send") {
      await this.run(["agent", "send", target, text]);
      if (paneId) await this.run(["pane", "send-keys", paneId, "enter"]);
    } else {
      await this.run(["agent", "prompt", target, text]);
    }
  }
}