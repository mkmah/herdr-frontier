---
"herdr-frontier": minor
---

Deepen the architecture behind the shell — all internal, the UI and keybindings are
unchanged:

- **The App shell is a deep module (Card 1).** A signal-free `ShellController` owns the
  Confirmable verbs, their confirmation gate, and the load/poll reconcile pipeline;
  App is a thin render adapter over that seam. `request` decides "ask or go", the
  self-describing dialog carries its trigger (no stored pending action), and `confirm`
  runs the verb. The reconcile folds claim-reconcile + dead-dispatch + attention + run
  steps onto one `agent list` read per poll tick.
- **The tracker owns its id format (Card 2).** `Issue` records now carry adapter-owned
  `effort` / `num` / `order` facts, parsed once by the local-markdown adapter; no policy
  code parses an id anymore. The frontier and run advance sort on the record's `order`,
  run scoping reads the record's `effort`, the display label comes from the record's
  `num`, and the transcript ingester gets its sibling-transcript path from the provider
  instead of splicing the id.
- **One attention rulebook (Card 4).** The two "needs a human" predicates — the list's
  ☻ marker and the notification toast — are a single `attention(issue, agentStatus)`
  predicate returning a kind: `notify` raises the toast, `human` shows only the marker.
  The display layer and the notification diff consume the same rule, so the marker and
  toast can never drift.