// Local-markdown adapter — the first `TrackerProvider` (ADR-0001).
//
// Issues are markdown files at `<repoRoot>/.scratch/<effort>/issues/<file>.md`.
// The `id` is the repo-relative file path (posix slashes); the effort directory
// (the `<effort>` segment) is what a TUI groups by. This skeleton implements
// the READ side (`listIssues` / `readIssue`) fully plus the `claim`/`release`
// mutex verbs; the remaining write verbs throw — they land in later issues.
//
// Canonical file format (what `serializeIssue` writes and the parser reads):
//
//   # <title>
//
//   Status: <open|claimed|resolved>
//   Type: <research|prototype|grilling|task>
//   Labels: <label>, <label>          # 5 triage roles + wayfinder:*
//   Blocked by: <id>, <id>            # or —
//   Assignee: <name>                  # or —
//
//   <body>
//
// Per ADR-0001 Option C, labels are read ONLY from `Labels:`; a missing
// `Labels:` line reads as `needs-triage`. The legacy backtick
// `wayfinder:<type>` line is read only to infer `Type` (the field Option C
// keeps separate from labels), never as a label.

import { open, readdir, readFile, rm, stat, writeFile, rename } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import {
  AlreadyClaimed,
  ClaimBusy,
  type Comment,
  type Issue,
  type IssueDetail,
  type IssueFilter,
  type IssueStatus,
  type IssueType,
  type TaskTally,
  type TrackerProvider,
  IssueNotFound,
} from "./provider.js";

// Layout of the local issue store: <repoRoot>/.scratch/<effort>/issues/<file>.md
const SCRATCH_DIR = ".scratch";
const ISSUES_DIR = "issues";
const TRANSCRIPTS_DIR = "transcripts";
const MD_EXT = ".md";
const VALID_STATUS: ReadonlySet<IssueStatus> = new Set(["open", "claimed", "resolved"]);
const WAYFINDER_TYPES: ReadonlySet<IssueType> = new Set(["research", "prototype", "grilling"]);

// --- id facts (Card 2) ------------------------------------------------------
// The tracker owns its id format: these three parse a repo-relative id once and
// fill the record's adapter-owned `effort` / `num` / `order` fields, so policy
// (sorting, grouping, frontier order) reads facts instead of parsing paths.
// Consumers outside the adapter must use the record fields — never these.

/** The `<effort>` directory of an id (`.scratch/<effort>/issues/<file>.md`). */
export function idEffort(id: string): string {
  return id.split("/")[1] ?? "(ungrouped)";
}

/** The short-id label WITHOUT the `#`: the filename's numeric prefix if it has
 *  one (`"09"`), else the filename stem (`"README"`). */
export function idNum(id: string): string {
  const file = id.split("/").pop() ?? id;
  return file.match(/^(\d+)/)?.[1] ?? file.replace(/\.md$/, "");
}

/** The numeric sort order of an id — its filename prefix as a number, else
 *  `Number.MAX_SAFE_INTEGER` (no-number issues sort last). */
export function idOrder(id: string): number {
  const n = parseInt(idNum(id), 10);
  return Number.isNaN(n) ? Number.MAX_SAFE_INTEGER : n;
}


export interface LocalMarkdownOptions {
  /** Absolute repo root; issue ids are paths relative to this. */
  repoRoot: string;
}

export class LocalMarkdownProvider implements TrackerProvider {
  private readonly repoRoot: string;

  constructor(opts: LocalMarkdownOptions) {
    this.repoRoot = opts.repoRoot;
  }

  /** The repo-relative path of an issue's structured transcript: a sibling of
   *  the issue file under the same effort's `transcripts/` dir. The adapter
   *  owns the id↔path layout, so the transcript ingester reads this from here
   *  instead of splicing the id itself (Card 2). */
  structuredTranscriptPath(id: string): string {
    return id.replace(`/${ISSUES_DIR}/`, `/${TRANSCRIPTS_DIR}/`);
  }

  async listIssues(filter?: IssueFilter): Promise<Issue[]> {
    const files = await this.scanIssueFiles();
    const issues: Issue[] = [];
    for (const { abs, updatedAt } of files) {
      const content = await readFile(abs, "utf8");
      issues.push(parseIssue(content, this.idOf(abs), { updatedAt, tasks: tallyTasks(content) }));
    }
    return filter ? issues.filter((i) => matchesFilter(i, filter)) : issues;
  }

