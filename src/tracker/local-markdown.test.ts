// Provider contract tests for the local-markdown adapter (issue 09 acceptance).
//
// Run: bun test src/tracker/local-markdown.test.ts
//
// These exercise the read side (listIssues / readIssue) over a temp `.scratch/`
// dir: parsing, the round-trip of the adapter's own canonical format, the
// missing-`Labels:` ⇒ needs-triage rule, filtering, and error behavior.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rm, mkdir, writeFile, mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LocalMarkdownProvider,
  serializeIssue,
} from "./local-markdown.js";
import {
  AlreadyClaimed,
  IssueNotFound,
  type Issue,
  type IssueDetail,
  type TrackerProvider,
} from "./provider.js";

let root: string;
const issuePath = (effort: string, file: string) =>
  join(root, ".scratch", effort, "issues", file);

async function writeIssue(effort: string, file: string, content: string) {
  await mkdir(join(root, ".scratch", effort, "issues"), { recursive: true });
  await writeFile(issuePath(effort, file), content, "utf8");
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "beads-lm-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("LocalMarkdownProvider.listIssues", () => {
  it("parses title, status, type, labels, blockedBy from canonical files", async () => {
    await writeIssue(
      "herdr-beads",
      "05-tracker-provider-interface.md",
      [
        "# 05 — Tracker-provider interface design",
        "",
        "Status: resolved",
        "Type: grilling",
        "Labels: ready-for-agent, wayfinder:grilling",
        "Blocked by: 03",
        "Assignee: —",
        "",
        "## Question",
        "Design the interface.",
      ].join("\n"),
    );
    await writeIssue(
      "auth-spec",
      "22-token-refresh.md",
      [
        "# 22 — Token refresh",
        "",
        "Status: open",
        "Type: task",
        "Labels: ready-for-agent",
        "Blocked by: —",
        "",
        "Silent refresh.",
      ].join("\n"),
    );

    const p: TrackerProvider = new LocalMarkdownProvider({ repoRoot: root });
    const issues = await p.listIssues();
    expect(issues).toHaveLength(2);

    const five = issues.find((i) => i.id.endsWith("05-tracker-provider-interface.md"))!;
    expect(five.title).toBe("05 — Tracker-provider interface design");
    expect(five.status).toBe("resolved");
    expect(five.type).toBe("grilling");
    expect(five.labels).toEqual(["ready-for-agent", "wayfinder:grilling"]);
    expect(five.blockedBy).toEqual(["03"]);
    expect(five.assignee).toBeNull();
    // listIssues is low-res: no body on the record.
    expect((five as IssueDetail).body).toBeUndefined();
  });

  it("groups across efforts and exposes the effort in the id path", async () => {
    await writeIssue("eff-a", "01-x.md", "# 01 — X\n\nStatus: open\nLabels: ready-for-agent\nBlocked by: —\n");
    await writeIssue("eff-b", "02-y.md", "# 02 — Y\n\nStatus: open\nLabels: ready-for-agent\nBlocked by: —\n");
    const issues = await new LocalMarkdownProvider({ repoRoot: root }).listIssues();
    const efforts = new Set(issues.map((i) => i.id.split("/")[1])); // .scratch/<effort>/...
    expect(efforts).toEqual(new Set(["eff-a", "eff-b"]));
  });

  it("reads a missing Labels: line as needs-triage", async () => {
    await writeIssue(
      "herdr-beads",
      "01-legacy.md",
      "# 01 — Legacy issue\n\nStatus: open\nBlocked by: —\n",
    );
    const issues = await new LocalMarkdownProvider({ repoRoot: root }).listIssues();
    expect(issues[0]!.labels).toEqual(["needs-triage"]);
  });

  it("reads a legacy backtick `wayfinder:*` line for TYPE only, not as a label", async () => {
    // No `Labels:` line ⇒ labels are needs-triage (ADR-0001 Option C); the
    // backtick line still informs `type`.
    await writeIssue(
      "herdr-beads",
      "03-research.md",
      ["# 03 — Tracker-provider surface", "", "`wayfinder:research`", "Status: resolved", "Blocked by: —", ""].join("\n"),
    );
    const issue = (await new LocalMarkdownProvider({ repoRoot: root }).listIssues())[0]!;
    expect(issue.labels).toEqual(["needs-triage"]);
    expect(issue.type).toBe("research");
  });

  it("reads a `wayfinder:*` token inside Labels: both as a label and for type", async () => {
    await writeIssue(
      "herdr-beads",
      "05-iface.md",
      "# 05 — Iface\n\nStatus: resolved\nType: grilling\nLabels: ready-for-agent, wayfinder:grilling\nBlocked by: 03\n",
    );
    const issue = (await new LocalMarkdownProvider({ repoRoot: root }).listIssues())[0]!;
    expect(issue.labels).toEqual(["ready-for-agent", "wayfinder:grilling"]);
    expect(issue.type).toBe("grilling");
  });

  it("defaults status to open and type to task when absent", async () => {
    await writeIssue("herdr-beads", "09-bare.md", "# 09 — Bare\n\nLabels: ready-for-agent\nBlocked by: —\n");
    const issue = (await new LocalMarkdownProvider({ repoRoot: root }).listIssues())[0]!;
    expect(issue.status).toBe("open");
    expect(issue.type).toBe("task");
  });

  it("parses multiple comma-separated blockers and ignores the em-dash", async () => {
    await writeIssue(
      "herdr-beads",
      "12-driver.md",
      "# 12 — Driver\n\nStatus: open\nLabels: ready-for-agent\nBlocked by: 10, 11\n",
    );
    const issue = (await new LocalMarkdownProvider({ repoRoot: root }).listIssues())[0]!;
    expect(issue.blockedBy).toEqual(["10", "11"]);
  });

  it("filters by status, labels (intersection), and title substring", async () => {
    await writeIssue("e", "01-a.md", "# 01 — Alpha research\n\nStatus: resolved\nType: research\nLabels: ready-for-agent, wayfinder:research\nBlocked by: —\n");
    await writeIssue("e", "02-b.md", "# 02 — Beta\n\nStatus: open\nType: task\nLabels: ready-for-human\nBlocked by: —\n");
    const p = new LocalMarkdownProvider({ repoRoot: root });
    expect((await p.listIssues({ status: "open" })).map((i) => i.title)).toEqual(["02 — Beta"]);
    expect((await p.listIssues({ labels: ["ready-for-agent"] })).map((i) => i.title)).toEqual(["01 — Alpha research"]);
    expect((await p.listIssues({ title: "alpha" })).map((i) => i.title)).toEqual(["01 — Alpha research"]);
  });
});

