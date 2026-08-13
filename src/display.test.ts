// Display-helper unit tests (issue 10 acceptance) — the pure derivations behind
// the two-pane shell: list state, icon precedence (done > human > running >
// blocked > frontier), human-turn detection, age humanization, focus cycling,
// blocker resolution, and the theme's state colors. No OpenTUI harness needed —
// these are plain functions over `Issue` records.

import { describe, it, expect } from "bun:test";
import type { Issue } from "./tracker/provider.js";
import {
  cycleFocus,
  humanizeAge,
  iconFor,
  isHumanTurn,
  listStateOf,
  type ListState,
} from "./display.js";
import { iconColorFor, stateColor } from "./theme.js";
import { blockerResolved } from "./logic.js";

const mk = (over: Partial<Issue> = {}): Issue => ({
  id: ".scratch/herdr-beads/issues/10-shell.md",
  title: "10 — Shell",
  status: "open",
  type: "task",
  labels: ["ready-for-agent"],
  assignee: null,
  blockedBy: [],
  ...over,
});

describe("listStateOf", () => {
  const resolved = (id: string) => id === ".scratch/e/issues/05-iface.md" || id === "05";

  it("is done for a resolved issue (even one labeled for a human)", () => {
    expect(listStateOf(mk({ status: "resolved", labels: ["ready-for-human"] }), () => false)).toBe(
      "done",
    );
  });
  it("is running for a claimed issue", () => {
    expect(listStateOf(mk({ status: "claimed" }), () => false)).toBe("running");
  });
  it("is blocked when any blocker is unresolved", () => {
    expect(listStateOf(mk({ blockedBy: ["05"] }), () => false)).toBe("blocked");
  });
  it("is frontier when open, unclaimed, and every blocker resolves", () => {
    expect(listStateOf(mk({ blockedBy: ["05"] }), resolved)).toBe("frontier");
  });
  it("is always one of the four list states", () => {
    const states: ListState[] = ["done", "running", "blocked", "frontier"];
    for (const issue of [
      mk({ status: "resolved" }),
      mk({ status: "claimed" }),
      mk({ blockedBy: ["x"] }),
      mk(),
    ]) {
      expect(states).toContain(listStateOf(issue, () => true));
    }
  });
});

describe("isHumanTurn", () => {
  it("is true for the three human labels and false for agent/wontfix", () => {
    expect(isHumanTurn(mk({ labels: ["ready-for-human"] }))).toBe(true);
    expect(isHumanTurn(mk({ labels: ["needs-info"] }))).toBe(true);
    expect(isHumanTurn(mk({ labels: ["needs-triage"] }))).toBe(true);
    expect(isHumanTurn(mk({ labels: ["ready-for-agent"] }))).toBe(false);
    expect(isHumanTurn(mk({ labels: ["wontfix"] }))).toBe(false);
  });
  it("defaults an unlabeled issue to needs-triage → human turn", () => {
    expect(isHumanTurn(mk({ labels: ["wayfinder:research"] }))).toBe(true);
  });
});

describe("iconFor precedence: done > human > running > blocked > frontier", () => {
  const resolved = () => false;
  it("shows ✓ for a resolved issue", () => {
    expect(iconFor(mk({ status: "resolved", labels: ["ready-for-human"] }), resolved)).toBe("✓");
  });
  it("shows ☻ for a human turn, beating running and blocked", () => {
    expect(iconFor(mk({ status: "claimed", labels: ["ready-for-human"] }), resolved)).toBe("☻");
    expect(iconFor(mk({ labels: ["needs-info"], blockedBy: ["05"] }), resolved)).toBe("☻");
  });
  it("shows ⟳ for a claimed agent issue", () => {
    expect(iconFor(mk({ status: "claimed" }), resolved)).toBe("⟳");
  });
  it("shows ✗ for a blocked open issue", () => {
    expect(iconFor(mk({ blockedBy: ["05"] }), resolved)).toBe("✗");
  });
  it("shows ○ for a frontier issue", () => {
    expect(iconFor(mk(), resolved)).toBe("○");
  });
});

describe("humanizeAge", () => {
  const now = 1_000_000_000_000;
  it("humanizes down to now / m / h / d / w / mo", () => {
    expect(humanizeAge(now, now)).toBe("now");
    expect(humanizeAge(now - 30_000, now)).toBe("now");
    expect(humanizeAge(now - 5 * 60_000, now)).toBe("5m");
    expect(humanizeAge(now - 5 * 3_600_000, now)).toBe("5h");
    expect(humanizeAge(now - 3 * 86_400_000, now)).toBe("3d");
    expect(humanizeAge(now - 7 * 86_400_000, now)).toBe("1w");
    expect(humanizeAge(now - 45 * 86_400_000, now)).toBe("1mo");
  });
  it("clamps a future timestamp to now", () => {
    expect(humanizeAge(now + 10_000, now)).toBe("now");
  });
});

describe("cycleFocus", () => {
  it("toggles between list and detail", () => {
    expect(cycleFocus("list")).toBe("detail");
    expect(cycleFocus("detail")).toBe("list");
  });
});

describe("blockerResolved", () => {
  const issues = [
    mk({ id: ".scratch/herdr-beads/issues/05-iface.md", status: "resolved" }),
    mk({ id: ".scratch/herdr-beads/issues/06-prototype.md", status: "open" }),
  ];
  it("matches a blocker by numeric prefix and by full id", () => {
    expect(blockerResolved("05", issues)).toBe(true);
    expect(blockerResolved(".scratch/herdr-beads/issues/05-iface.md", issues)).toBe(true);
  });
  it("is false for an open or unknown blocker", () => {
    expect(blockerResolved("06", issues)).toBe(false);
    expect(blockerResolved("99", issues)).toBe(false);
  });
});

describe("theme: stateColor + iconColorFor", () => {
  const resolved = () => false;
  it("maps every state key to the locked palette", () => {
    expect(stateColor("done")).toBe("#06d6a0");
    expect(stateColor("running")).toBe("#e9b94e");
    expect(stateColor("blocked")).toBe("#ef476f");
    expect(stateColor("frontier")).toBe("#48cae4");
    expect(stateColor("human")).toBe("#f8961e");
  });
  it("colors the icon by the same precedence as the glyph", () => {
    expect(iconColorFor(mk({ status: "resolved" }), resolved, false)).toBe("#06d6a0");
    expect(iconColorFor(mk({ status: "claimed" }), resolved, false)).toBe("#e9b94e");
    expect(iconColorFor(mk({ blockedBy: ["x"] }), resolved, false)).toBe("#ef476f");
    expect(iconColorFor(mk(), resolved, false)).toBe("#48cae4");
    expect(iconColorFor(mk({ labels: ["ready-for-human"] }), resolved, false)).toBe("#f8961e");
    expect(iconColorFor(mk({ labels: ["ready-for-human"] }), resolved, true)).toBe("#ffd166");
  });
});