  async readIssue(id: string): Promise<IssueDetail> {
    const abs = join(this.repoRoot, ...id.split("/"));
    try {
      const content = await readFile(abs, "utf8");
      const st = await stat(abs);
      return parseDetail(content, id, { updatedAt: st.mtimeMs, tasks: tallyTasks(content) });
    } catch {
      throw new IssueNotFound(id);
    }
  }

  // -- write side: claim + release are live; the rest lands in later issues ---
  // Signatures match ADR-0001 so the shape stays visible for later issues;
  // each not-yet-implemented verb throws until it lands.

  /**
   * Claim an Issue (mutex intent): flip `Status: claimed`, written atomically
   * before any work (CONTEXT.md: Claim). The read-check-write runs under an
   * exclusive filesystem lock (`.lock`, O_EXCL), so the status check and the
   * write are one critical section across processes — two concurrent dispatchers
   * cannot both read `open` and both claim. An issue that is not open throws
   * {@link AlreadyClaimed}; a lock that cannot be acquired in time throws
   * {@link ClaimBusy}.
   */
  async claim(id: string): Promise<Issue> {
    const abs = join(this.repoRoot, ...id.split("/"));
    return withClaimLock(abs, async () => {
      let content: string;
      try {
        content = await readFile(abs, "utf8");
      } catch {
        throw new IssueNotFound(id);
      }
      const fm = parseFrontmatter(content, id);
      if (fm.status !== "open") throw new AlreadyClaimed(id, fm.status);
      const updated = setStatusLine(content, fm.bodyStart, "claimed");
      await atomicWrite(abs, updated);
      return parseIssue(updated, id);
    });
  }

  /**
   * Release a claim — the inverse of {@link claim}: flip `Status:` back to
   * `open`, atomically, under the same exclusive lock so a concurrent claim (or
   * another release) can't tear. Idempotent on an already-open issue — it
   * short-circuits without rewriting, so `mtime` (the row's age column) is
   * preserved. Used to stop/reopen in-flight work (issue 12). Throws
   * {@link IssueNotFound} when the file is absent.
   */
  async release(id: string): Promise<Issue> {
    const abs = join(this.repoRoot, ...id.split("/"));
    return withClaimLock(abs, async () => {
      let content: string;
      try {
        content = await readFile(abs, "utf8");
      } catch {
        throw new IssueNotFound(id);
      }
      const fm = parseFrontmatter(content, id);
      if (fm.status === "open") return parseIssue(content, id); // no-op, mtime preserved
      const updated = setStatusLine(content, fm.bodyStart, "open");
      await atomicWrite(abs, updated);
      return parseIssue(updated, id);
    });
  }

  async updateLabels(_id: string, _add?: string[], _remove?: string[]): Promise<Issue> {
    return unsupported("updateLabels");
  }
  /**
   * Close an Issue (issue 17): flip `Status:` to `resolved`, append the
   * resolution under a `## Answer` section (replacing a stale one), and add a
   * pointer to the issue in the effort's `map.md` under `## Decisions so far`
   * (best-effort — a missing map is not an error). Written atomically under the
   * same exclusive lock as claim/release. Throws {@link IssueNotFound}.
   */
  async close(id: string, resolution: string): Promise<Issue> {
    const abs = join(this.repoRoot, ...id.split("/"));
    const updated = await withClaimLock(abs, async () => {
      let content: string;
      try {
        content = await readFile(abs, "utf8");
      } catch {
        throw new IssueNotFound(id);
      }
      const fm = parseFrontmatter(content, id);
      const resolved = upsertAnswer(setStatusLine(content, fm.bodyStart, "resolved"), resolution);
      await atomicWrite(abs, resolved);
      return parseIssue(resolved, id);
    });
    await addMapPointer(this.repoRoot, id, resolution).catch(() => {
      // best-effort — the issue is already closed; a failed map pointer is not
      // a failed close
    });
    return updated;
  }

