# Changesets

The library (`testnotary`) and the action (`@testnotary/action`) share one version and one tag line
(`v1.2.3`, with `v1` moved to it), so they are a fixed group. The web app deploys from `main` with
no version, and the core rules, protocol and test world are private and bundled into the clients.

Add a changeset with `pnpm changeset` in any pull request that changes what the library or the
action does.
