// Herdr-client tests (issue 12 acceptance — Seam 3 in the spec's Testing
// Decisions): dispatch and state-poll against recorded CLI fixtures through an
// **injectable runner** — no live herdr server. Covers the `agent start` vector
// built from a profile, parsing `agent_status` out of a canned `agent list` JSON,
// a canned `agent read` snapshot, tab creation, and the prompt-API shim branching
// on the detected `herdr api schema`.

import { describe, it, expect } from "bun:test";
import {
  HerdrClient,
  agentStartVector,
  type HerdrRunner,
  type StartOptions,
} from "./herdr-client.js";

// --- fixtures -------------------------------------------------------------

/** The real herdr 0.8.0 shape: `{ id, result: { agents: [...] } }`. */
const AGENT_LIST = JSON.stringify({
  id: "cli:agent:list",
  result: {
    agents: [
      {
        agent: "claude",
        agent_session: { agent: "claude", kind: "id", source: "herdr:claude", value: "ses_1" },
        agent_status: "blocked",
        cwd: "/repo/a",
        pane_id: "wW:p1",
        tab_id: "wW:t1",
      },
      {
        agent: "opencode",
        agent_session: { agent: "opencode", kind: "id", source: "herdr:opencode", value: "ses_2" },
        agent_status: "working",
        cwd: "/repo/b",
        pane_id: "wW:p7",
        tab_id: "wW:t3",
      },
      {
        agent: "opencode",
        agent_status: "idle",
        cwd: "/repo/c",
        pane_id: "wW:p9",
        tab_id: "wW:t4",
      },
    ],
  },
});

/** A canned `agent read` snapshot (the terminal-snapshot transcript source). */
const AGENT_READ = JSON.stringify({
  id: "cli:agent:read",
  result: { read: { text: "resolved 12 — claim then dispatch the driver" } },
});

const TAB_CREATE = JSON.stringify({
  id: "cli:tab:create",
  result: { tab: { tab_id: "wZ:t2" }, root_pane: { pane_id: "wZ:p3" } },
});

/** herdr 0.8.0's real schema (kind variant; no AgentSendParams). */
const SCHEMA_PROMPT_ONLY = JSON.stringify({
  schemas: {
    request: {
      $defs: {
        AgentStartParams: {
          properties: {
            args: { type: "array" },
            kind: { type: "string" },
            name: { type: "string" },
            pane_id: { type: "string" },
            timeout_ms: { type: "integer" },
          },
        },
      },
    },
  },
});

/** A newer schema where the prompt API is `agent send` (AgentSendParams). */
const SCHEMA_WITH_SEND = JSON.stringify({
  schemas: {
    request: {
      $defs: {
        AgentStartParams: {
          properties: {
            args: { type: "array" },
            kind: { type: "string" },
            name: { type: "string" },
            pane_id: { type: "string" },
            timeout_ms: { type: "integer" },
          },
        },
        AgentSendParams: { properties: { text: { type: "string" } } },
      },
    },
  },
});

/**
 * The injected-runner fixture: returns the recorded stdout for an exact arg
 * vector, records every invocation for assertions, and fails loudly on unknown
 * commands so a test proves it only drove the expected herdr surface.
 */
function fixtureRunner(fixtures: Record<string, string>): { runner: HerdrRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: HerdrRunner = async (args) => {
    calls.push(args);
    const stdout = fixtures[args.join(" ")];
    if (stdout === undefined) return { code: 1, stdout: "", stderr: `no fixture for: ${args.join(" ")}` };
    return { code: 0, stdout, stderr: "" };
  };
  return { runner, calls };
}

const START_OPTS: StartOptions = { name: "#12", kind: "opencode", pane: "wZ:p3", args: ["-m", "claude-sonnet-4-5"] };

// --- pure vector building ---------------------------------------------------

describe("agentStartVector", () => {
  it("builds `agent start <name> --kind <kind> --pane <pane>` and passes model args raw after `--`", () => {
    expect(agentStartVector(START_OPTS)).toEqual([
      "agent", "start", "#12", "--kind", "opencode", "--pane", "wZ:p3",
      "--", "-m", "claude-sonnet-4-5",
    ]);
  });

  it("omits `--` when the profile carries no args", () => {
    expect(agentStartVector({ name: "#12", kind: "claude", pane: "p1" })).toEqual([
      "agent", "start", "#12", "--kind", "claude", "--pane", "p1",
    ]);
  });

  it("includes --timeout when given", () => {
    expect(agentStartVector({ name: "#12", kind: "claude", pane: "p1", timeoutMs: 120000 })).toEqual([
      "agent", "start", "#12", "--kind", "claude", "--pane", "p1", "--timeout", "120000",
    ]);
  });
});

// --- agent list / state-poll ------------------------------------------------