  /** Append a non-terminal comment under the `## Comments` section. */
  async comment(id: string, body: string): Promise<Issue> {
    const abs = join(this.repoRoot, ...id.split("/"));
    return withClaimLock(abs, async () => {
      let content: string;
      try {
        content = await readFile(abs, "utf8");
      } catch {
        throw new IssueNotFound(id);
      }
      const fm = parseFrontmatter(content, id);
      const updated = appendComment(content, body);
      await atomicWrite(abs, updated);
      return parseIssue(updated, id);
    });
  }
  async addBlocking(_id: string, _blockerIds: string[]): Promise<Issue> {
    return unsupported("addBlocking");
  }

  // -- internals ------------------------------------------------------------

  private idOf(absPath: string): string {
    return toPosix(relative(this.repoRoot, absPath));
  }

  /**
   * Recursively collect `<repoRoot>/.scratch/<effort>/issues/<file>.md`, each
   * with its last-modified time (the row's age source).
   */
  private async scanIssueFiles(): Promise<{ abs: string; updatedAt: number }[]> {
    const scratchDir = join(this.repoRoot, SCRATCH_DIR);
    let efforts;
    try {
      efforts = await readdir(scratchDir, { withFileTypes: true });
    } catch {
      return []; // no .scratch → no issues
    }
    const out: { abs: string; updatedAt: number }[] = [];
    for (const entry of efforts) {
      if (!entry.isDirectory()) continue;
      const issuesDir = join(scratchDir, entry.name, ISSUES_DIR);
      let entries;
      try {
        entries = await readdir(issuesDir);
      } catch {
        continue;
      }
      for (const f of entries) {
        if (!f.endsWith(MD_EXT)) continue;
        const abs = join(issuesDir, f);
        const st = await stat(abs);
        if (st.isFile()) out.push({ abs, updatedAt: st.mtimeMs });
      }
    }
    return out.sort((a, b) => a.abs.localeCompare(b.abs));
  }
}

function unsupported(verb: string): never {
  throw new Error(`LocalMarkdownProvider.${verb} is not implemented in the read-only skeleton (issue 09)`);
}

// --- atomic claim helpers ---------------------------------------------------

/**
 * Rewrite the frontmatter `Status:` line (only the lines before the body) to a
 * new status. A file with no `Status:` line gains one right after the title.
 */
