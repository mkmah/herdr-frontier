// Profile tests (issue 12 acceptance): the minimal profile + `default_profile`
// mechanic the manual dispatch uses. `resolveProfile` picks the per
// task-type `{ kind, args }` entry or falls back to `default_profile`; the model
// passes through raw in `args` (1:1 with herdr's `--` passthrough). Full
// per-task-type profiles with repo > user precedence land in issue 17.

import { describe, it, expect } from "bun:test";
import type { Issue } from "#/services/tracker/provider.js";
import {
  DEFAULT_PROFILES,
  profileKeyFor,
  resolveProfile,
} from "#/lib/profiles.js";
import { idEffort, idNum, idOrder } from "#/services/tracker/local-markdown.js";

const mk = (over: Partial<Issue> = {}): Issue => {
  const id = over.id ?? ".scratch/herdr-frontier/issues/12-driver.md";
  return {
    id,
    effort: idEffort(id),
    num: idNum(id),
    order: idOrder(id),
    title: "12 — Driver",
    status: "open",
    type: "task",
    labels: ["ready-for-agent"],
    assignee: null,
    blockedBy: [],
    ...over,
  };
};

describe("resolveProfile", () => {
  const config = {
    profiles: {
      research: { kind: "claude", args: ["-m", "sonnet"] },
      implement: { kind: "opencode", args: [] },
    },
    default_profile: { kind: "pi", args: ["--model", "gemini-2.0"] },
  };

  it("returns the per-task-type profile when it exists", () => {
    expect(resolveProfile(config, "research")).toEqual({ kind: "claude", args: ["-m", "sonnet"] });
    expect(resolveProfile(config, "implement")).toEqual({ kind: "opencode", args: [] });
  });

  it("falls back to default_profile for unspecified types (the minimal profile)", () => {
    expect(resolveProfile(config, "grilling")).toEqual({ kind: "pi", args: ["--model", "gemini-2.0"] });
    expect(resolveProfile(config, "prototype")).toEqual({ kind: "pi", args: ["--model", "gemini-2.0"] });
  });

  it("passes the model through raw in args", () => {
    expect(resolveProfile(config, "research").args).toEqual(["-m", "sonnet"]);
  });
});

describe("profileKeyFor", () => {
  it("maps the IssueType research/prototype/grilling to its own key and task to implement", () => {
    expect(profileKeyFor(mk({ type: "research" }))).toBe("research");
    expect(profileKeyFor(mk({ type: "prototype" }))).toBe("prototype");
    expect(profileKeyFor(mk({ type: "grilling" }))).toBe("grilling");
    expect(profileKeyFor(mk({ type: "task" }))).toBe("implement");
  });

  it("DEFAULT_PROFILES is a functioning minimal profile (default falls back to itself)", () => {
    for (const key of ["grilling", "research", "implement", "prototype"] as const) {
      const p = resolveProfile(DEFAULT_PROFILES, key);
      expect(p.kind).toBe(DEFAULT_PROFILES.default_profile.kind);
      expect(p.args).toEqual([]);
    }
  });
});