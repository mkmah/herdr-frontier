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

/** One herdr CLI invocation's outcome. */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** The injectable seam: run one `herdr <args...>` vector. */
export type HerdrRunner = (args: string[]) => Promise<RunResult>;

/** A spawned-pane agent record parsed from `herdr agent list` JSON. */
export interface AgentRecord {
  agent: string;
  agent_status: AgentStatus;
  pane_id?: string;
  tab_id?: string;
  cwd?: string;
}

/** herdr's `agent_status` vocabulary (research 01). */
export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

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
   * Start the agent in a pane: `agent start`, shaped to the server's schema.
   * Defaults `timeoutMs` to 120s: `agent start` requires the pane to be at its
   * interactive shell prompt, and a freshly-created tab's shell (with a heavy
   * docker/nvm/pyenv init) can exceed herdr's own 30s default — failing with
   * `agent_pane_busy` / "not an available shell". The reference wayfinder driver
   * hard-codes 120s (`herdr.rs agent_start_kind`); an explicit `o.timeoutMs`
   * overrides it.
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