describe("LocalMarkdownProvider.readIssue", () => {
  it("returns the full IssueDetail with body", async () => {
    await writeIssue(
      "herdr-beads",
      "05-iface.md",
      [
        "# 05 — Tracker-provider interface design",
        "",
        "Status: resolved",
        "Type: grilling",
        "Labels: ready-for-agent",
        "Blocked by: 03",
        "",
        "## Question",
        "Design the interface.",
        "",
        "## Answer",
        "Locked in ADR-0001.",
      ].join("\n"),
    );
    const p = new LocalMarkdownProvider({ repoRoot: root });
    const id = ".scratch/herdr-beads/issues/05-iface.md";
    const detail = await p.readIssue(id);
    expect(detail.title).toBe("05 — Tracker-provider interface design");
    expect(detail.status).toBe("resolved");
    expect(detail.body).toContain("## Question");
    expect(detail.body).toContain("Locked in ADR-0001.");
    expect(detail.comments).toEqual([]);
  });

  it("throws IssueNotFound for a missing id", async () => {
    const p = new LocalMarkdownProvider({ repoRoot: root });
    await expect(p.readIssue(".scratch/none/issues/ghost.md")).rejects.toBeInstanceOf(IssueNotFound);
  });
});

describe("round-trip: serializeIssue → readIssue → listIssues", () => {
  it("writes an Issue in the adapter's canonical format and reads it back identically", async () => {
    const original: Issue = {
      id: ".scratch/herdr-beads/issues/09-plugin.md",
      title: "09 — Plugin skeleton",
      status: "open",
      type: "task",
      labels: ["ready-for-agent"],
      assignee: null,
      blockedBy: [],
    };
    await writeIssue("herdr-beads", "09-plugin.md", serializeIssue(original));

    const p = new LocalMarkdownProvider({ repoRoot: root });
    const listed = (await p.listIssues())[0]!;
    expect(listed).toEqual(expect.objectContaining(original));
    expect(typeof listed.updatedAt).toBe("number");
    expect(listed.tasks).toBeUndefined(); // no checkboxes in the file

    const detail: IssueDetail = await p.readIssue(original.id);
    expect(detail.title).toBe(original.title);
    expect(detail.status).toBe(original.status);
    expect(detail.type).toBe(original.type);
    expect(detail.labels).toEqual(original.labels);
    expect(detail.assignee).toBeNull();
    expect(detail.blockedBy).toEqual([]);
    // A bodyless Issue round-trips to an empty body — never the frontmatter.
    expect(detail.body).toBe("");
  });

  it("returns an empty body for a file with no body (no trailing newline either)", async () => {
    // No trailing newline, no body section: must not surface frontmatter as body.
    await writeIssue(
      "herdr-beads",
      "09-bare.md",
      "# 09 — Bare\n\nStatus: open\nType: task\nLabels: ready-for-agent\nBlocked by: —\nAssignee: —",
    );
    const detail = await new LocalMarkdownProvider({ repoRoot: root }).readIssue(
      ".scratch/herdr-beads/issues/09-bare.md",
    );
    expect(detail.body).toBe("");
  });
});

