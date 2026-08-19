// Tests for the read-only Issue list + two-pane primary shell (issues 09 + 10).
//
// Two layers:
//   - logic.test / display.test: the pure presentation logic (grouping by
//     run-root, triage, cursor wrapping, list state, icon precedence) — where
//     the real behaviour lives.
//   - App render smoke: a synchronous initial render (initialIssues +
//     initialDetail) proving the OpenTUI component paints a 40/60 two-pane shell
//     with ghui-style rows and the detail fields. The OpenTUI test harness uses
//     a one-shot server renderer (no reactivity, no onMount/createEffect), so
//     async loading, cursor motion, and focus cycling are covered by the unit
//     tests, not by interaction here.

import { describe, it, expect } from "bun:test";
import { testRender } from "@opentui/solid";
import { App } from "#/App.js";
import { ShellController } from "#/services/shell/shell.js";
import {
  buildRows,
  type Row,
} from "#/lib/rows.js";
import {
  moveCursor,
  rowTitleBudget,
  trunc,
} from "#/lib/format.js";
import {
  sortIssues,
  triageOf,
} from "#/lib/issues.js";
import type { Issue, IssueDetail, TrackerProvider } from "#/services/tracker/provider.js";
import type { DispatchCoordinator } from "#/services/dispatch/coordinator.js";
import type { RunController } from "#/services/run/controller.js";
import type { ConfirmDialog } from "#/lib/confirm.js";
import { idEffort, idNum, idOrder } from "#/services/tracker/local-markdown.js";

const mk = (over: Partial<Issue> = {}): Issue => {
  const id = over.id ?? ".scratch/e/issues/01-x.md";
  return {
    id,
    effort: idEffort(id),
    num: idNum(id),
    order: idOrder(id),
    title: "01 — X",
    status: "open",
    type: "task",
    labels: ["ready-for-agent"],
    assignee: null,
    blockedBy: [],
    ...over,
  };
};

const noopProvider: TrackerProvider = {
  listIssues: async () => [],
  readIssue: async () => { throw new Error("noop"); },
  claim: async () => { throw new Error("noop"); },
  release: async () => { throw new Error("noop"); },
  updateLabels: async () => { throw new Error("noop"); },
  close: async () => { throw new Error("noop"); },
  comment: async () => { throw new Error("noop"); },
  addBlocking: async () => { throw new Error("noop"); },
};

// The render smoke never triggers a verb or a load, so a shell with inert deps
// (the App test harness skips onMount — nothing ever calls them) is enough.
const noopShell = new ShellController({
  provider: noopProvider,
  coordinator: {} as unknown as DispatchCoordinator,
  runController: { load: () => null } as unknown as RunController,
  confirmPolicy: {},
});

// The detail body paints only once OpenTUI's tree-sitter markdown highlight
// resolves — a worker round-trip that can land a frame (or a few) after the
// mount settles, especially on a cold or load-heavy worker (the parser Worker
// is lazy-spawned per process, so the first `bun test` run pays thread spawn +
// parse-asset init — a classic first-run-only flake). A single
// flush()/captureCharFrame() must not read that gap as "the body never
// painted", so the markdown assertions retry capture until a body marker
// appears and run against that settled frame. Budget: up to ~2s of retries —
// warm runs settle in <200ms, so this costs nothing on the happy path, while a
// cold first run gets ~8× the old 250ms headroom.
async function captureSettledFrame(
  setup: Awaited<ReturnType<typeof testRender>>,
  marker: (frame: string) => boolean,
): Promise<string> {
  let frame = setup.captureCharFrame();
  for (let attempt = 0; attempt < 400 && !marker(frame); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    await setup.flush();
    frame = setup.captureCharFrame();
  }
  return frame;
}

describe("logic: triageOf", () => {
  it("returns the first non-wayfinder label, defaulting to needs-triage", () => {
    expect(triageOf(mk({ labels: ["ready-for-agent", "wayfinder:task"] }))).toBe("ready-for-agent");
    expect(triageOf(mk({ labels: ["wayfinder:research"] }))).toBe("needs-triage");
    expect(triageOf(mk({ labels: [] }))).toBe("needs-triage");
  });
});

