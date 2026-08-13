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
import { iconColor, stateColor, triageColor } from "./theme.js";
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
  const glyph = (issue: Issue) => iconFor(issue, resolved).glyph;
  it("shows ✓ for a resolved issue", () => {
    expect(glyph(mk({ status: "resolved", labels: ["ready-for-human"] }))).toBe("✓");
  });
  it("shows ☻ for a human turn, beating running and blocked", () => {
    expect(glyph(mk({ status: "claimed", labels: ["ready-for-human"] }))).toBe("☻");
    expect(glyph(mk({ labels: ["needs-info"], blockedBy: ["05"] }))).toBe("☻");
  });
  it("shows ⟳ for a claimed agent issue", () => {
    expect(glyph(mk({ status: "claimed" }))).toBe("⟳");
  });
  it("shows ✗ for a blocked open issue", () => {
    expect(glyph(mk({ blockedBy: ["05"] }))).toBe("✗");
  });
  it("shows ○ for a frontier issue", () => {
    expect(glyph(mk())).toBe("○");
  });
  it("resolves the icon state so the theme can color it", () => {
    expect(iconFor(mk({ status: "resolved" }), resolved).state).toBe("done");
    expect(iconFor(mk(), resolved).state).toBe("frontier");
    expect(iconFor(mk({ labels: ["ready-for-human"] }), resolved).state).toBe("human");
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
  const ref = mk(); // .scratch/herdr-beads/issues/10-shell.md — same effort as the fixture
  it("matches a blocker by numeric prefix and by full id, within the same effort", () => {
    expect(blockerResolved("05", ref, issues)).toBe(true);
    expect(blockerResolved(".scratch/herdr-beads/issues/05-iface.md", ref, issues)).toBe(true);
  });
  it("is false for an open or unknown blocker", () => {
    expect(blockerResolved("06", ref, issues)).toBe(false);
    expect(blockerResolved("99", ref, issues)).toBe(false);
  });
  it("scopes numeric prefixes to the referencing issue's effort", () => {
    const other = mk({ id: ".scratch/other-effort/issues/05-elsewhere.md", status: "resolved" });
    const crossRef = mk({ id: ".scratch/other-effort/issues/10-cross.md" });
    expect(blockerResolved("05", crossRef, issues)).toBe(false); // a foreign effort's resolved "05" does not match
    expect(blockerResolved("05", crossRef, [...issues, other])).toBe(true); // its own effort's "05" does
  });
});

describe("theme: stateColor + iconColor + triageColor", () => {
  it("maps every state key to the locked palette", () => {
    expect(stateColor("done")).toBe("#06d6a0");
    expect(stateColor("running")).toBe("#e9b94e");
    expect(stateColor("blocked")).toBe("#ef476f");
    expect(stateColor("frontier")).toBe("#48cae4");
    expect(stateColor("human")).toBe("#f8961e");
  });
  it("colors the icon by its resolved state, with a human pulse phase", () => {
    expect(iconColor("done", false)).toBe("#06d6a0");
    expect(iconColor("running", false)).toBe("#e9b94e");
    expect(iconColor("blocked", false)).toBe("#ef476f");
    expect(iconColor("frontier", false)).toBe("#48cae4");
    expect(iconColor("human", false)).toBe("#f8961e");
    expect(iconColor("human", true)).toBe("#ffd166");
  });
  it("maps triage labels onto the palette, wayfinder to brand", () => {
    expect(triageColor("ready-for-agent")).toBe("#48cae4");
    expect(triageColor("ready-for-human")).toBe("#f8961e");
    expect(triageColor("needs-info")).toBe("#bb9af7");
    expect(triageColor("needs-triage")).toBe("#bb9af7");
    expect(triageColor("wontfix")).toBe("#ef476f");
    expect(triageColor("wayfinder:map")).toBe("#7aa2f7");
    expect(triageColor("unknown")).toBe("#5c6678");
  });
});
