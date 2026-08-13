// Local-markdown adapter — the first `TrackerProvider` (ADR-0001).
//
// Issues are markdown files at `<repoRoot>/.scratch/<effort>/issues/<file>.md`.
// The `id` is the repo-relative file path (posix slashes); the effort directory
// (the `<effort>` segment) is what a TUI groups by. This skeleton implements
// the READ side (`listIssues` / `readIssue`) fully; the write verbs throw —
// they land in later issues.
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

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
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
const MD_EXT = ".md";
const VALID_STATUS: ReadonlySet<IssueStatus> = new Set(["open", "claimed", "resolved"]);
const WAYFINDER_TYPES: ReadonlySet<IssueType> = new Set(["research", "prototype", "grilling"]);

export interface LocalMarkdownOptions {
  /** Absolute repo root; issue ids are paths relative to this. */
  repoRoot: string;
}

export class LocalMarkdownProvider implements TrackerProvider {
  private readonly repoRoot: string;

  constructor(opts: LocalMarkdownOptions) {
    this.repoRoot = opts.repoRoot;
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

  // -- write side: out of scope for this read-only skeleton -----------------
  // Signatures match ADR-0001 so the shape stays visible for later issues;
  // each throws until implemented.

  async claim(_id: string): Promise<Issue> {
    return unsupported("claim");
  }
  async updateLabels(_id: string, _add?: string[], _remove?: string[]): Promise<Issue> {
    return unsupported("updateLabels");
  }
  async close(_id: string, _resolution: string): Promise<Issue> {
    return unsupported("close");
  }
  async comment(_id: string, _body: string): Promise<Issue> {
    return unsupported("comment");
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
    title: fm.title,
    status: fm.status,
    type: fm.type,
    labels: fm.labels,
    assignee: fm.assignee,
    blockedBy: fm.blockedBy,
    body,
    comments: [],
    ...display,
  };
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
