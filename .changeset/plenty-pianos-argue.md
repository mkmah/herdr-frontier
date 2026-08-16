---
"herdr-frontier": minor
---

Switch from semantic-release to Changesets. Release notes are now written at
PR time in `.changeset/*.md`; merging the bot's "ci: Version Packages" PR
creates the tag and GitHub Release. No release token is stored in the repo
(the workflow uses plain `GITHUB_TOKEN`).
