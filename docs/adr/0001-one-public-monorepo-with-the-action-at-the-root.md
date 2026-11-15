# One public monorepo with the action at the root

The library, the action, the service and the web app live in one public repo, `Daniel88dev/testnotary`, with `action.yml` at its root. GitHub recommends giving a shared action a repo of its own, and many projects split the action from its npm package. We chose one repo because the whole product is open source, so nothing forces the service elsewhere. It also means a change to the wire format between the library, the action and the service lands in one pull request instead of two. The root `action.yml` gives the Marketplace listing and the short reference `uses: Daniel88dev/testnotary@v1`.

## Consequences

- The library and the action share one version and one tag line (`v1.2.3`, with `v1` moved to it). The service and the web app deploy from `main` and carry no version tags.
- The action's bundle is never committed to `main`. The release workflow builds it from reviewed source onto a detached commit and tags that commit as an immutable release.
- Every workflow that uses the action downloads an archive of the whole repo, so the repo stays free of large files.
- npm's trusted publisher and the Marketplace listing are both bound to this repo, so moving any part out later costs a new trusted publisher, a new listing or both.

## Considered options

- A public repo for the library and the action, plus a separate repo for the service and the web app. This was only needed while the service was going to be private.
- Separate repos for the library and the action (as Changesets does). That means two releases for one change.
- A source repo plus a generated action repo (as Chromatic does). That needs a copy script and a stored push token, which goes against using no stored secrets in the release pipeline.
