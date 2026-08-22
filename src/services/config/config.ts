// Plugin config (issue 17 — repo > user precedence). Config is two TOML
// layers, both optional, merged with **repo over user** per key:
//   - user:  `<HERDR_PLUGIN_CONFIG_DIR>/herdr-frontier.toml` (herdr injects the
//     dir; falls back to `~/.config/herdr/plugins/config/herdr-frontier`)
//   - repo:  `<repoRoot>/herdr-frontier.toml` — the committed, per-project layer
//     (mirrors the reference sibling `herdr-frontier` config-at-repo-root shape)
//
// Shape (the same TOML parses for both layers):
//   [profiles.grilling]  kind = "claude"   args = ["-m", "sonnet"]   # per task type
//   [profiles.research]  kind = "claude"
//   [profiles.implement] kind = "opencode" args = ["-m", "claude-sonnet-4-5"]
//   [profiles.prototype] kind = "pi"
//   [default_profile]    kind = "opencode"
//   [transcripts]        opencode = "sed -n '1,3p'"    # agent kind → extraction command
//   [confirm]            dispatch  = false             # false suppresses that action's gate
//                       release   = false             # true / absent keep it (default: all confirm)
//                       run_start = false
//                       run_stop  = false
//
// Model lives raw in `args` (1:1 with herdr's `--` passthrough) — the plugin
// never parses model semantics. A missing/malformed file is loud (throws on
// parse) so a user typo isn't silently swallowed; a missing file is fine. A
// non-boolean `[confirm]` value is loud the same way (confirmation-gate 04) —
// a typo'd value is never silently dropped.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PROFILES, type AgentProfile, type ProfileKey, type ProfilesConfig } from "#/lib/profiles.js";
import type { ConfirmPolicy, ConfirmationTrigger } from "#/lib/confirm.js";

/** The config filename in each layer's dir. */
export const CONFIG_FILE = "herdr-frontier.toml";

/** The env var herdr injects with the plugin's config dir. */
export const USER_CONFIG_DIR_KEY = "HERDR_PLUGIN_CONFIG_DIR";

/** Agent kind → extraction command run over a finished run's snapshot. */
export type TranscriptsConfig = Record<string, string>;

/** The merged, typed plugin config the driver and run-controller consume. */
export interface PluginConfig {
  profiles: ProfilesConfig;
  transcripts: TranscriptsConfig;
  /** The confirmation-gate bypass: `false` per trigger suppresses that action's
   *  gate; absent and `true` keep it, so an empty config leaves every gate on. */
  confirm: ConfirmPolicy;
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
    join(homedir(), ".config", "herdr", "plugins", "config", "herdr-frontier")
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
  /** The `[confirm]` table: the four Confirmable actions → a boolean (`false`
   *  suppresses that action's gate). Unvalidated here — normalization throws
   *  on a non-boolean value (confirmation-gate 04). */
  confirm?: Record<string, unknown>;
}
export interface RawProfile {
  kind?: unknown;
  args?: unknown;
}

/** Read + parse one layer's TOML; a missing file is null, a malformed one is
 *  a loud parse error (a broken config must not silently fall back). The error
 *  is wrapped with our own stable message naming the file — the underlying
 *  parser's wording is version-dependent and must not leak. */
function readConfigFile(abs: string): RawConfig | null {
  let raw: string;
  try {
    raw = readFileSync(abs, "utf8");
  } catch {
    return null; // absent layer — nothing to contribute
  }
  try {
    return Bun.TOML.parse(raw) as RawConfig;
  } catch (e) {
    throw new Error(`failed to parse toml ${abs}: ${e instanceof Error ? e.message : String(e)}`);
  }
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

/** The `[confirm]` table's TOML key for each trigger — `run_start`/`run_stop`
 *  are snake_case in the config, the trigger vocabulary (issue 03) hyphenated. */
const CONFIRM_TABLE_KEYS: Record<ConfirmationTrigger, string> = {
  dispatch: "dispatch",
  release: "release",
  "run-start": "run_start",
  "run-stop": "run_stop",
};

/** Normalize one layer's `[confirm]` table into the policy. Only a boolean is
 *  valid: `false` suppresses that trigger's gate, `true` records the explicit
 *  keep (needed so the merge can override a lower layer's `false`). A
 *  non-boolean value is dropped loudly — the module's malformed-file idiom, a
 *  user typo is never silently swallowed: the whole load throws naming the key
 *  (confirmation-gate 04). Keys absent from the table contribute nothing. */
function normalizeConfirm(raw: Record<string, unknown> | undefined): ConfirmPolicy {
  const out: ConfirmPolicy = {};
  if (!raw) return out;
  for (const trigger of Object.keys(CONFIRM_TABLE_KEYS) as ConfirmationTrigger[]) {
    const key = CONFIRM_TABLE_KEYS[trigger];
    if (!(key in raw)) continue;
    const value = raw[key];
    if (typeof value !== "boolean") {
      throw new Error(`[confirm] ${key} must be a boolean (true/false), got ${JSON.stringify(value)}`);
    }
    out[trigger] = value;
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
  // `[confirm]` merges the same way — repo over user per key; a key absent from
  // both layers stays absent (the "confirm" default, every gate on).
  const confirm = {
    ...normalizeConfirm(user?.confirm),
    ...normalizeConfirm(repo?.confirm),
  };
  return { profiles: { profiles, default_profile: defaultProfile }, transcripts, confirm };
}