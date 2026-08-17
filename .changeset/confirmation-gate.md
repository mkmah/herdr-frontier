---
"herdr-frontier": minor
---

Add a confirmation gate in front of every action that spends money or rewrites issue
state, plus the `[confirm]` config table to suppress it per action.

- **Esc no longer quits — `q` is the only quit key.** Every key that used to act
  directly now opens a centered confirmation dialog first: `Enter` (dispatch),
  `x` (stop the selected run), `s` (start an automated run), and `S` (stop all
  runs). Each dialog names exactly what will run (issue `#id` + title, the run-root
  effort, or the in-flight stop tally), with **Confirm** pre-focused, so an action
  is two keys, not one.
- **Dialog keys:** `←/→`, `j/k`, and `Tab` move focus between Cancel and Confirm,
  `Enter` activates the focused button, and `Esc`/`q` cancel (never quit). Every
  other key is dead while the dialog is open. Mouse parity: buttons activate on
  click; the dim overlay does nothing. Structural no-ops — nothing selected,
  nothing running — never ask.
- **`[confirm]` config bypass:** `false` is the only off value for a per-action
  gate (`dispatch`, `release`, `run_start`, `run_stop`), so an empty config keeps
  every gate on and there is no in-dialog "don't ask again". Tables merge
  repo-over-user like every other key.