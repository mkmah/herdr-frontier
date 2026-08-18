// Transcript ingestion (issue 17) — how a finished run's output comes back
// into the tracker.
//
// herdr has NO extractor contract — only terminal snapshots (`herdr agent
// read`). So this module is the plugin-defined extractor: a chrome-stripping
// heuristic (ported from the reference `wayfinder` plugin's
// `last_meaningful_line`) that pulls the last line of real agent content out of
// a snapshot, skipping TUI chrome, box-drawing status bars, and spinners.
//
// The `transcripts:` config block can override the heuristic per agent kind
// with an extraction command (run over the snapshot). And when the agent itself
// writes a richer structured transcript to `.scratch/<effort>/transcripts/`
// (a sibling of the issue file) as part of its brief, the controller reads that
// file instead — tool-call dumps survive verbatim.
//
// Seams (spec Testing Decisions): the pure `extractResult` is Seam 2 (plain
// data, no IO); `TranscriptIngester` is IO-behind-seams — an injected herdr
// client (Seam 3), an injected TrackerProvider (Seam 1), and injectable shell
// + file reader (so the write-back path is unit-tested with no real IO).

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { HerdrClient } from "./herdr-client.js";
import type { TrackerProvider } from "./tracker/provider.js";
import type { TranscriptsConfig } from "./config.js";

/** The `agent read --lines N` window a finished run is drawn from. */
export const DEFAULT_READ_LINES = 40;

/** Chrome markers that disqualify a line — TUI key hints and status chrome. */
const CHROME_MARKERS: readonly string[] = [
  "esc interrupt",
  "ctrl+p",
  "manual mode",
  "baked for",
  "cooked for",
  "commands",
  "alt+",
  "opencode zen",
];

/** Box-drawing / full-width status-bar glyphs (wayfinder's set). */
const BLOCKY = /[┃╹▀▄█─│║╔╗╚╝┌┐└┘■▪·✕×⬝⬛▮▯▰▱]/;

/** A line must contain a real word to be agent content. */
const WORD_RE = /[a-z0-9]{3,}/i;

/** Leading spinner/whitespace to strip off an otherwise meaningful line. */
const SPINNER_RE = /^[\s⠁-⠿]+/;

const WHITESPACE_RE = /\s+/g;

/** Lines longer than this are status/chrome, not content. */
export const MAX_MEANINGFUL_LINE_LEN = 240;

/** The result budget (wayfinder truncates to 200 chars). */
export const MAX_RESULT_LEN = 200;

/**
 * The last line of real agent content in a terminal snapshot, chrome-stripped
 * (Seam 2 — pure). Walks lines from the end: empty lines, over-long lines,
 * chrome-marker lines, and heavy box-drawing lines are skipped; a candidate's
 * spinner prefix is stripped and internal whitespace collapsed; the result is
 * truncated to the 200-char budget. Null when nothing meaningful survives.
 */
export function extractResult(text: string): string | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i]!.trim();
    if (!trimmed) continue;
    if (trimmed.length > MAX_MEANINGFUL_LINE_LEN) continue;
    const lower = trimmed.toLowerCase();
    if (CHROME_MARKERS.some((m) => lower.includes(m))) continue;
    let boxCount = 0;
    for (const _ of trimmed.match(BLOCKY) ?? []) boxCount++;
    if (boxCount / trimmed.length > 0.2) continue;
    // A framed status bar (`│ opencode · idle · 00:12 │`) — boxy edges at both
    // ends, however light the bar. The 20% ratio alone misses it, so a line
    // that opens AND closes on a box glyph is chrome regardless of density.
    if (BLOCKY.test(trimmed[0]!) && BLOCKY.test(trimmed[trimmed.length - 1]!)) continue;
    if (!WORD_RE.test(trimmed)) continue;
    const normalized = trimmed.replace(SPINNER_RE, "").replace(WHITESPACE_RE, " ").trim();
    if (!normalized) continue;
    return normalized.length <= MAX_RESULT_LEN ? normalized : normalized.slice(0, MAX_RESULT_LEN);
  }
  return null;
}

