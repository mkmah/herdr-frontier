// Agent profiles (CONTEXT.md: Profile) — a `{ kind, args }` agent configuration
// bound per task-type, with the model passed raw in `args` (1:1 with herdr's
// `--` passthrough). Manual dispatch (issue 12) uses the *minimal*
// shape: `resolveProfile` picks the per-type entry or falls back to
// `default_profile`. The full per-task-type config with repo > user precedence
// lands in issue 17; the seam below is what it will extend.

import type { Issue } from "./tracker/provider.js";

export interface AgentProfile {
  /** One of herdr's 21 agent kinds (e.g. "opencode", "claude", "pi"). */
  kind: string;
  /** Model/tool flags passed raw after `herdr agent start … --`. */
  args: string[];
}

/** The profile key for each profile-bound task type (CONTEXT.md: Profile). */
export type ProfileKey = "grilling" | "research" | "implement" | "prototype";

export interface ProfilesConfig {
  /** Per-task-type agent configuration; missing keys fall back to the default. */
  profiles: Partial<Record<ProfileKey, AgentProfile>>;
  /** The default agent kind covering unspecified task types. */
  default_profile: AgentProfile;
}

/** The shipped minimal profile: no per-type overrides, everything uses the default. */
export const DEFAULT_PROFILES: ProfilesConfig = {
  profiles: {},
  default_profile: { kind: "opencode", args: [] },
};

/** Resolve the profile for a task type: the per-type entry, else the default. */
export function resolveProfile(config: ProfilesConfig, key: ProfileKey): AgentProfile {
  return config.profiles[key] ?? config.default_profile;
}

/** The profile key an Issue's task type maps to; local-markdown `task` → implement. */
export function profileKeyFor(issue: Issue): ProfileKey {
  switch (issue.type) {
    case "grilling":
      return "grilling";
    case "research":
      return "research";
    case "prototype":
      return "prototype";
    case "task":
      return "implement";
  }
}