describe("display scalars: tasks tally + updatedAt", () => {
  it("tallies acceptance-criteria checkboxes into tasks and stamps updatedAt (mtime)", async () => {
    await writeIssue(
      "herdr-beads",
      "10-shell.md",
      [
        "# 10 — Two-pane shell",
        "",
        "Status: open",
        "Type: task",
        "Labels: ready-for-agent",
        "Blocked by: —",
        "",
        "## Acceptance criteria",
        "",
        "- [x] Two-pane layout holds",
        "- [x] j/k move the cursor",
        "- [ ] Selected row highlights",
      ].join("\n"),
    );
    const issue = (await new LocalMarkdownProvider({ repoRoot: root }).listIssues())[0]!;
    expect(issue.tasks).toEqual({ done: 2, total: 3 });
    expect(typeof issue.updatedAt).toBe("number");

    const detail = await new LocalMarkdownProvider({ repoRoot: root }).readIssue(issue.id);
    expect(detail.tasks).toEqual({ done: 2, total: 3 });
    expect(typeof detail.updatedAt).toBe("number");
  });

  it("omits tasks entirely when the file has no checkboxes", async () => {
    await writeIssue("herdr-beads", "09-plugin.md", "# 09 — Plugin\n\nStatus: open\nLabels: ready-for-agent\nBlocked by: —\n");
    const issue = (await new LocalMarkdownProvider({ repoRoot: root }).listIssues())[0]!;
    expect(issue.tasks).toBeUndefined();
    expect(typeof issue.updatedAt).toBe("number");
  });
});

