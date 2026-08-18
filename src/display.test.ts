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
  listStateOf,
  trackClick,
  wheelDelta,
  MouseButton,
  type ListState,
} from "./display.js";
import { iconColor, stateColor, triageColor } from "./theme.js";
import { attention, blockerResolved } from "./logic.js";
import { idEffort, idNum, idOrder } from "./tracker/local-markdown.js";

const mk = (over: Partial<Issue> = {}): Issue => {
  const id = over.id ?? ".scratch/herdr-frontier/issues/10-shell.md";
  return {
    id,
    effort: idEffort(id),
    num: idNum(id),
    order: idOrder(id),
    title: "10 — Shell",
    status: "open",
    type: "task",
    labels: ["ready-for-agent"],
    assignee: null,
    blockedBy: [],
    ...over,
  };
};

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

describe("attention — the shared human-turn predicate (Card 4)", () => {
  it("marks the three human labels and clears agent/wontfix", () => {
    expect(attention(mk({ labels: ["ready-for-human"] }))).not.toBeNull();
    expect(attention(mk({ labels: ["needs-info"] }))).not.toBeNull();
    expect(attention(mk({ labels: ["needs-triage"] }))).not.toBeNull();
    expect(attention(mk({ labels: ["ready-for-agent"] }))).toBeNull();
    expect(attention(mk({ labels: ["wontfix"] }))).toBeNull();
  });
  it("defaults an unlabeled issue to needs-triage → human attention", () => {
    expect(attention(mk({ labels: ["wayfinder:research"] }))).not.toBeNull();
  });
  it("splits the kinds: ready-for-human/blocked = notify, needs-info/-triage = marker only", () => {
    expect(attention(mk({ labels: ["ready-for-human"] }))).toBe("notify");
    expect(attention(mk({ labels: ["needs-info"] }))).toBe("human");
    expect(attention(mk({ labels: ["needs-triage"] }))).toBe("human");
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

// Issue 13: agent-blocked is a human-turn (CONTEXT.md: Attention lane — label
// state PLUS agent state). A dispatched agent that went `blocked` shows the same
// pulsing ☻ as a `ready-for-human` issue — it needs a human now.
describe("iconFor / attention: agent-blocked attention (issue 13)", () => {
  const resolved = () => false;
  it("shows ☻ for a claimed issue whose dispatched agent is blocked", () => {
    expect(iconFor(mk({ status: "claimed" }), resolved, "blocked").glyph).toBe("☻");
    expect(iconFor(mk({ status: "claimed" }), resolved, "blocked").state).toBe("human");
  });
  it("shows ⟳ for a claimed issue whose agent is working/idle/done (not blocked)", () => {
    expect(iconFor(mk({ status: "claimed" }), resolved, "working").glyph).toBe("⟳");
    expect(iconFor(mk({ status: "claimed" }), resolved, "idle").glyph).toBe("⟳");
    expect(iconFor(mk({ status: "claimed" }), resolved, "done").glyph).toBe("⟳");
  });
  it("agent-blocked beats a dependency blocker (human attention > blocked)", () => {
    expect(iconFor(mk({ status: "claimed", blockedBy: ["05"] }), resolved, "blocked").glyph).toBe("☻");
  });
  it("a resolved issue stays ✓ even if its agent is blocked (done > human)", () => {
    expect(iconFor(mk({ status: "resolved" }), resolved, "blocked").glyph).toBe("✓");
  });
  it("a label human-turn still shows ☻ regardless of agent status", () => {
    expect(iconFor(mk({ status: "claimed", labels: ["ready-for-human"] }), resolved, "working").glyph).toBe("☻");
  });
  it("attention is notify for an agent-blocked claimed issue", () => {
    expect(attention(mk({ status: "claimed" }), "blocked")).toBe("notify");
    expect(attention(mk({ status: "claimed" }), "working")).toBeNull();
  });
  it("attention stays notify for a ready-for-human label regardless of agent status", () => {
    expect(attention(mk({ labels: ["ready-for-human"] }), "working")).toBe("notify");
    expect(attention(mk({ labels: ["ready-for-human"] }), undefined)).toBe("notify");
  });
  it("attention without agent status matches the label-only rule", () => {
    expect(attention(mk({ labels: ["ready-for-agent"] }))).toBeNull();
    expect(attention(mk({ labels: ["ready-for-human"] }))).toBe("notify");
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

// Issue 16: the mouse seam — the pure derivations behind the shell's pointer
// handling, extracted so they're testable without the OpenTUI harness: the
// double-click state machine and the wheel-to-delta mapping.
describe("trackClick (issue 16 mouse)", () => {
  it("returns a single click with a pending record on the first click", () => {
    expect(trackClick(null, "05", 1000)).toEqual({ double: false, next: { id: "05", at: 1000 } });
  });
  it("fires a double-click when the same id returns inside the window", () => {
    expect(trackClick({ id: "05", at: 1000 }, "05", 1300)).toEqual({ double: true, next: null });
  });
  it("resets so a third click inside the window is a fresh single", () => {
    const first = trackClick(null, "05", 1000);
    const second = trackClick(first.next, "05", 1300);
    expect(second.double).toBe(true);
    const third = trackClick(second.next, "05", 1400);
    expect(third).toEqual({ double: false, next: { id: "05", at: 1400 } });
  });
  it("is a single when a different row is clicked", () => {
    expect(trackClick({ id: "05", at: 1000 }, "06", 1100)).toEqual({
      double: false,
      next: { id: "06", at: 1100 },
    });
  });
  it("is a single when the click lands outside the window", () => {
    expect(trackClick({ id: "05", at: 1000 }, "05", 1400)).toEqual({
      double: false,
      next: { id: "05", at: 1400 },
    });
  });
});

describe("wheelDelta (issue 16 mouse)", () => {
  it("maps wheel up to -1 and wheel down to +1", () => {
    expect(wheelDelta(MouseButton.WHEEL_UP)).toBe(-1);
    expect(wheelDelta(MouseButton.WHEEL_DOWN)).toBe(1);
  });
  it("maps every non-wheel button to 0", () => {
    expect(wheelDelta(MouseButton.LEFT)).toBe(0);
    expect(wheelDelta(MouseButton.MIDDLE)).toBe(0);
    expect(wheelDelta(MouseButton.RIGHT)).toBe(0);
  });
});

describe("blockerResolved", () => {
  const issues = [
    mk({ id: ".scratch/herdr-frontier/issues/05-iface.md", status: "resolved" }),
    mk({ id: ".scratch/herdr-frontier/issues/06-prototype.md", status: "open" }),
  ];
  const ref = mk(); // .scratch/herdr-frontier/issues/10-shell.md — same effort as the fixture
  it("matches a blocker by numeric prefix and by full id, within the same effort", () => {
    expect(blockerResolved("05", ref, issues)).toBe(true);
    expect(blockerResolved(".scratch/herdr-frontier/issues/05-iface.md", ref, issues)).toBe(true);
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