describe("HerdrClient.listAgents (canned agent list JSON)", () => {
  it("parses result.agents with agent_status and pane_id", async () => {
    const { runner } = fixtureRunner({ "agent list": AGENT_LIST });
    const client = new HerdrClient({ runner });
    const agents = await client.listAgents();
    expect(agents.map((a) => [a.agent, a.agent_status, a.pane_id])).toEqual([
      ["claude", "blocked", "wW:p1"],
      ["opencode", "working", "wW:p7"],
      ["opencode", "idle", "wW:p9"],
    ]);
  });

  it("agentStatusByPane returns the matching pane's status, else unknown", async () => {
    const { runner } = fixtureRunner({ "agent list": AGENT_LIST });
    const client = new HerdrClient({ runner });
    expect(await client.agentStatusByPane("wW:p7")).toBe("working");
    expect(await client.agentStatusByPane("wW:p1")).toBe("blocked");
    expect(await client.agentStatusByPane("wW:nope")).toBe("unknown");
  });

  it("readAgent returns result.read.text from a canned snapshot", async () => {
    const { runner } = fixtureRunner({ "agent read #12": AGENT_READ });
    const client = new HerdrClient({ runner });
    expect(await client.readAgent("#12")).toBe("resolved 12 — claim then dispatch the driver");
  });
});

// --- tab creation -----------------------------------------------------------

describe("HerdrClient.createTab (canned tab create JSON)", () => {
  it("parses tab_id and root_pane pane_id", async () => {
    const { runner } = fixtureRunner({ "tab create --cwd /repo --label x --no-focus": TAB_CREATE });
    const client = new HerdrClient({ runner });
    const ids = await client.createTab({ cwd: "/repo", label: "x", focus: false });
    expect(ids).toEqual({ tabId: "wZ:t2", paneId: "wZ:p3" });
  });

  it("throws HerdrError when the response lacks the ids", async () => {
    const { runner } = fixtureRunner({
      "tab create --cwd /repo --label x --no-focus": JSON.stringify({ result: {} }),
    });
    const client = new HerdrClient({ runner });
    await expect(client.createTab({ cwd: "/repo", label: "x", focus: false })).rejects.toThrow(/tab|root_pane/i);
  });
});

describe("HerdrClient.closeTab (canned tab close)", () => {
  it("issues `tab close <tab_id>`", async () => {
    const { runner, calls } = fixtureRunner({
      "tab close wZ:t2": JSON.stringify({ id: "cli:tab:close", result: {} }),
    });
    const client = new HerdrClient({ runner });
    await client.closeTab("wZ:t2");
    expect(calls.map((c) => c.join(" "))).toContain("tab close wZ:t2");
  });

  it("surfaces a non-zero exit as a HerdrError (no silent close)", async () => {
    const { runner } = fixtureRunner({}); // no fixture → fixtureRunner returns code 1
    const client = new HerdrClient({ runner });
    await expect(client.closeTab("wZ:t2")).rejects.toThrow(/tab close wZ:t2 exited 1/);
  });
});

// --- notification (issue 13: the ready-for-human / agent-blocked handoff) ----

describe("HerdrClient.showNotification (canned notification show)", () => {
  it("issues `notification show <title>` with the title as the first positional", async () => {
    const { runner, calls } = fixtureRunner({
      "notification show herdr-frontier: #13 ready for human": JSON.stringify({ id: "cli:notification:show", result: {} }),
    });
    const client = new HerdrClient({ runner });
    await client.showNotification({ title: "herdr-frontier: #13 ready for human" });
    // The whole title is one positional arg (herdr notification show <TITLE>),
    // so the shell-out passes it as a single element of the arg vector.
    expect(calls.map((c) => c.join(" "))).toContain("notification show herdr-frontier: #13 ready for human");
    expect(calls.some((c) => c.length === 3 && c[0] === "notification" && c[1] === "show")).toBe(true);
  });

  it("adds --body / --sound when supplied", async () => {
    const { runner, calls } = fixtureRunner({
      "notification show t --body b --sound request": JSON.stringify({ id: "x", result: {} }),
    });
    const client = new HerdrClient({ runner });
    await client.showNotification({ title: "t", body: "b", sound: "request" });
    expect(calls.map((c) => c.join(" "))).toContain("notification show t --body b --sound request");
  });

  it("surfaces a non-zero exit as a HerdrError (no silent notification drop)", async () => {
    const { runner } = fixtureRunner({}); // no fixture → exit 1
    const client = new HerdrClient({ runner });
    await expect(client.showNotification({ title: "t" })).rejects.toThrow(/notification show t exited 1/);
  });
});

// --- prompt-API shim --------------------------------------------------------

