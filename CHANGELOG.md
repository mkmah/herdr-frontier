# herdr-frontier

## 0.1.0

### Minor Changes

- [`1484ea9`](https://github.com/mkmah/herdr-frontier/commit/1484ea96e3043e49bd64294cf1e2141e3dd142c4) - Switch from semantic-release to Changesets. Release notes are now written at
  PR time in `.changeset/*.md`; merging the bot's "ci: Version Packages" PR
  creates the tag and GitHub Release. No release token is stored in the repo
  (the workflow uses plain `GITHUB_TOKEN`).