describe("logic: sortIssues + buildRows groups by run-root", () => {
  it("sorts by run-root then title and emits group headers with counts", () => {
    const issues = sortIssues([
      mk({ id: ".scratch/auth-spec/issues/22-token.md", title: "22 — Token" }),
      mk({ id: ".scratch/herdr-frontier/issues/09-skeleton.md", title: "09 — Skeleton" }),
      mk({ id: ".scratch/herdr-frontier/issues/05-iface.md", title: "05 — Iface" }),
    ]);
    const rows = buildRows({ issues, loaded: true, error: null });
    const groups = rows.filter((r): r is Extract<Row, { kind: "group" }> => r.kind === "group");
    expect(groups.map((g) => g.root)).toEqual(["auth-spec", "herdr-frontier"]);
    const byRoot = Object.fromEntries(groups.map((g) => [g.root, g.count]));
    expect(byRoot["auth-spec"]).toBe(1);
    expect(byRoot["herdr-frontier"]).toBe(2);
    // within herdr-frontier, 05 sorts before 09
    const hbIssues = rows.filter((r): r is Extract<Row, { kind: "issue" }> =>
      r.kind === "issue" && r.issue.id.includes("herdr-frontier"));
    expect(hbIssues.map((r) => r.issue.title)).toEqual(["05 — Iface", "09 — Skeleton"]);
  });

  it("emits exactly one group header per contiguous run of same-root issues", () => {
    const rows = buildRows({
      issues: sortIssues([
        mk({ id: ".scratch/a/issues/1.md", title: "1" }),
        mk({ id: ".scratch/a/issues/2.md", title: "2" }),
        mk({ id: ".scratch/b/issues/3.md", title: "3" }),
      ]),
      loaded: true,
      error: null,
    });
    expect(rows.filter((r) => r.kind === "group")).toHaveLength(2);
  });

  it("emits an empty row when loaded with no issues", () => {
    expect(buildRows({ issues: [], loaded: true, error: null })).toEqual([{ kind: "empty" }]);
  });

  it("emits nothing yet while still loading", () => {
    expect(buildRows({ issues: [], loaded: false, error: null })).toEqual([]);
  });

  it("emits a single error row on failure", () => {
    expect(buildRows({ issues: [], loaded: true, error: "boom" })).toEqual([
      { kind: "error", message: "boom" },
    ]);
  });
});

describe("logic: moveCursor wraps and clamps", () => {
  it("wraps forward and backward over n items", () => {
    expect(moveCursor(0, 1, 3)).toBe(1);
    expect(moveCursor(2, 1, 3)).toBe(0); // wrap forward
    expect(moveCursor(0, -1, 3)).toBe(2); // wrap backward
    expect(moveCursor(1, -1, 3)).toBe(0);
  });
  it("is a no-op (returns 0) when there is nothing to move over", () => {
    expect(moveCursor(5, 1, 0)).toBe(0);
  });
});

describe("logic: trunc — ellipsis, floor at 0 (issue 16)", () => {
  it("returns the string unchanged when it fits", () => {
    expect(trunc("abc", 3)).toBe("abc");
  });
  it("replaces the tail with an ellipsis", () => {
    expect(trunc("abcdef", 4)).toBe("abc…");
  });
  it("floors at 0 so a narrow pane never wraps a row", () => {
    expect(trunc("abc", 0)).toBe("");
    expect(trunc("abc", -5)).toBe("");
  });
  it("is a bare ellipsis for a 1-char budget", () => {
    expect(trunc("abc", 1)).toBe("…");
  });
});

describe("logic: rowTitleBudget — non-collapsing segments, floor at 0 (issue 16)", () => {
  it("reserves #id, tasks, and age at full width — only the title flexes", () => {
    // innerW 40: glyph(2) + #id(3) + 2 lead + tasks(3+1) + age(2+1) = 14 reserved → 26
    expect(rowTitleBudget({ innerW: 40, branchLen: 0, idLen: 3, tasksLen: 3, ageLen: 2, depth: 0 })).toBe(26);
    // a longer #id shrinks the budget by exactly its added width
    expect(rowTitleBudget({ innerW: 40, branchLen: 0, idLen: 5, tasksLen: 3, ageLen: 2, depth: 0 })).toBe(24);
  });
  it("floors at 0 so a narrow pane never wraps a row to a second line", () => {
    expect(rowTitleBudget({ innerW: 10, branchLen: 0, idLen: 3, tasksLen: 3, ageLen: 2, depth: 0 })).toBe(0);
    expect(rowTitleBudget({ innerW: 0, branchLen: 3, idLen: 3, tasksLen: 0, ageLen: 0, depth: 2 })).toBe(0);
  });
  it("reserves the tree branch connector so the title never collides with it", () => {
    const base = { innerW: 60, idLen: 3, tasksLen: 0, ageLen: 0, depth: 0 };
    expect(rowTitleBudget({ ...base, branchLen: 3 })).toBe(rowTitleBudget({ ...base, branchLen: 0 }) - 3);
  });
  it("subtracts the tree depth padding", () => {
    const base = { innerW: 60, branchLen: 3, idLen: 3, tasksLen: 0, ageLen: 0 };
    expect(rowTitleBudget({ ...base, depth: 2 })).toBe(rowTitleBudget({ ...base, depth: 0 }) - 4);
  });
});