describe("HerdrClient.prompt — the prompt-API shim (issue 12)", () => {
  it("branches to `agent prompt` when the schema has no AgentSendParams", async () => {
    const { runner, calls } = fixtureRunner({
      "api schema --json": SCHEMA_PROMPT_ONLY,
      "agent prompt #12 /implement body": JSON.stringify({ id: "cli:agent:prompt", result: {} }),
    });
    const client = new HerdrClient({ runner });
    await client.prompt("#12", "/implement body");
    expect(calls.map((c) => c.join(" "))).toContain("agent prompt #12 /implement body");
    expect(calls.some((c) => c[0] === "pane")).toBe(false);
  });

  it("branches to `agent send` + `pane send-keys <pane> enter` when AgentSendParams exists", async () => {
    const { runner, calls } = fixtureRunner({
      "api schema --json": SCHEMA_WITH_SEND,
      "agent send #12 /implement body": JSON.stringify({ id: "cli:agent:send", result: {} }),
      "pane send-keys wZ:p3 enter": JSON.stringify({ id: "cli:pane:send-keys", result: {} }),
    });
    const client = new HerdrClient({ runner });
    await client.prompt("#12", "/implement body", "wZ:p3");
    const vectors = calls.map((c) => c.join(" "));
    expect(vectors).toContain("agent send #12 /implement body");
    expect(vectors).toContain("pane send-keys wZ:p3 enter");
    expect(vectors.some((c) => c.startsWith("agent prompt"))).toBe(false);
  });

  it("detects the start API variant from the schema", async () => {
    const { runner } = fixtureRunner({ "api schema --json": SCHEMA_WITH_SEND });
    const client = new HerdrClient({ runner });
    expect(await client.detectStartApi()).toBe("kind");
  });

  it("emits the argv-variant `agent start` vector on an older schema", async () => {
    expect(agentStartVector(START_OPTS, "argv")).toEqual([
      "agent", "start", "#12", "--pane", "wZ:p3",
      "--", "opencode", "-m", "claude-sonnet-4-5",
    ]);
  });

  it("startAgent shapes the vector to the detected schema (kind vs argv)", async () => {
    const argvSchema = JSON.stringify({
      schemas: {
        request: {
          $defs: {
            AgentStartParams: {
              properties: { args: { type: "array" }, name: { type: "string" }, pane_id: { type: "string" } },
            },
          },
        },
      },
    });
    const { runner, calls } = fixtureRunner({
      "api schema --json": argvSchema,
      "agent start #12 --pane wZ:p3 --timeout 120000 -- opencode -m claude-sonnet-4-5": JSON.stringify({ id: "x", result: {} }),
    });
    const client = new HerdrClient({ runner });
    await client.startAgent(START_OPTS);
    expect(calls.map((c) => c.join(" "))).toEqual([
      "api schema --json",
      "agent start #12 --pane wZ:p3 --timeout 120000 -- opencode -m claude-sonnet-4-5",
    ]);
  });

  // agent start must wait for the freshly-created pane's shell to reach its
  // prompt — a heavy shell init (docker/nvm/pyenv) can exceed herdr's 30s
  // default and fail with "agent target pane … is not an available shell". The
  // reference wayfinder driver hard-codes 120s (herdr.rs agent_start_kind); we
  // default to the same at the driver boundary.
  it("startAgent defaults to a 120s readiness timeout (matches the reference driver)", async () => {
    const { runner, calls } = fixtureRunner({
      "api schema --json": SCHEMA_WITH_SEND,
      "agent start #12 --kind opencode --pane wZ:p3 --timeout 120000 -- -m claude-sonnet-4-5": JSON.stringify({ id: "x", result: {} }),
    });
    const client = new HerdrClient({ runner });
    await client.startAgent(START_OPTS); // no timeoutMs set
    const startVec = calls.find((c) => c[0] === "agent" && c[1] === "start")!.join(" ");
    expect(startVec).toBe("agent start #12 --kind opencode --pane wZ:p3 --timeout 120000 -- -m claude-sonnet-4-5");
  });

  it("an explicit timeoutMs overrides the 120s default", async () => {
    const { runner, calls } = fixtureRunner({
      "api schema --json": SCHEMA_WITH_SEND,
      "agent start #12 --kind opencode --pane wZ:p3 --timeout 5000 -- -m claude-sonnet-4-5": JSON.stringify({ id: "x", result: {} }),
    });
    const client = new HerdrClient({ runner });
    await client.startAgent({ ...START_OPTS, timeoutMs: 5000 });
    const startVec = calls.find((c) => c[0] === "agent" && c[1] === "start")!.join(" ");
    expect(startVec).toContain("--timeout 5000");
    expect(startVec).not.toContain("--timeout 120000");
  });

  it("the send-path shim surfaces a failed `agent send` instead of silently succeeding", async () => {
    const { runner } = fixtureRunner({
      "api schema --json": SCHEMA_WITH_SEND,
    });
    const client = new HerdrClient({ runner });
    await expect(client.prompt("#12", "/implement body", "wZ:p3")).rejects.toThrow(/no fixture/);
  });
});