function setStatusLine(content: string, bodyStart: number, status: IssueStatus): string {
  const lines = content.split("\n");
  const front = lines.slice(0, bodyStart);
  const rest = lines.slice(bodyStart);
  const idx = front.findIndex((l) => /^Status:/i.test(l));
  if (idx >= 0) {
    front[idx] = front[idx]!.replace(/^Status:.*$/i, `Status: ${status}`);
  } else {
    const head = front.findIndex((l) => /^#\s/.test(l));
    front.splice(head >= 0 ? head + 1 : 0, 0, `Status: ${status}`);
  }
  return [...front, ...rest].join("\n");
}

/**
 * Write a file via temp-file + rename so a reader never observes a torn file
 * mid-write — the property that makes local-markdown's claim race-free at the
 * filesystem level (per-session coordination is the orchestrator's mutex).
 */
async function atomicWrite(abs: string, content: string): Promise<void> {
  const tmp = `${abs}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, abs);
}

/**
 * Append (or replace) the `## Answer` section holding a resolution (issue 17).
 * A file with no Answer section gains one at the end; an existing one has its
 * body replaced (a re-close must not stack answers).
 */
function upsertAnswer(content: string, resolution: string): string {
  const text = resolution.trim();
  const lines = content.split("\n");
  const idx = lines.findIndex((l) => /^##\s+Answer\s*$/.test(l));
  if (idx < 0) {
    return `${content.trimEnd()}\n\n## Answer\n\n${text}\n`;
  }
  let end = lines.length;
  for (let i = idx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  const before = lines.slice(0, idx).join("\n").trimEnd();
  const after = lines.slice(end).join("\n").trimStart();
  let out = `${before}\n## Answer\n\n${text}`;
  if (after) out += `\n\n${after}`;
  return out + "\n";
}

/**
 * Append a comment under the `## Comments` section (issue 17), each with its
 * own `### Comment N` heading so the parser can round-trip them. A file with
 * no Comments section gains one at the end; an existing section is reused
 * (the new comment goes after the last one, before any later `##` section).
 */
function appendComment(content: string, body: string): string {
  const heading = `### Comment ${content.split("\n").filter((l) => /^###\s+Comment\b/.test(l)).length + 1}`;
  const lines = content.split("\n");
  const section = lines.findIndex((l) => /^##\s+Comments\s*$/.test(l));
  if (section < 0) {
    return `${content.trimEnd()}\n\n## Comments\n\n${heading}\n\n${body.trim()}\n`;
  }
  let end = lines.length;
  for (let i = section + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  const before = lines.slice(0, end).join("\n").trimEnd();
  const after = lines.slice(end).join("\n");
  let out = `${before}\n\n${heading}\n\n${body.trim()}`;
  if (after) out += `\n\n${after}`;
  return out + "\n";
}

/**
 * The effort's `map.md` pointer written on close (issue 17): a link to the
 * issue under `## Decisions so far` (creating the section when missing), so a
 * resolved issue is discoverable from the map. Best-effort by design — the
 * caller swallows a failure (no map, unwritable path) and the close stands.
 */
async function addMapPointer(repoRoot: string, id: string, resolution: string): Promise<void> {
  const parts = id.split("/"); // [".scratch", "<effort>", "issues", "<file>.md"]
  if (parts.length < 4) return;
  const effort = parts[1]!;
  const file = parts[3]!;
  const mapPath = join(repoRoot, SCRATCH_DIR, effort, "map.md");
  let raw: string;
  try {
    raw = await readFile(mapPath, "utf8");
  } catch {
    return; // no map.md — nothing to point at
  }
  const link = `](issues/${file})`;
  if (raw.includes(link)) return; // already linked
  const num = file.replace(/\.md$/, "");
  const gist = truncate(resolution.trim().split("\n")[0]!.trim(), 60);
  const bullet = `- [#${num} ${gist}](issues/${file})`;
  const re = /(^##\s+Decisions so far\s*\n)/m;
  const next = re.test(raw)
    ? raw.replace(re, (m) => `${m}${bullet}\n`)
    : `${raw.trimEnd()}\n\n## Decisions so far\n\n${bullet}\n`;
  await atomicWrite(mapPath, next);
}

/** Truncate to `n` UTF-16 units, never splitting in a way that breaks markdown. */
function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n).trimEnd()}…`;
}

// Claim mutex constants: how long to wait for a contended `.lock` before
// giving up. The lock window is a single read-modify-write (microseconds), so
// a 2s budget is far beyond any healthy hold; a stale lock (crashed process)
// times out as ClaimBusy instead of deadlocking.
const CLAIM_LOCK_ATTEMPTS = 200;
const CLAIM_LOCK_DELAY_MS = 10;

/**
 * Run `fn` inside an exclusive file lock (`<file>.lock` created with O_EXCL).
 * Concurrent callers — across processes, this is the cross-process mutex —
 * serialize on the create-or-fail of the lock; the holder's read-check-write
 * in {@link LocalMarkdownProvider.claim} is one critical section. The lock is
 * removed in a finally so a failed claim can't wedge future ones.
 */
async function withClaimLock<T>(abs: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${abs}.lock`;
  for (let attempt = 0; attempt < CLAIM_LOCK_ATTEMPTS; attempt++) {
    let fd: Awaited<ReturnType<typeof open>> | null = null;
    try {
      fd = await open(lockPath, "wx");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
        // Not contention (e.g. the parent dir doesn't exist) — there is no
        // issue to lock; let `fn` raise the real NotFound/IO error.
        return fn();
      }
      // held by a concurrent claimer — retry shortly
    }
    if (fd) {
      try {
        return await fn();
      } finally {
        await fd.close();
        await rm(lockPath, { force: true });
      }
    }
    await new Promise((resolve) => setTimeout(resolve, CLAIM_LOCK_DELAY_MS));
  }
  throw new ClaimBusy(abs);
}

// --- parsing ---------------------------------------------------------------

const RE_HEADING = /^#\s+(.*)$/;
const RE_STATUS = /^Status:\s*(.*)$/;
const RE_TYPE = /^Type:\s*(.*)$/;
const RE_LABELS = /^Labels:\s*(.*)$/;
const RE_BLOCKED = /^Blocked by:\s*(.*)$/;
const RE_ASSIGNEE = /^Assignee:\s*(.*)$/;
const RE_WAYFINDER_LINE = /^`(wayfinder:[a-z-]+)`$/;

interface Frontmatter {
  title: string;
  status: IssueStatus;
  type: IssueType;
  labels: string[];
  assignee: string | null;
  blockedBy: string[];
  bodyStart: number; // line index where the body begins
}

/** Display-only scalars the record carries so the UI needn't re-parse files. */
interface DisplayMeta {
  updatedAt?: number;
  tasks?: TaskTally;
}

/**
 * Tally markdown task-list checkboxes (`- [ ]` / `- [x]`) across the file —
 * the acceptance-criteria lists in real issue files. `undefined` when the
 * file has no checkboxes, so a tally-free issue renders no task column.
 */
function tallyTasks(content: string): TaskTally | undefined {
  let done = 0;
  let total = 0;
  for (const line of content.split("\n")) {
    const m = line.match(/^\s*[-*]\s+\[( |x|X)\]\s+/);
    if (!m) continue;
    total++;
    if (m[1] !== " ") done++;
  }
  return total > 0 ? { done, total } : undefined;
}

/** Parse the leading frontmatter block (no body) into an `Issue`. */
export function parseIssue(content: string, id: string, display?: DisplayMeta): Issue {
  const fm = parseFrontmatter(content, id);
  return {
    id,
    effort: idEffort(id),
    num: idNum(id),
    order: idOrder(id),
    title: fm.title,
    status: fm.status,
    type: fm.type,
    labels: fm.labels,
    assignee: fm.assignee,
    blockedBy: fm.blockedBy,
    ...display,
  };
}

/** Parse the full file into an `IssueDetail` (frontmatter + body). */
export function parseDetail(content: string, id: string, display?: DisplayMeta): IssueDetail {
  const fm = parseFrontmatter(content, id);
  const lines = content.split("\n");
  const body = lines.slice(fm.bodyStart).join("\n").trim();
  return {
    id,
    effort: idEffort(id),
    num: idNum(id),
    order: idOrder(id),
    title: fm.title,
    status: fm.status,
    type: fm.type,
    labels: fm.labels,
    assignee: fm.assignee,
    blockedBy: fm.blockedBy,
    body,
    comments: parseComments(content, fm.bodyStart),
    ...display,
  };
}

/**
 * Parse the `## Comments` section (issue 17) into `Comment[]`. Each `###`
 * heading under it starts a new comment; the heading is metadata, so a
 * comment's `body` is the text beneath it. A file without the section reads
 * `[]`.
 */
function parseComments(content: string, bodyStart: number): Comment[] {
  const lines = content.split("\n");
  const section = lines.findIndex((l, i) => i >= bodyStart && /^##\s+Comments\s*$/.test(l));
  if (section < 0) return [];
  let sectionEnd = lines.length;
  for (let i = section + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i]!)) {
      sectionEnd = i;
      break;
    }
  }
  const comments: Comment[] = [];
  let current: string[] | null = null;
  for (let i = section + 1; i < sectionEnd; i++) {
    if (/^###\s+/.test(lines[i]!)) {
      if (current !== null) comments.push({ body: current.join("\n").trim() });
      current = [];
    } else if (current !== null) {
      current.push(lines[i]!);
    }
  }
  if (current !== null) comments.push({ body: current.join("\n").trim() });
  return comments.filter((c) => c.body !== "");
}

function parseFrontmatter(content: string, id: string): Frontmatter {
  const lines = content.split("\n");
  const fallbackTitle = id.split("/").pop()?.replace(/\.md$/, "") ?? id;

  let title = fallbackTitle;
  let status: IssueStatus = "open";
  let explicitType: IssueType | null = null;
  let wayfinderType: IssueType | null = null; // from a Type: line OR a wayfinder:* token
  let labels: string[] = [];
  let assignee: string | null = null;
  let blockedBy: string[] = [];
  let sawHeading = false;
  // bodyStart defaults past the end so a bodyless file yields body === "".
  let bodyStart = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const h = line.match(RE_HEADING);
    const wf = line.match(RE_WAYFINDER_LINE);

    if (h && !sawHeading) {
      title = h[1]!.trim() || fallbackTitle;
      sawHeading = true;
      continue;
    }
    // A legacy backtick `wayfinder:<type>` line carries the issue's TYPE, not a
    // triage label (ADR-0001 Option C: labels come only from `Labels:`). Feed it
    // to type inference, never into `labels`.
    if (wf) {
      wayfinderType = wfType(wf[1]!) ?? wayfinderType;
      continue;
    }
    const m = (re: RegExp) => line.match(re)?.[1]?.trim() ?? null;
    const statusRaw = m(RE_STATUS);
    if (statusRaw !== null) {
      status = VALID_STATUS.has(statusRaw as IssueStatus) ? (statusRaw as IssueStatus) : "open";
      continue;
    }
    const typeRaw = m(RE_TYPE);
    if (typeRaw !== null) {
      explicitType = WAYFINDER_TYPES.has(typeRaw as IssueType) ? (typeRaw as IssueType) : "task";
      continue;
    }
    const labelsRaw = m(RE_LABELS);
    if (labelsRaw !== null) {
      labels = mergeLabels(labels, labelsRaw);
      continue;
    }
    const blockedRaw = m(RE_BLOCKED);
    if (blockedRaw !== null) {
      blockedBy = parseIdList(blockedRaw);
      continue;
    }
    const assigneeRaw = m(RE_ASSIGNEE);
    if (assigneeRaw !== null) {
      assignee = parseAssignee(assigneeRaw);
      continue;
    }
    // The first non-blank line that is not recognized metadata ends the
    // frontmatter block — the body starts here. Blank lines are skipped so a
    // bodyless file (no such line) leaves bodyStart at lines.length ⇒ "".
    if (line.trim() !== "") {
      bodyStart = i;
      break;
    }
  }

  if (labels.length === 0) labels = ["needs-triage"];

  // Type precedence: explicit Type: line, then a wayfinder:* token (from a
  // Label or legacy backtick line), else task.
  const type: IssueType = explicitType ?? wayfinderType ?? inferType(labels) ?? "task";

  return { title, status, type, labels, assignee, blockedBy, bodyStart };
}