/**
 * Where a richer structured transcript lives for an issue: a sibling of the
 * issue file under the same effort's `transcripts/` dir.
 */

/** One run member the ingester acts on. */
export interface IngestMember {
  id: string;
  /** The agent kind (its profile kind) — selects the extraction command. */
  kind: string;
  /** The herdr agent-session name to `agent read`. */
  agentName: string;
}

export type IngestOutcome =
  | { wrote: "close"; result: string }
  | { wrote: "comment"; result: string }
  | { wrote: "none"; result: null };

export interface TranscriptIngesterDeps {
  client: HerdrClient;
  provider: TrackerProvider;
  repoRoot: string;
  /** The repo-relative path of an issue's structured transcript — read from the
   *  adapter (Card 2), which owns the id↔path layout; the composition root
   *  wires `provider.structuredTranscriptPath`. */
  transcriptPath: (id: string) => string;
  /** The merged `transcripts:` config: agent kind → extraction command. */
  config: TranscriptsConfig;
  /** The `agent read --lines` window (default {@link DEFAULT_READ_LINES}). */
  lines?: number;
  /** Injectable extraction-command runner (default: `sh -c` via spawnSync). */
  shell?: (command: string, input: string) => string;
  /** Injectable file reader for the structured transcript (default: readFileSync). */
  readFile?: (abs: string) => string | null;
}

function defaultShell(command: string, input: string): string {
  const res = spawnSync("sh", ["-c", command], { input, encoding: "utf8" });
  return res.stdout ?? "";
}

function defaultReadFile(abs: string): string | null {
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

/**
 * Extract a finished run's result and write it back onto the Issue. Source:
 * the agent's structured transcript file under `.scratch/` when the agent wrote
 * one, else an `agent read` snapshot. Extract via the configured command for
 * the agent kind (falling back to the built-in heuristic), then write back —
 * `comment` on an already-resolved issue, `close` (resolve + post the answer)
 * when the run finished but didn't resolve it. `none` when nothing meaningful
 * survives (no write — the issue stays exactly as the agent left it).
 */
export class TranscriptIngester {
  private readonly deps: TranscriptIngesterDeps;

  constructor(deps: TranscriptIngesterDeps) {
    this.deps = deps;
  }

  async ingest(member: IngestMember): Promise<IngestOutcome> {
    // The agent's structured transcript file — when the agent wrote one, the
    // controller reads THAT instead of the terminal snapshot, verbatim (it is
    // already the agent's own structured write, not chrome to strip).
    const structured = this.readStructured(member.id);
    const result =
      structured !== null
        ? structured
        : this.extract(member.kind, await this.deps.client.readAgent(member.agentName, this.deps.lines ?? DEFAULT_READ_LINES));
    if (result === null) return { wrote: "none", result: null };
    const issue = await this.deps.provider.readIssue(member.id);
    if (issue.status === "resolved") {
      await this.deps.provider.comment(member.id, result);
      return { wrote: "comment", result };
    }
    await this.deps.provider.close(member.id, result);
    return { wrote: "close", result };
  }

  /** The structured transcript file under `.scratch/`, when the agent wrote one. */
  private readStructured(id: string): string | null {
    const read = this.deps.readFile ?? defaultReadFile;
    const raw = read(join(this.deps.repoRoot, ...this.deps.transcriptPath(id).split("/")));
    if (raw == null) return null;
    const text = raw.trim();
    return text === "" ? null : text;
  }

  /** The configured extraction command for the kind, else the built-in heuristic. */
  private extract(kind: string, raw: string): string | null {
    const command = this.deps.config[kind];
    if (command) {
      const shell = this.deps.shell ?? defaultShell;
      try {
        const out = shell(command, raw);
        if (out != null && out.trim() !== "") return out.trim();
      } catch {
        // a broken extraction command falls back to the heuristic below
      }
    }
    return extractResult(raw);
  }
}