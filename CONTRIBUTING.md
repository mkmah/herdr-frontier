# Contributing

Thanks for contributing to herdr-frontier.

## Prerequisites

- [Bun](https://bun.sh) 1.3 or newer
- [herdr](https://herdr.dev) **0.8.0** or newer for live plugin work
- Git

## Local setup

```bash
bun install --frozen-lockfile
```

Optional live link into herdr:

```bash
herdr plugin link .
```

You can now run the plugin against this repo's own `.scratch/` tracker. See
`docs/agents/issue-tracker.md` for how the local issue tracker works and
`CONTEXT.md` for the domain language the code speaks.

## Issue tracker

Issues and specs live as markdown files under `.scratch/<feature>/`. See
`docs/agents/issue-tracker.md` and `docs/agents/triage-labels.md`. If you're
working on a feature, its tracker lives there — not in GitHub Issues. GitHub
issues are for bugs, feature proposals, and tracker-adapter requests.

## Checks

```bash
bun test
bunx tsc --noEmit
bun run policy:check
```

- `bun test` runs the unit suite (the TrackerProvider contract, the
  orchestrator's pure policy functions, and the herdr driver against recorded
  CLI fixtures).
- `bunx tsc --noEmit` typechecks the whole repo. The source must stay clean.
- `bun run policy:check` runs the real frontier/dispatch policy over the actual
  `.scratch/` data.

`bun run build` compiles the OpenTUI render layer into `bin/herdr-frontier`.

## Branch and pull requests

1. Create a feature branch. Do not commit to `main`.
2. Keep the change focused.
3. Open a pull request. Reference the `.scratch/<feature>/` issue it resolves.
4. Wait for CI. Fix failures before merge.
5. Add a changeset (`bun run changeset`) declaring the bump (patch/minor/major)
   and writing the release note. Versions and the changelog are derived from
   changesets, not commit messages. Conventional commit messages are still the
   house style — they just no longer drive versioning.

## Adding a tracker adapter

A new tracker means one new `TrackerProvider` implementation under
`src/services/tracker/` plus a label-map. The contract (8 verbs) is fixed in ADR-0001
and enforced by the shared contract tests — write the adapter against
`src/services/tracker/local-markdown.ts` as the reference, then run `bun test`. Open a
"Tracker adapter" issue first so the tracker's native label strings and id
shape are agreed before the code lands.
