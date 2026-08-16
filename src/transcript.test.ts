// Transcript tests (issue 17 acceptance). Two layers:
//   - `extractResult` — the pure chrome-stripping heuristic (Seam 2): the last
//     meaningful line of a terminal snapshot, skipping TUI chrome, box-drawing,
//     spinners, and over-long lines, truncated to a fixed budget;
//   - `TranscriptIngester` — the extract + write-back path, tested over an
//     injected herdr client (fixture runner), an injected provider (records
//     close/comment), and an injected shell + file reader (no real IO).

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rm, mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_READ_LINES,
  extractResult,
  structuredTranscriptPath,
  TranscriptIngester,
  type IngestOutcome,
} from "./transcript.js";
import { HerdrClient, type HerdrRunner } from "./herdr-client.js";
import { AlreadyClaimed, type Issue, type IssueDetail, type TrackerProvider } from "./tracker/provider.js";

// --- pure extractor ---------------------------------------------------------

describe("extractResult — chrome-stripping the last meaningful line (issue 17)", () => {
  it("returns the last non-chrome line of a snapshot", () => {
    expect(extractResult("setup…\n\ncooking…\n\nClaimed #12 and dispatched the driver\n")).toBe(
      "Claimed #12 and dispatched the driver",
    );
  });

  it("skips trailing empty lines and TUI chrome markers", () => {
    const snap = "the answer is 42\n\n  commands: ctrl+a prefix  \n alt+ enter to send\n\n";
    expect(extractResult(snap)).toBe("the answer is 42");
  });

  it("skips a full-width box-drawing status bar", () => {
    const snap = "real result line\n╭──────────────────────────────╮\n│ opencode · idle · 00:12      │\n╰──────────────────────────────╯\n";
    expect(extractResult(snap)).toBe("real result line");
  });

  it("skips a spinner-only line (no word content)", () => {
    const snap = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏\nThe work is done\n";
    expect(extractResult(snap)).toBe("The work is done");
  });

  it("strips a leading spinner from an otherwise meaningful line", () => {
    expect(extractResult("⠋⠙⠹ done — resolved #12\n")).toBe("done — resolved #12");
  });

  it("truncates a meaningful line to the 200-char budget", () => {
    const long = "x".repeat(220); // within the 240 skip threshold, past the 200 budget
    const out = extractResult(long)!;
    expect(out).toHaveLength(200);
  });

  it("returns null when every line is chrome or empty", () => {
    expect(extractResult("╭──────╮\n│ idle  │\n╰──────╯\n")).toBeNull();
    expect(extractResult("")).toBeNull();
    expect(extractResult("   \n\n  \n")).toBeNull();
  });

  it("normalizes internal whitespace runs", () => {
    expect(extractResult("resolved  12 —  the driver\n")).toBe("resolved 12 — the driver");
  });
});

describe("structuredTranscriptPath — where a richer transcript lives", () => {
  it("maps an issue file to its transcripts/ sibling under the same effort", () => {
    expect(structuredTranscriptPath(".scratch/herdr-beads/issues/12-driver.md")).toBe(
      ".scratch/herdr-beads/transcripts/12-driver.md",
    );
  });
});

// --- ingester ---------------------------------------------------------------

const ISSUE_ID = ".scratch/herdr-beads/issues/12-driver.md";
const AGENT_NAME = "herdr-beads-12";

const SNAPSHOT = ["terminal chrome", "", "resolved #12 — the driver is wired", ""].join("\n");

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

/** Records close/comment so a test can assert what got written back. */
class RecordingProvider implements TrackerProvider {
  closed: { id: string; resolution: string }[] = [];
  commented: { id: string; body: string }[] = [];
  constructor(private status: Issue["status"] = "resolved") {}
  setStatus(s: Issue["status"]) {
    this.status = s;
  }
  async listIssues(): Promise<Issue[]> {
    return [];
  }
  async readIssue(): Promise<IssueDetail> {
    return {
      id: ISSUE_ID,
      title: "12 — Driver",
      status: this.status,
      type: "task",
      labels: ["ready-for-agent"],
      assignee: null,
      blockedBy: [],
      body: "",
      comments: [],
    };
  }
  async claim(id: string): Promise<Issue> {
    throw new AlreadyClaimed(id, this.status);
  }
  async release(id: string): Promise<Issue> {
    return this.readIssue();
  }
  async updateLabels(id: string): Promise<Issue> {
    return this.readIssue();
  }
  async close(id: string, resolution: string): Promise<Issue> {
    this.closed.push({ id, resolution });
    return this.readIssue();
  }
  async comment(id: string, body: string): Promise<Issue> {
    this.commented.push({ id, body });
    return this.readIssue();
  }
  async addBlocking(id: string): Promise<Issue> {
    return this.readIssue();
  }
}

function snapshotFixture(lines = DEFAULT_READ_LINES): string {
  return `agent read ${AGENT_NAME} --lines ${lines}`;
}

async function ingesterWith(over: Partial<ConstructorParameters<typeof TranscriptIngester>[0]> = {}) {
  const readAgent = SNAPSHOT;
  const { runner, calls } = fixtureRunner({ [snapshotFixture()]: JSON.stringify({ id: "x", result: { read: { text: readAgent } } }) });
  const client = new HerdrClient({ runner });
  const provider = new RecordingProvider();
  const repoRoot = await mkdtemp(join(tmpdir(), "beads-tr-"));
  const ingester = new TranscriptIngester({
    client,
    provider,
    repoRoot,
    config: {},
    ...over,
  });
  return { ingester, provider, client, calls, repoRoot };
}

