// Compile the OpenTUI/Solid render layer into a self-contained binary.
//
// `bun build --compile` alone is not enough: the app is JSX/Solid and needs the
// Solid transform plugin applied at build time (the `@opentui/solid/preload`
// runtime transpiler is passed to `bun run` explicitly — see the `dev` script —
// and must never live in a `bunfig.toml`, because compiled binaries read
// bunfig.toml from their cwd and would die at runtime with
// `preload not found` — see ADR-0002).
//
// Output lands at `bin/herdr-frontier` — Bun names a compiled binary after the
// entrypoint's directory ("src"), so we build into `bin/` and rename.
//
// Run: bun run scripts/build.ts

import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin";

const here = import.meta.dir;
const repoRoot = join(here, "..");
const outdir = join(repoRoot, "bin");
mkdirSync(outdir, { recursive: true });

const result = await Bun.build({
  entrypoints: [join(repoRoot, "src", "index.tsx")],
  outdir,
  target: "bun",
  compile: true,
  plugins: [createSolidTransformPlugin()],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

renameSync(join(outdir, "src"), join(outdir, "herdr-frontier"));
console.log("built bin/herdr-frontier");