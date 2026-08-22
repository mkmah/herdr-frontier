---
"herdr-frontier": patch
---

Fix: tolerate to-tickets' bold-template issue markdown so `ready-for-agent` tickets dispatch instead of showing "human turn — not auto-dispatched".

- Field lines (`**Status:**`, `**Labels:**`, `**Blocked by:**`) parse with markdown emphasis and file-wide (outside fenced code blocks) — to-tickets writes them below the body's first line
- A triage-role value on a `Status:` line migrates onto the labels (lifecycle stays `open`); every coercion records a parse warning, surfaced as a dim `⚠` line in the detail pane — never silent
- `Blocked by: None — can start immediately` reads as unblocked; titled refs ("03 — Title") contribute their numeric prefix
- Status rewrites (claim/release/close) now canonicalize an emphasized `Status:` line and migrate any role found on it onto `Labels:`, so a released template ticket stays dispatchable
- Every `/implement {id}` dispatch now carries the TDD mandate ("Every task must be implemented test-first using the /tdd skill.") on the prompt
- Enter on a resolved ticket reports "already resolved — nothing to dispatch" (new `already-resolved` reason), distinct from `claimed by …`
