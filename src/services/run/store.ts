// The run module's persistence seam (issue 14) — where run records live (the
// plugin state dir shape). One adapter today (FileRunStore); the seam exists so
// the controller steps against an injectable store in tests, and so a future
// remote substrate could persist runs elsewhere without touching the advance
// state machine (/advance.ts) or the controller (/controller.ts).

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunState } from "#/services/run/advance.js";

/** How long a terminal (completed/stopped) run record is kept before prune. */
export const DEFAULT_RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** The persistence seam: where run records live (the plugin state dir shape). */
export interface RunStore {
  load(root: string): RunState | null;
  save(run: RunState): void;
  all(): RunState[];
  remove(root: string): void;
  /** Delete terminal (completed/stopped) runs older than `maxAgeMs` — the
   *  cleanup that stops the state dir growing unboundedly. Running runs and
   *  recent terminal ones survive. */
  prune(maxAgeMs?: number): void;
}

function sanitize(s: string): string {
  const out = s.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/(^-+)|(-+$)/g, "");
  return out || "root";
}

/** The filesystem store: one JSON file per run-root under the state dir's
 *  `runs/` (one file per run-root keeps growth bounded by the number of
 *  efforts; prune drops terminal runs after the retention window). */
export class FileRunStore implements RunStore {
  private readonly dir: string;

  constructor(opts: { dir: string }) {
    this.dir = opts.dir;
  }

  private fileFor(root: string): string {
    return join(this.dir, `${sanitize(root)}.json`);
  }

  load(root: string): RunState | null {
    try {
      const parsed = JSON.parse(readFileSync(this.fileFor(root), "utf8")) as RunState;
      return parsed.root === root ? parsed : null;
    } catch {
      return null;
    }
  }

  save(run: RunState): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.fileFor(run.root), JSON.stringify(run, null, 2) + "\n", "utf8");
  }

  all(): RunState[] {
    let entries: string[];
    try {
      entries = readdirSync(this.dir);
    } catch {
      return [];
    }
    const out: RunState[] = [];
    for (const f of entries) {
      if (!f.endsWith(".json")) continue;
      try {
        out.push(JSON.parse(readFileSync(join(this.dir, f), "utf8")) as RunState);
      } catch {
        // skip corrupt/partial files — a crash mid-write shouldn't wedge the store
      }
    }
    return out;
  }

  remove(root: string): void {
    rmSync(this.fileFor(root), { force: true });
  }

  prune(maxAgeMs: number = DEFAULT_RUN_RETENTION_MS): void {
    const now = Date.now();
    for (const run of this.all()) {
      if (run.status === "running") continue;
      const endedAt = run.completedAt ?? run.startedAt;
      if (now - endedAt > maxAgeMs) this.remove(run.root);
    }
  }
}