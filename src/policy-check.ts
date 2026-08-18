// Manual policy check — real provider, real .scratch data (issue 11).
//
// Runs frontier(), dispatch(), and autoSpawnable() over the actual issue files
// in this repo (no fixtures), and prints what the policy resolves. This is the
// "real test" counterpart to the plain-data unit tests in orchestrator.test.ts.
//
// Run: bun run policy:check

import { LocalMarkdownProvider } from "./tracker/local-markdown.js";
import { frontier, dispatch, autoSpawnable } from "./orchestrator.js";
import { issueLabel } from "./logic.js";
import type { Issue } from "./tracker/provider.js";

const provider = new LocalMarkdownProvider({ repoRoot: process.cwd() });

const issues = await provider.listIssues();
const labelOf = (i: Issue) =>
  i.labels.find((l) => !l.startsWith("wayfinder:")) ?? (i.labels.join(",") || "unlabeled");
const outcome = (i: Issue) => {
  const d = dispatch(i);
  switch (d.kind) {
    case "wayfinder":
    case "implement":
      return d.command;
    case "human":
      return "HUMAN-TURN (never auto-dispatch)";
    case "not-dispatched":
      return `NOT-DISPATCHED (${d.reason})`;
  }
};

console.log("\n=== FRONTIER (open ∧ unclaimed ∧ all-blockers-resolved, by number) ===");
if (frontier(issues).length === 0) console.log("  (none)");
for (const i of frontier(issues)) console.log(`  ${issueLabel(i)}  ${i.title}`);

console.log("\n=== DISPATCH, per issue ===");
for (const i of [...issues].sort((a, b) => a.id.localeCompare(b.id))) {
  console.log(
    `  ${issueLabel(i).padEnd(4)} ${labelOf(i).padEnd(16)} ${outcome(i).padEnd(48)} auto=${autoSpawnable(i) ? "YES" : "no"}`,
  );
}
console.log(`\n${issues.length} issues read from .scratch/`);
