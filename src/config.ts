// Plugin config (issue 17 — repo > user precedence). Config is two TOML
// layers, both optional, merged with **repo over user** per key:
//   - user:  `<HERDR_PLUGIN_CONFIG_DIR>/herdr-beads.toml` (herdr injects the
//     dir; falls back to `~/.config/herdr/plugins/config/herdr-beads`)
//   - repo:  `<repoRoot>/herdr-beads.toml` — the committed, per-project layer
//     (mirrors the reference sibling `herdr-beads` config-at-repo-root shape)
//
// Shape (the same TOML parses for both layers):
//   [profiles.grilling]  kind = "claude"   args = ["-m", "sonnet"]   # per task type
//   [profiles.research]  kind = "claude"
//   [profiles.implement] kind = "opencode" args = ["-m", "claude-sonnet-4-5"]
//   [profiles.prototype] kind = "pi"
//   [default_profile]    kind = "opencode"
//   [transcripts]        opencode = "sed -n '1,3p'"    # agent kind → extraction command
//
// Model lives raw in `args` (1:1 with herdr's `--` passthrough) — the plugin
// never parses model semantics. A missing/malformed file is loud (throws on
// parse) so a user typo isn't silently swallowed; a missing file is fine.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PROFILES, type AgentProfile, type ProfileKey, type ProfilesConfig } from "./profiles.js";

/** The config filename in each layer's dir. */
export const CONFIG_FILE = "herdr-beads.toml";

/** The env var herdr injects with the plugin's config dir. */
export const USER_CONFIG_DIR_KEY = "HERDR_PLUGIN_CONFIG_DIR";

/** Agent kind → extraction command run over a finished run's snapshot. */
export type TranscriptsConfig = Record<string, string>;

/** The merged, typed plugin config the driver and run-controller consume. */
export interface PluginConfig {
  profiles: ProfilesConfig;
  transcripts: TranscriptsConfig;
}

export interface LoadConfigOptions {
  /** Absolute repo root — the layer a project can commit to pin a model. */
  repoRoot: string;
  /** Override the user config dir (tests; defaults to the env/home path). */
  userConfigDir?: string;
}

/** The user config dir: `$HERDR_PLUGIN_CONFIG_DIR`, else the herdr convention
 *  (`~/.config/herdr/plugins/config/<plugin>`). */
export function defaultUserConfigDir(): string {
  return (
    process.env[USER_CONFIG_DIR_KEY] ??
    join(homedir(), ".config", "herdr", "plugins", "config", "herdr-beads")
  );
}

/** Load and merge the two TOML layers (repo > user) into one typed config. */
export function loadPluginConfig(opts: LoadConfigOptions): PluginConfig {
  const user = readConfigFile(join(opts.userConfigDir ?? defaultUserConfigDir(), CONFIG_FILE));
  const repo = readConfigFile(join(opts.repoRoot, CONFIG_FILE));
  return mergeConfigs(user, repo);
}

/** The raw shape a TOML config file parses to (fields optional/unknown here —
 *  normalization + validation happens in {@link mergeConfigs}). */
export interface RawConfig {
  profiles?: Record<string, RawProfile>;
  default_profile?: RawProfile;
  transcripts?: Record<string, unknown>;
}
export interface RawProfile {
  kind?: unknown;
  args?: unknown;
}

/** Read + parse one layer's TOML; a missing file is null, a malformed one is
 *  a loud parse error (a broken config must not silently fall back). */
function readConfigFile(abs: string): RawConfig | null {
  let raw: string;
  try {
    raw = readFileSync(abs, "utf8");
  } catch {
    return null; // absent layer — nothing to contribute
  }
  return Bun.TOML.parse(raw) as RawConfig;
}

/** A usable profile: a non-empty string `kind` (args optional, coerced to a
 *  string[] — the model flags). Returns null for a bad entry. */
function normalizeProfile(raw: RawProfile | undefined): AgentProfile | null {
  if (!raw || typeof raw.kind !== "string" || raw.kind.trim() === "") return null;
  const args = Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === "string") : [];
  return { kind: raw.kind, args };
}

function normalizeTranscripts(raw: Record<string, unknown> | undefined): TranscriptsConfig {
  const out: TranscriptsConfig = {};
  if (!raw) return out;
  for (const [kind, command] of Object.entries(raw)) {
    if (typeof command === "string" && command.trim() !== "") out[kind] = command;
  }
  return out;
}

/** The pure repo-over-user merge. `user` and `repo` are the raw parsed layers
 *  (null = absent); every key resolves repo-first, then user, then defaults. */
export function mergeConfigs(user: RawConfig | null, repo: RawConfig | null): PluginConfig {
  const profiles: Partial<Record<ProfileKey, AgentProfile>> = {};
  const keys: ProfileKey[] = ["grilling", "research", "implement", "prototype"];
  for (const key of keys) {
    const p = normalizeProfile(repo?.profiles?.[key]) ?? normalizeProfile(user?.profiles?.[key]);
    if (p) profiles[key] = p;
  }
  const defaultProfile =
    normalizeProfile(repo?.default_profile) ?? normalizeProfile(user?.default_profile) ?? DEFAULT_PROFILES.default_profile;
  const transcripts = {
    ...normalizeTranscripts(user?.transcripts),
    ...normalizeTranscripts(repo?.transcripts),
  };
  return { profiles: { profiles, default_profile: defaultProfile }, transcripts };
}