/** Map a `wayfinder:<t>` token to an IssueType, or null if <t> isn't a type. */
function wfType(token: string): IssueType | null {
  if (!token.startsWith("wayfinder:")) return null;
  const t = token.slice("wayfinder:".length) as IssueType;
  return WAYFINDER_TYPES.has(t) ? t : null;
}

function inferType(labels: string[]): IssueType | null {
  for (const l of labels) {
    const t = wfType(l);
    if (t) return t;
  }
  return null;
}

function mergeLabels(into: string[], raw: string): string[] {
  for (const part of raw.split(",")) {
    const v = part.trim();
    if (v) into = addLabel(into, v);
  }
  return into;
}

function addLabel(into: string[], label: string): string[] {
  return into.includes(label) ? into : [...into, label];
}

function parseIdList(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const v = part.trim();
    if (v && v !== "—" && v !== "-") out.push(v);
  }
  return out;
}

function parseAssignee(raw: string): string | null {
  const v = raw.trim();
  return !v || v === "—" || v === "-" ? null : v;
}

// --- filtering -------------------------------------------------------------

function matchesFilter(i: Issue, f: IssueFilter): boolean {
  if (f.status !== undefined && i.status !== f.status) return false;
  if (f.title !== undefined && !i.title.toLowerCase().includes(f.title.toLowerCase())) return false;
  if (f.labels?.length) {
    for (const want of f.labels) {
      if (!i.labels.includes(want)) return false;
    }
  }
  return true;
}

// --- serialization (the adapter's canonical writer; used for round-trip) ----

/** Serialize an `Issue`/`IssueDetail` into the canonical local-markdown format. */
export function serializeIssue(issue: Issue): string {
  const lines: string[] = [`# ${issue.title}`, ""];
  lines.push(`Status: ${issue.status}`);
  lines.push(`Type: ${issue.type}`);
  lines.push(`Labels: ${issue.labels.join(", ")}`);
  lines.push(`Blocked by: ${issue.blockedBy.length ? issue.blockedBy.join(", ") : "—"}`);
  lines.push(`Assignee: ${issue.assignee ?? "—"}`);
  const body = (issue as IssueDetail).body;
  if (body && body.trim()) {
    lines.push("", body.trimEnd());
  }
  return lines.join("\n") + "\n";
}

// --- small path utils ------------------------------------------------------

function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}
