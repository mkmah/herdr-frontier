// Plugin-config tests (issue 17 — repo > user precedence). Config is two TOML
// layers: the user's global config (`HERDR_PLUGIN_CONFIG_DIR`/`herdr-frontier.toml`)
// and a repo-root `herdr-frontier.toml`; the repo layer wins per-key. Tested over
// temp dirs with no plugin config present anywhere real.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rm, mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONFIG_FILE,
  USER_CONFIG_DIR_KEY,
  defaultUserConfigDir,
  loadPluginConfig,
  mergeConfigs,
  type PluginConfig,
} from "./config.js";
import { DEFAULT_PROFILES } from "./profiles.js";

let repoRoot: string;
let userDir: string;

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), "beads-cfg-repo-"));
  userDir = await mkdtemp(join(tmpdir(), "beads-cfg-user-"));
});

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
  await rm(userDir, { recursive: true, force: true });
});

async function writeRepo(toml: string) {
  await writeFile(join(repoRoot, CONFIG_FILE), toml, "utf8");
}
async function writeUser(toml: string) {
  await writeFile(join(userDir, CONFIG_FILE), toml, "utf8");
}

const USER_TOML = `
[profiles.grilling]
kind = "claude"
args = ["-m", "sonnet"]

[profiles.implement]
kind = "opencode"

[default_profile]
kind = "pi"
args = ["--model", "gemini-2.0"]

[transcripts]
claude = "tail -n 5"
`;

const REPO_TOML = `
[profiles.implement]
kind = "opencode"
args = ["-m", "claude-sonnet-4-5"]

[default_profile]
kind = "opencode"

[transcripts]
opencode = "sed -n '1,3p'"
`;

describe("loadPluginConfig — two TOML layers, repo > user (issue 17)", () => {
  it("returns the shipped defaults when neither layer exists", () => {
    const cfg = loadPluginConfig({ repoRoot, userConfigDir: userDir });
    expect(cfg.profiles).toEqual(DEFAULT_PROFILES);
    expect(cfg.transcripts).toEqual({});
  });

  it("reads a user-only config (profiles + default_profile + transcripts)", async () => {
    await writeUser(USER_TOML);
    const cfg = loadPluginConfig({ repoRoot, userConfigDir: userDir });
    expect(cfg.profiles.profiles.grilling).toEqual({ kind: "claude", args: ["-m", "sonnet"] });
    expect(cfg.profiles.profiles.implement).toEqual({ kind: "opencode", args: [] });
    expect(cfg.profiles.default_profile).toEqual({ kind: "pi", args: ["--model", "gemini-2.0"] });
    expect(cfg.transcripts).toEqual({ claude: "tail -n 5" });
  });

  it("reads a repo-only config", async () => {
    await writeRepo(REPO_TOML);
    const cfg = loadPluginConfig({ repoRoot, userConfigDir: userDir });
    expect(cfg.profiles.profiles.implement).toEqual({ kind: "opencode", args: ["-m", "claude-sonnet-4-5"] });
    expect(cfg.profiles.default_profile).toEqual({ kind: "opencode", args: [] });
    expect(cfg.transcripts).toEqual({ opencode: "sed -n '1,3p'" });
  });

  it("precedence is repo over user — a repo key wins, and both layers' keys survive", async () => {
    await writeUser(USER_TOML);
    await writeRepo(REPO_TOML);
    const cfg = loadPluginConfig({ repoRoot, userConfigDir: userDir });
    // repo wins on the keys both layers define…
    expect(cfg.profiles.profiles.implement).toEqual({ kind: "opencode", args: ["-m", "claude-sonnet-4-5"] });
    expect(cfg.profiles.default_profile).toEqual({ kind: "opencode", args: [] });
    // …and user-only keys survive the merge.
    expect(cfg.profiles.profiles.grilling).toEqual({ kind: "claude", args: ["-m", "sonnet"] });
    expect(cfg.transcripts).toEqual({ claude: "tail -n 5", opencode: "sed -n '1,3p'" });
  });

  it("skips a profile entry with no usable kind (falls back to the other layer)", async () => {
    await writeUser(`[profiles.implement]\nkind = "opencode"\n`);
    await writeRepo(`[profiles.implement]\nargs = ["-m", "x"]\n`);
    const cfg = loadPluginConfig({ repoRoot, userConfigDir: userDir });
    // The repo entry has no kind → skipped, so the user's entry wins.
    expect(cfg.profiles.profiles.implement).toEqual({ kind: "opencode", args: [] });
  });

  it("loudly throws on a malformed TOML file (a user typo must not silently vanish)", async () => {
    await writeUser("[profiles.grilling\nkind = 'broken'");
    expect(() => loadPluginConfig({ repoRoot, userConfigDir: userDir })).toThrow(/parse toml/i);
  });
});

describe("mergeConfigs — the pure repo > user merge", () => {
  it("repo overrides user per key, user fills the gaps", () => {
    const cfg: PluginConfig = mergeConfigs(
      {
        profiles: {
          grilling: { kind: "claude", args: ["-m", "sonnet"] },
          research: { kind: "claude", args: [] },
        },
        default_profile: { kind: "claude", args: [] },
        transcripts: { claude: "tail -n 5" },
      },
      {
        profiles: { grilling: { kind: "opencode", args: [] } },
        default_profile: { kind: "opencode", args: [] },
        transcripts: { opencode: "head -n 3" },
      },
    );
    expect(cfg.profiles.profiles.grilling).toEqual({ kind: "opencode", args: [] }); // repo wins
    expect(cfg.profiles.profiles.research).toEqual({ kind: "claude", args: [] }); // user survives
    expect(cfg.profiles.default_profile).toEqual({ kind: "opencode", args: [] });
    expect(cfg.transcripts).toEqual({ claude: "tail -n 5", opencode: "head -n 3" });
  });

  it("a null layer contributes nothing (defaults stand)", () => {
    const cfg = mergeConfigs(null, null);
    expect(cfg.profiles).toEqual(DEFAULT_PROFILES);
    expect(cfg.transcripts).toEqual({});
  });

  it("ignores non-string transcript values", () => {
    const cfg = mergeConfigs({ transcripts: { a: 3 as unknown as string, b: "ok" } }, null);
    expect(cfg.transcripts).toEqual({ b: "ok" });
  });
});

describe("defaultUserConfigDir — where the user config lives", () => {
  it("uses HERDR_PLUGIN_CONFIG_DIR when set", () => {
    process.env[USER_CONFIG_DIR_KEY] = "/tmp/custom-cfg";
    try {
      expect(defaultUserConfigDir()).toBe("/tmp/custom-cfg");
    } finally {
      delete process.env[USER_CONFIG_DIR_KEY];
    }
  });

  it("falls back to ~/.config/herdr/plugins/config/herdr-frontier", () => {
    delete process.env[USER_CONFIG_DIR_KEY];
    expect(defaultUserConfigDir()).toBe(
      join((process.env.HOME ?? process.env.HOMEDRIVE ?? "/"), ".config", "herdr", "plugins", "config", "herdr-frontier"),
    );
  });
});