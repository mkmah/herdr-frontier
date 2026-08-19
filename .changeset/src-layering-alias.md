---
"herdr-frontier": patch
---

Restructure the source into the standard layered-frontend layout and switch all
imports to the `#/` path alias. No runtime behavior changes.

- **Layered modules:** the flat `src/` becomes `components/`, `hooks/`, `lib/`,
  and `services/` (each IO/controller module — tracker, herdr, shell, dispatch,
  run, transcripts, config — keeps its folder at its own depth), with a root
  `App.tsx` composition root and `types.ts`.
- **Thin App:** `App.tsx` no longer owns the data pipeline, selection, verb
  feedback, or keyboard/mouse surfaces inline — those live in the `hooks/`
  modules (`useHerdrData`, `useSelection`, `useVerbs`, `usePointer`, `useKeys`,
  `useIssueDetail`) and the presentational panes moved to `components/`.
- **`#/` path alias:** `tsconfig` `paths` maps `#/*` → `./src/*` (no `baseUrl`,
  per the TypeScript 6 deprecation), so every import under the project resolves
  by alias instead of relative hops.