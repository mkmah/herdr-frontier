// Provider contract tests for the local-markdown adapter (issue 09 acceptance).
//
// Run: bun test src/tracker/local-markdown.test.ts
//
// These exercise the read side (listIssues / readIssue) over a temp `.scratch/`
// dir: parsing, the round-trip of the adapter's own canonical format, the
// missing-`Labels:` ⇒ needs-triage rule, filtering, and error behavior.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rm, mkdir, writeFile, mkdtemp, readdir, readFile, stat } from "node:fs/promises";
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

describe("LocalMarkdownProvider.close (issue 17 — resolve + post answer)", () => {
  const BODY = "## What to build\n\nThe driver with an injectable runner.";
  async function seed(status: "open" | "claimed" = "open"): Promise<string> {
    await writeIssue(
      "herdr-beads",
      "12-driver.md",
      ["# 12 — Driver", "", `Status: ${status}`, "Type: task", "Labels: ready-for-agent", "Blocked by: 10, 11", "Assignee: —", "", BODY].join("\n"),
    );
    return ".scratch/herdr-beads/issues/12-driver.md";
  }

  it("sets Status: resolved and appends the resolution under ## Answer", async () => {
    const id = await seed("claimed");
    const p = new LocalMarkdownProvider({ repoRoot: root });
    const closed = await p.close(id, "Done — the driver is wired.");
    expect(closed.status).toBe("resolved");

    const onDisk = await readFile(issuePath("herdr-beads", "12-driver.md"), "utf8");
    expect(onDisk).toContain("Status: resolved");
    expect(onDisk).not.toContain("Status: claimed");
    expect(onDisk).toContain("## Answer");
    expect(onDisk).toContain("Done — the driver is wired.");
  });

  it("preserves the body and the rest of the file exactly", async () => {
    const id = await seed();
    await new LocalMarkdownProvider({ repoRoot: root }).close(id, "Resolved.");
    const detail = await new LocalMarkdownProvider({ repoRoot: root }).readIssue(id);
    expect(detail.body).toContain(BODY);
    expect(detail.status).toBe("resolved");
    expect(detail.blockedBy).toEqual(["10", "11"]);
    expect(detail.tasks).toBeUndefined();
  });

  it("replaces an existing ## Answer section instead of duplicating it", async () => {
    await writeIssue(
      "herdr-beads",
      "12-driver.md",
      ["# 12 — Driver", "", "Status: claimed", "Type: task", "Labels: ready-for-agent", "Blocked by: —", "", "## Question", "Old body.", "## Answer", "Stale answer.", ""].join("\n"),
    );
    const id = ".scratch/herdr-beads/issues/12-driver.md";
    const p = new LocalMarkdownProvider({ repoRoot: root });
    await p.close(id, "Fresh answer.");
    const onDisk = await readFile(issuePath("herdr-beads", "12-driver.md"), "utf8");
    expect(onDisk).toContain("Fresh answer.");
    expect(onDisk).not.toContain("Stale answer.");
    expect(onDisk.match(/## Answer/g)).toHaveLength(1);
  });

  it("adds a pointer to the issue in the effort's map.md under ## Decisions so far", async () => {
    await seed();
    await mkdir(join(root, ".scratch", "herdr-beads"), { recursive: true });
    await writeFile(join(root, ".scratch", "herdr-beads", "map.md"), "# Map\n\n## Decisions so far\n\n- [x] earlier\n", "utf8");

    await new LocalMarkdownProvider({ repoRoot: root }).close(
      ".scratch/herdr-beads/issues/12-driver.md",
      "The driver is wired.",
    );
    const map = await readFile(join(root, ".scratch", "herdr-beads", "map.md"), "utf8");
    expect(map).toContain("](issues/12-driver.md)");
    expect(map).toContain("The driver is wired.");
  });

  it("is best-effort when the effort has no map.md (no throw)", async () => {
    const id = await seed();
    await expect(new LocalMarkdownProvider({ repoRoot: root }).close(id, "Resolved.")).resolves.toMatchObject({
      status: "resolved",
    });
  });

  it("writes atomically — no temp-file corpse is left behind", async () => {
    const id = await seed();
    await new LocalMarkdownProvider({ repoRoot: root }).close(id, "Resolved.");
    const dir = issuePath("herdr-beads", "12-driver.md").replace(/12-driver\.md$/, "");
    expect(await readdir(dir)).toEqual(["12-driver.md"]);
  });

  it("throws IssueNotFound for a missing id", async () => {
    const p = new LocalMarkdownProvider({ repoRoot: root });
    await expect(p.close(".scratch/none/issues/ghost.md", "x")).rejects.toBeInstanceOf(IssueNotFound);
  });
});

describe("LocalMarkdownProvider.comment (issue 17 — non-terminal talk)", () => {
  async function seed(): Promise<string> {
    await writeIssue(
      "herdr-beads",
      "13-comments.md",
      ["# 13 — Comments", "", "Status: claimed", "Type: task", "Labels: ready-for-agent", "Blocked by: —", "", "Body."].join("\n"),
    );
    return ".scratch/herdr-beads/issues/13-comments.md";
  }

  it("appends under ## Comments and readIssue parses it back into comments", async () => {
    const id = await seed();
    const p = new LocalMarkdownProvider({ repoRoot: root });
    await p.comment(id, "First note.");

    const onDisk = await readFile(issuePath("herdr-beads", "13-comments.md"), "utf8");
    expect(onDisk).toContain("## Comments");
    expect(onDisk).toContain("First note.");

    const detail = await p.readIssue(id);
    expect(detail.comments).toHaveLength(1);
    expect(detail.comments[0]!.body).toBe("First note.");
  });

  it("appends each comment with its own heading and preserves prior ones", async () => {
    const id = await seed();
    const p = new LocalMarkdownProvider({ repoRoot: root });
    await p.comment(id, "First note.");
    await p.comment(id, "Second note.");

    const onDisk = await readFile(issuePath("herdr-beads", "13-comments.md"), "utf8");
    expect(onDisk).toContain("First note.");
    expect(onDisk).toContain("Second note.");

    const detail = await p.readIssue(id);
    expect(detail.comments.map((c) => c.body)).toEqual(["First note.", "Second note."]);
  });

  it("preserves the body and the status", async () => {
    const id = await seed();
    const p = new LocalMarkdownProvider({ repoRoot: root });
    await p.comment(id, "A note.");
    const detail = await p.readIssue(id);
    expect(detail.status).toBe("claimed");
    expect(detail.body).toContain("Body.");
    expect(detail.body).toContain("A note.");
  });

  it("throws IssueNotFound for a missing id", async () => {
    const p = new LocalMarkdownProvider({ repoRoot: root });
    await expect(p.comment(".scratch/none/issues/ghost.md", "x")).rejects.toBeInstanceOf(IssueNotFound);
  });
});

describe("LocalMarkdownProvider.release (issue 12 — reopen an in-flight issue)", () => {
  const BODY = "## What to build\n\nThe driver with an injectable runner.\n\n- [ ] claim first\n- [ ] dispatch after";
  async function seed(status: "open" | "claimed" | "resolved" = "claimed"): Promise<string> {
    await writeIssue(
      "herdr-beads",
      "12-driver.md",
      ["# 12 — Driver", "", `Status: ${status}`, "Type: task", "Labels: ready-for-agent", "Blocked by: 10, 11", "Assignee: —", "", BODY].join("\n"),
    );
    return ".scratch/herdr-beads/issues/12-driver.md";
  }

  it("releases a claimed issue back to open (the inverse of claim)", async () => {
    const id = await seed("claimed");
    const p = new LocalMarkdownProvider({ repoRoot: root });
    const released = await p.release(id);
    expect(released.status).toBe("open");
    const onDisk = await readFile(issuePath("herdr-beads", "12-driver.md"), "utf8");
    expect(onDisk).toContain("Status: open");
    expect(onDisk).not.toContain("Status: claimed");
  });

  it("can also reopen a resolved issue (any non-open status → open)", async () => {
    const id = await seed("resolved");
    const released = await new LocalMarkdownProvider({ repoRoot: root }).release(id);
    expect(released.status).toBe("open");
    expect(await readFile(issuePath("herdr-beads", "12-driver.md"), "utf8")).toContain("Status: open");
  });

  it("is idempotent — releasing an already-open issue is a no-op (no rewrite)", async () => {
    const id = await seed("open");
    const path = issuePath("herdr-beads", "12-driver.md");
    const before = await stat(path);
    const p = new LocalMarkdownProvider({ repoRoot: root });
    const released = await p.release(id);
    expect(released.status).toBe("open");
    const after = await stat(path);
    // No rewrite ⇒ mtime unchanged (sub-second fs mtime resolution on macOS).
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("preserves the body and the rest of the file exactly", async () => {
    const id = await seed("claimed");
    const p = new LocalMarkdownProvider({ repoRoot: root });
    await p.release(id);
    const detail = await p.readIssue(id);
    expect(detail.body).toBe(BODY);
    expect(detail.blockedBy).toEqual(["10", "11"]);
    expect(detail.tasks).toEqual({ done: 0, total: 2 });
  });

  it("throws IssueNotFound for a missing id", async () => {
    const p = new LocalMarkdownProvider({ repoRoot: root });
    await expect(p.release(".scratch/none/issues/ghost.md")).rejects.toBeInstanceOf(IssueNotFound);
  });

  it("writes atomically — no temp-file corpse is left behind", async () => {
    const id = await seed("claimed");
    await new LocalMarkdownProvider({ repoRoot: root }).release(id);
    const dir = issuePath("herdr-beads", "12-driver.md").replace(/12-driver\.md$/, "");
    expect(await readdir(dir)).toEqual(["12-driver.md"]);
  });

  it("serializes a concurrent release vs claim — the winner is observed on disk", async () => {
    // Under the same O_EXCL lock as claim, release and claim can't tear each
    // other: one critical section runs, then the other reads the result.
    const id = await seed("claimed");
    const p = new LocalMarkdownProvider({ repoRoot: root });
    await Promise.allSettled([p.release(id), p.claim(id)]);
    const onDisk = await readFile(issuePath("herdr-beads", "12-driver.md"), "utf8");
    // Final state is one of the two outcomes — never a torn/half-written file.
    expect(["Status: open", "Status: claimed"].some((s) => onDisk.includes(s))).toBe(true);
  });
});