let repoRoots: string[] = [];
beforeEach(() => {
  repoRoots = [];
});
afterEach(async () => {
  for (const r of repoRoots) await rm(r, { recursive: true, force: true });
});

describe("TranscriptIngester — extract a finished run and write it back (issue 17)", () => {
  it("reads the agent snapshot and comments the extracted result on a resolved issue", async () => {
    const { ingester, provider, calls } = await ingesterWith();
    const outcome = await ingester.ingest({ id: ISSUE_ID, kind: "opencode", agentName: AGENT_NAME });
    expect(outcome).toEqual({ wrote: "comment", result: "resolved #12 — the driver is wired" });
    expect(provider.commented).toEqual([{ id: ISSUE_ID, body: "resolved #12 — the driver is wired" }]);
    expect(provider.closed).toEqual([]);
    expect(calls.map((c) => c.join(" "))).toEqual([snapshotFixture()]);
  });

  it("closes an issue that the run finished but did not resolve", async () => {
    const h = await ingesterWith();
    h.provider.setStatus("claimed");
    const outcome = await h.ingester.ingest({ id: ISSUE_ID, kind: "opencode", agentName: AGENT_NAME });
    expect(outcome.wrote).toBe("close");
    if (outcome.wrote === "close") expect(outcome.result).toBe("resolved #12 — the driver is wired");
    expect(h.provider.closed).toEqual([{ id: ISSUE_ID, resolution: "resolved #12 — the driver is wired" }]);
    expect(h.provider.commented).toEqual([]);
  });

  it("prefers a structured transcript file under .scratch/ when the agent wrote one", async () => {
    const h = await ingesterWith();
    const structured = join(h.repoRoot, ".scratch", "herdr-beads", "transcripts");
    await mkdir(structured, { recursive: true });
    await writeFile(join(structured, "12-driver.md"), "structured tool-call dump\nfinal answer", "utf8");

    const outcome = await h.ingester.ingest({ id: ISSUE_ID, kind: "opencode", agentName: AGENT_NAME });
    expect(outcome).toEqual({ wrote: "comment", result: "structured tool-call dump\nfinal answer" });
    // No agent read happened — the file replaced the snapshot.
    expect(h.calls).toEqual([]);
  });

  it("runs the configured extraction command for the agent kind", async () => {
    const shell = (command: string, input: string) => `PIPED(${command.length}):${input.includes("the driver") ? "kept" : "empty"}`;
    const h = await ingesterWith({ config: { opencode: "some extractor" }, shell });
    const outcome = await h.ingester.ingest({ id: ISSUE_ID, kind: "opencode", agentName: AGENT_NAME });
    if (outcome.wrote !== "none") {
      expect(outcome.result).toBe("PIPED(14):kept");
    }
    expect(h.provider.commented).toEqual([{ id: ISSUE_ID, body: "PIPED(14):kept" }]);
  });

  it("falls back to the built-in heuristic when the extraction command yields nothing", async () => {
    const h = await ingesterWith({ config: { opencode: "tr -d x" }, shell: () => "" });
    const outcome = await h.ingester.ingest({ id: ISSUE_ID, kind: "opencode", agentName: AGENT_NAME });
    expect(outcome).toEqual({ wrote: "comment", result: "resolved #12 — the driver is wired" });
  });

  it("does nothing (none) when the snapshot holds no meaningful line — no write-back", async () => {
    const h = await ingesterWith();
    const { runner, calls } = fixtureRunner({
      [snapshotFixture()]: JSON.stringify({ id: "x", result: { read: { text: "╭────╮\n│ idle │\n╰────╯\n" } } }),
    });
    const client = new HerdrClient({ runner });
    const ingester = new TranscriptIngester({ client, provider: h.provider, repoRoot: h.repoRoot, config: {} });
    const outcome = await ingester.ingest({ id: ISSUE_ID, kind: "opencode", agentName: AGENT_NAME });
    expect(outcome).toEqual({ wrote: "none", result: null });
    expect(h.provider.commented).toEqual([]);
    expect(h.provider.closed).toEqual([]);
    expect(calls.map((c) => c.join(" "))).toEqual([snapshotFixture()]);
  });

  it("uses the configured --lines window for the agent read", async () => {
    const lines = 20;
    const { runner, calls } = fixtureRunner({
      [`agent read ${AGENT_NAME} --lines ${lines}`]: JSON.stringify({ id: "x", result: { read: { text: SNAPSHOT } } }),
    });
    const client = new HerdrClient({ runner });
    const provider = new RecordingProvider();
    const repoRoot = await mkdtemp(join(tmpdir(), "beads-tr-"));
    repoRoots.push(repoRoot);
    const ingester = new TranscriptIngester({ client, provider, repoRoot, config: {}, lines });
    const outcome = await ingester.ingest({ id: ISSUE_ID, kind: "opencode", agentName: AGENT_NAME });
    expect(outcome.wrote).toBe("comment");
    expect(calls.map((c) => c.join(" "))).toEqual([`agent read ${AGENT_NAME} --lines ${lines}`]);
  });
});