describe("App (initial render smoke — two-pane shell)", () => {
  it("paints a 40/60 shell with group headers, ghui-style rows, and the detail fields", async () => {
    const first = mk({
      id: ".scratch/herdr-frontier/issues/09-skeleton.md",
      title: "09 — Plugin skeleton",
      status: "claimed",
      labels: ["ready-for-agent", "wayfinder:task"],
      tasks: { done: 2, total: 4 },
      updatedAt: Date.now() - 5 * 3_600_000,
    });
    const second = mk({
      id: ".scratch/auth-spec/issues/22-token.md",
      title: "22 — Token refresh",
      labels: ["ready-for-human"],
      blockedBy: ["21"],
    });
    const detail: IssueDetail = {
      ...first,
      body: "Build the primary shell. Blocked-by line here.",
      comments: [],
    };

    const setup = await testRender(() => (
      <App
        shell={noopShell}
        initialIssues={[first, second]}
        initialDetail={detail}
      />
    ));
    // markdown body settles after its highlight round-trip — wait for it
    const frame = await captureSettledFrame(
      setup,
      (f) => f.includes("Build the primary shell"),
    );

    // list pane: grouped rows, #id, truncated titles
    expect(frame).toContain("herdr-frontier");
    expect(frame).toContain("auth-spec");
    expect(frame).toContain("#09");
    expect(frame).toContain("#22");
    expect(frame).toContain("Plugin skeleton");
    expect(frame).toContain("Token refresh");
    // ghui-style: tasks ratio + age on the selected row
    expect(frame).toContain("2/4");
    expect(frame).toContain("5h");
    // detail pane: labels + blocked-by + body
    expect(frame).toContain("ready-for-agent");
    expect(frame).toContain("wayfinder:task");
    expect(frame).toContain("blocked by: —");
    expect(frame).toContain("Build the primary shell");
    setup.renderer.destroy();
  });

  // The detail body is the Issue's whole markdown document — rendered through
  // OpenTUI's <markdown> element under the header rows, so headings/lists/bold
  // paint structurally and the syntax markers are concealed (the pane shows the
  // work, not the .md). Same render path as the tree view's detail pane (the
  // DetailPane/DetailContent split is shared), so one smoke covers both views.
  it("renders the detail body as markdown with concealed syntax markers", async () => {
    const issue = mk();
    const detail: IssueDetail = {
      ...issue,
      body: "# Blockers\n\nRewrite the `driver`. **Boldly** ship it.\n\n- one\n- two",
      comments: [],
    };
    const setup = await testRender(
      () => <App shell={noopShell} initialIssues={[issue]} initialDetail={detail} />,
      { width: 120, height: 20 },
    );
    // markdown body settles after its highlight round-trip — wait for it
    const frame = await captureSettledFrame(setup, (f) => f.includes("Blockers"));
    // markdown structure paints — heading, inline code, emphasis, list items
    expect(frame).toContain("Blockers");
    expect(frame).toContain("Rewrite the driver.");
    expect(frame).toContain("Boldly ship it.");
    expect(frame).toContain("- one");
    expect(frame).toContain("- two");
    // the markers themselves are concealed — no literal .md syntax in the frame
    expect(frame).not.toContain("# Blockers");
    expect(frame).not.toContain("**");
    expect(frame).not.toContain("`driver`");
    setup.renderer.destroy();
  });

  it("renders the empty state when initialIssues is empty", async () => {
    const setup = await testRender(() => <App shell={noopShell} initialIssues={[]} />);
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("no issues");
    setup.renderer.destroy();
  });

  // Regression: the stale-detail race. When a detail record for a differently
  // id'd issue is present while another issue is selected (the state between
  // navigation and the new read resolving), the body must not paint under the
  // wrong title.
  it("does not paint a detail body whose id differs from the selected issue", async () => {
    const eleven = mk({ id: ".scratch/herdr-frontier/issues/11-a.md", title: "11 — A" });
    const twelve = mk({ id: ".scratch/herdr-frontier/issues/12-b.md", title: "12 — B" });
    const staleDetail: IssueDetail = {
      ...twelve,
      body: "BODY OF 12 (must not paint under 11)",
      comments: [],
    };
    const setup = await testRender(() => (
      <App shell={noopShell} initialIssues={[eleven, twelve]} initialDetail={staleDetail} />
    ));
    await setup.flush();
    const frame = setup.captureCharFrame();
    // cursor starts at issue 11 — the body of 12 must not leak under it
    expect(frame).not.toContain("BODY OF 12 (must not paint under 11)");
    setup.renderer.destroy();
  });

  // Regression: header-collapse repaint. When the selected issue's body is long
  // enough to overflow the detail pane, OpenTUI 0.5.1 lays the overflowing
  // content over the header row and the "herdr-frontier ... open ... your-turn"
  // header disappears. Rendered through the real reactive renderer (a tall
  // initialDetail paints with no async interleaving, so it reproduces reliably).
  it("keeps the header visible when the detail body overflows the pane", async () => {
    const tall = mk({ id: ".scratch/herdr-frontier/issues/01-x.md", title: "01 — X" });
    const detail: IssueDetail = { ...tall, body: "BODY\n" + "line\n".repeat(60), comments: [] };
    const setup = await testRender(
      () => <App shell={noopShell} initialIssues={[tall]} initialDetail={detail} />,
      { width: 100, height: 12 },
    );
    await setup.flush();
    const frame = setup.captureCharFrame();
    expect(frame.split("\n")[0]).toContain("◆ herdr-frontier");
    setup.renderer.destroy();
  });

  // Issue 12 acceptance: the detail pane shows the resolved /implement or
  // /wayfinder command (a dispatchable issue → its command; a human turn →
  // the "(no auto-dispatch — human turn)" marker, exactly like the prototype).
  it("shows the resolved dispatch command for a dispatchable issue", async () => {
    const impl = mk({
      id: ".scratch/herdr-frontier/issues/12-driver.md",
      title: "12 — Driver",
      labels: ["ready-for-agent"],
    });
    const detail: IssueDetail = { ...impl, body: "Build the driver.", comments: [] };
    const setup = await testRender(
      () => <App shell={noopShell} initialIssues={[impl]} initialDetail={detail} />,
      { width: 120, height: 20 },
    );
    await setup.flush();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("dispatch:");
    // `{id}` resolves to the issue's identity — the repo-relative .md path for
    // local-markdown — which is exactly the command the agent receives.
    expect(frame).toContain("/implement .scratch/herdr-frontier/issues/12-driver.md");
    setup.renderer.destroy();
  });

  it("marks a human turn as not auto-dispatched", async () => {
    const human = mk({ id: ".scratch/herdr-frontier/issues/13-human.md", labels: ["ready-for-human"] });
    const detail: IssueDetail = { ...human, body: "Your turn.", comments: [] };
    const setup = await testRender(
      () => <App shell={noopShell} initialIssues={[human]} initialDetail={detail} />,
      { width: 120, height: 20 },
    );
    await setup.flush();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("(no auto-dispatch — human turn)");
    setup.renderer.destroy();
  });

  // Issue 12: `x` stops + reopens an in-flight issue. The OpenTUI test renderer
  // is one-shot (no reactivity), so the keypress itself is covered by the
  // dispatch/coordinator unit tests; here we assert the binding is surfaced in
  // the footer help.
  it("advertises the x stop+reopen binding in the footer", async () => {
    const issue = mk();
    const setup = await testRender(
      () => <App shell={noopShell} initialIssues={[issue]} />,
      { width: 120, height: 20 },
    );
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("x stop+reopen");
    setup.renderer.destroy();
  });

  // Issue 14: the detail pane shows the run-controller's status for the
  // selected issue's run-root, and the footer advertises the s start-run key
  // and the dedicated S stop-all key.
  it("shows the run status line for the selected issue's run-root and the s/S keys", async () => {
    const issue = mk({ id: ".scratch/e/issues/01-x.md" });
    const detail: IssueDetail = { ...issue, body: "", comments: [] };
    const runController = {
      load: () => ({
        id: "run-e",
        root: "e",
        status: "running",
        concurrency: 3,
        startedAt: Date.now(),
        issues: [
          { id: issue.id, status: "dispatched" },
          { id: ".scratch/e/issues/02-y.md", status: "pending" },
        ],
      }),
    } as unknown as RunController;
    const runShell = new ShellController({
      provider: noopProvider,
      coordinator: {} as unknown as DispatchCoordinator,
      runController,
      confirmPolicy: {},
    });
    const setup = await testRender(
      () => (
        <App
          shell={runShell}
          initialIssues={[issue]}
          initialDetail={detail}
        />
      ),
      { width: 120, height: 20 },
    );
    await setup.flush();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("run: running");
    expect(frame).toContain("1 in-flight");
    expect(frame).toContain("1 pending");
    expect(frame).toContain("s run");
    expect(frame).toContain("S stop+release");
    setup.renderer.destroy();
  });

  // Issue 15 acceptance: the secondary dependency-tree view renders a forward
  // forest (lean tree pane on top + scrollable detail pane below) when the
  // initial view is the tree — tree connectors, lean rows (icon · #id · title
  // · tasks · age), and the selected node's full detail below.
  it("renders the dependency-tree secondary view (lean tree + detail below)", async () => {
    const root = mk({
      id: ".scratch/herdr-frontier/issues/01-a.md",
      title: "01 — Alpha",
      status: "claimed",
      labels: ["ready-for-agent", "wayfinder:task"],
      tasks: { done: 2, total: 4 },
      updatedAt: Date.now() - 5 * 3_600_000,
    });
    const child = mk({
      id: ".scratch/herdr-frontier/issues/02-b.md",
      title: "02 — Beta",
      blockedBy: ["01"],
    });
    const detail: IssueDetail = {
      ...root,
      body: "Root issue body for the tree detail pane.",
      comments: [],
    };
    const setup = await testRender(
      () => (
        <App
          shell={noopShell}
          initialIssues={[root, child]}
          initialDetail={detail}
          initialView="tree"
        />
      ),
      { width: 100, height: 44 },
    );
    // markdown body settles after its highlight round-trip — wait for it
    const frame = await captureSettledFrame(
      setup,
      (f) => f.includes("Root issue body for the tree detail pane."),
    );
    // tree pane (top) — title + a forward-forest connector + lean row fields
    expect(frame).toContain("Dependencies");
    expect(frame).toContain("└─");
    expect(frame).toContain("#01");
    expect(frame).toContain("Alpha");
    expect(frame).toContain("2/4");
    expect(frame).toContain("5h");
    // detail pane (below) — the selected node's chips + deps + body + launch
    expect(frame).toContain("Detail");
    expect(frame).toContain("ready-for-agent");
    expect(frame).toContain("wayfinder:task");
    expect(frame).toContain("blocked by:");
    expect(frame).toContain("Root issue body for the tree detail pane.");
    expect(frame).toContain("/wayfinder .scratch/herdr-frontier/issues/01-a.md");
    // the primary list pane is not in this view
    expect(frame).not.toContain(" Issues ");
    setup.renderer.destroy();
  });

  // Issue 15 acceptance: the primary list is the default view — the tree
  // connectors must not leak into it (the tree is a toggleable secondary view).
  it("keeps the tree out of the default (list) view", async () => {
    const setup = await testRender(
      () => <App shell={noopShell} initialIssues={[mk()]} />,
      { width: 100, height: 20 },
    );
    await setup.flush();
    const frame = setup.captureCharFrame();
    expect(frame).not.toContain("Dependencies");
    expect(frame).not.toContain("└─");
    setup.renderer.destroy();
  });

  // Issue 16 acceptance: long titles truncate with an ellipsis and rows never
  // wrap to a second line — even when the pane is too narrow for the full title.
  // Robust probe: when the row truncates, the title's distinguishing tail is
  // replaced by "…" and so appears NOWHERE in the frame; a wrapped row would
  // still carry the tail on its second line. (Mouse selection/double-click/
  // wheel are covered by the pure trackClick/wheelDelta seam in display.test.)
  it("truncates a long list-row title with an ellipsis and never wraps", async () => {
    const long = mk({
      id: ".scratch/herdr-frontier/issues/16-long.md",
      title: "16 — Long title that must truncate cleanly across a narrow pane",
    });
    const detail: IssueDetail = { ...long, body: "", comments: [] };
    const setup = await testRender(
      () => <App shell={noopShell} initialIssues={[long]} initialDetail={detail} />,
      { width: 100, height: 16 },
    );
    await setup.flush();
    const frame = setup.captureCharFrame();
    // the row truncates — the tail is gone from every line (list row + header)
    expect(frame).toContain("…");
    expect(frame).not.toContain("across a narrow pane");
    // the row's title segment is present, truncated, on one line
    expect(frame).toContain("Long title that must");
    setup.renderer.destroy();
  });

  it("truncates a tree-row title with an ellipsis and never wraps", async () => {
    const root = mk({
      id: ".scratch/herdr-frontier/issues/01-a.md",
      title: "01 — Alpha",
    });
    const child = mk({
      id: ".scratch/herdr-frontier/issues/02-b.md",
      title: "02 — Beta with a tree-row title far too long to ever fit the pane",
      blockedBy: ["01"],
    });
    const detail: IssueDetail = { ...root, body: "", comments: [] };
    const setup = await testRender(
      () => (
        <App
          shell={noopShell}
          initialIssues={[root, child]}
          initialDetail={detail}
          initialView="tree"
        />
      ),
      { width: 60, height: 24 },
    );
    await setup.flush();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("…");
    expect(frame).not.toContain("far too long");
    setup.renderer.destroy();
  });

  // Confirmation-gate 05 (Seam 4): the one-shot renderer paints the confirmation
  // overlay over the shell from the initialModal seam — the rulebook's shape
  // (title, context line, body) plus the `[ Cancel  Confirm ]` row with Confirm
  // pre-focused (the `▶` caret marks the focused button in the captured frame).
  // The dim cover is translucent, so the shell stays legible under it (the
  // overlay layers above, not in place of, the two panes). Keyboard interaction
  // (move/confirm/cancel + the dead-key swallow) and the policy/structure skips
  // live in the pure rulebook tests (Seam 1), not here — the renderer is
  // one-shot.
  it("paints the confirmation overlay over the shell via the initialModal seam", async () => {
    const issue = mk({
      id: ".scratch/herdr-frontier/issues/05-confirm.md",
      title: "05 — Confirm rulebook",
    });
    const detail: IssueDetail = { ...issue, body: "", comments: [] };
    const modal: ConfirmDialog = {
      trigger: "dispatch",
      title: "Dispatch #05?",
      context: "#05 — Confirm rulebook",
      body: "Claims #05 and starts an agent in a new pane — work begins now.",
      cancelLabel: "Cancel",
      confirmLabel: "Confirm",
      focusedButton: "confirm",
    };
    const setup = await testRender(
      () => (
        <App
          shell={noopShell}
          initialIssues={[issue]}
          initialDetail={detail}
          initialModal={modal}
        />
      ),
      { width: 100, height: 20 },
    );
    await setup.flush();
    const frame = setup.captureCharFrame();
    // the dim cover is translucent — the two-pane shell stays legible under the
    // overlay (it layers above, not in place of, the panes)
    expect(frame).toContain("◆ herdr-frontier");
    expect(frame).toContain("Issues");
    // the overlay's shape: title, context line, then the body
    expect(frame).toContain("Dispatch #05?");
    expect(frame).toContain("#05 — Confirm rulebook");
    expect(frame).toContain("Claims #05");
    expect(frame).toContain("work begins now.");
    // both buttons, Confirm pre-focused — the ▶ caret marks the focused button
    expect(frame).toContain("[ Cancel ]");
    expect(frame).toContain("▶ Confirm");
    setup.renderer.destroy();
  });

  // Regression for the same seam: no modal prop → no overlay. A plain shell
  // render must not sprout a stray dialog (the modal key is null).
  it("paints no overlay when no dialog is open", async () => {
    const setup = await testRender(
      () => <App shell={noopShell} initialIssues={[mk()]} />,
      { width: 100, height: 20 },
    );
    await setup.flush();
    const frame = setup.captureCharFrame();
    expect(frame).not.toContain("▶ Confirm");
    expect(frame).not.toContain("Dispatch #");
    setup.renderer.destroy();
  });
});