describe("LocalMarkdownProvider.claim (issue 12 — atomic mutex)", () => {
  const BODY = "## What to build\n\nThe driver with an injectable runner.\n\n- [ ] claim first\n- [ ] dispatch after";
  async function seed(): Promise<string> {
    await writeIssue(
      "herdr-beads",
      "12-driver.md",
      ["# 12 — Driver", "", "Status: open", "Type: task", "Labels: ready-for-agent", "Blocked by: 10, 11", "Assignee: —", "", BODY].join("\n"),
    );
    return ".scratch/herdr-beads/issues/12-driver.md";
  }

  it("flips Status: claimed and returns the updated Issue before any work", async () => {
    const id = await seed();
    const p = new LocalMarkdownProvider({ repoRoot: root });
    const claimed = await p.claim(id);
    expect(claimed.status).toBe("claimed");
    expect(claimed.title).toBe("12 — Driver");
    expect(claimed.labels).toEqual(["ready-for-agent"]);

    const listed = (await p.listIssues())[0]!;
    expect(listed.status).toBe("claimed");
    // The mutex is written to disk — a fresh provider instance still sees it.
    const fresh = (await new LocalMarkdownProvider({ repoRoot: root }).listIssues())[0]!;
    expect(fresh.status).toBe("claimed");
  });

  it("preserves the body and the rest of the file exactly", async () => {
    const id = await seed();
    await new LocalMarkdownProvider({ repoRoot: root }).claim(id);
    const detail = await new LocalMarkdownProvider({ repoRoot: root }).readIssue(id);
    expect(detail.body).toBe(BODY);
    expect(detail.blockedBy).toEqual(["10", "11"]);
    expect(detail.assignee).toBeNull();
    expect(detail.tasks).toEqual({ done: 0, total: 2 }); // the acceptance checkboxes survive
  });

  it("refuses to claim an already-claimed or resolved issue (AlreadyClaimed)", async () => {
    const id = await seed();
    const p = new LocalMarkdownProvider({ repoRoot: root });
    await p.claim(id);
    await expect(p.claim(id)).rejects.toBeInstanceOf(AlreadyClaimed);

    await writeIssue("herdr-beads", "05-done.md", "# 05 — Done\n\nStatus: resolved\nLabels: ready-for-agent\nBlocked by: —\n");
    await expect(p.claim(".scratch/herdr-beads/issues/05-done.md")).rejects.toBeInstanceOf(AlreadyClaimed);
  });

  it("throws IssueNotFound for a missing id", async () => {
    const p = new LocalMarkdownProvider({ repoRoot: root });
    await expect(p.claim(".scratch/none/issues/ghost.md")).rejects.toBeInstanceOf(IssueNotFound);
  });

  it("claims a file that lacks a Status: line (inserts one after the title)", async () => {
    await writeIssue("herdr-beads", "13-bare.md", "# 13 — Bare\n\nLabels: ready-for-agent\nBlocked by: —\n");
    const p = new LocalMarkdownProvider({ repoRoot: root });
    const claimed = await p.claim(".scratch/herdr-beads/issues/13-bare.md");
    expect(claimed.status).toBe("claimed");
    const onDisk = await readFile(issuePath("herdr-beads", "13-bare.md"), "utf8");
    expect(onDisk).toContain("Status: claimed");
  });

  it("writes atomically — no temp-file corpse is left behind", async () => {
    const id = await seed();
    await new LocalMarkdownProvider({ repoRoot: root }).claim(id);
    const dir = issuePath("herdr-beads", "12-driver.md").replace(/12-driver\.md$/, "");
    const files = await readdir(dir);
    expect(files).toEqual(["12-driver.md"]);
    const onDisk = await readFile(join(dir, "12-driver.md"), "utf8");
    expect(onDisk).toContain("Status: claimed");
    expect(onDisk).not.toContain("Status: open");
  });

  it("serializes concurrent claims — exactly one wins, the rest see AlreadyClaimed", async () => {
    const id = await seed();
    const p = new LocalMarkdownProvider({ repoRoot: root });
    // Two claimers racing on the same open issue: the O_EXCL lock makes their
    // read-check-write one critical section, so the second reads `claimed` —
    // the cross-process guarantee, not just per-session.
    const results = await Promise.allSettled([p.claim(id), p.claim(id)]);
    const wins = results.filter((r) => r.status === "fulfilled" && r.value.status === "claimed");
    const loses = results.filter((r) => r.status === "rejected" && r.reason instanceof AlreadyClaimed);
    expect(wins).toHaveLength(1);
    expect(loses).toHaveLength(1);
    const onDisk = await readFile(issuePath("herdr-beads", "12-driver.md"), "utf8");
    expect(onDisk).toContain("Status: claimed");
  });
});
