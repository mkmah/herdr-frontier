import { describe, expect, it } from "bun:test";
import { PLUGIN_CONTEXT_KEY, resolveRepoRoot } from "#/services/config/workspace.js";

describe("resolveRepoRoot", () => {
  it("returns cwd when no plugin context is injected (standalone run)", () => {
    expect(resolveRepoRoot("/repo", undefined)).toBe("/repo");
    expect(resolveRepoRoot("/repo", "")).toBe("/repo");
  });

  it("uses the workspace root herdr injected (the repo the pane was opened against)", () => {
    const ctx = JSON.stringify({ workspace_id: "wW", workspace_cwd: "/users/repo" });
    expect(resolveRepoRoot("/plugin/root", ctx)).toBe("/users/repo");
  });

  it("falls back to the focused pane cwd when workspace_cwd is absent", () => {
    const ctx = JSON.stringify({ focused_pane_cwd: "/users/repo/sub" });
    expect(resolveRepoRoot("/plugin/root", ctx)).toBe("/users/repo/sub");
  });

  it("prefers workspace_cwd over focused_pane_cwd (the repo root, not a subdir)", () => {
    const ctx = JSON.stringify({ workspace_cwd: "/users/repo", focused_pane_cwd: "/users/repo/sub" });
    expect(resolveRepoRoot("/plugin/root", ctx)).toBe("/users/repo");
  });

  it("returns cwd for a malformed or empty-field context", () => {
    expect(resolveRepoRoot("/plugin/root", "{nope")).toBe("/plugin/root");
    expect(resolveRepoRoot("/plugin/root", JSON.stringify({ workspace_cwd: "  " }))).toBe("/plugin/root");
    expect(resolveRepoRoot("/plugin/root", JSON.stringify({}))).toBe("/plugin/root");
  });
});