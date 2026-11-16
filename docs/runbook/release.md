# Release runbook

The library (`testnotary` on npm) and the action (`Daniel88dev/testnotary@v1`) are released
together under one version by `.github/workflows/release.yml`. The agent that wrote it never
pushed a tag, created a release or published anything: every step below needs the maintainer's
GitHub and npm access. Nothing is published to npm or the Marketplace before `testnotary.dev` is
bought.

## How a release happens

1. Pull requests that change what the library or the action does carry a changeset
   (`pnpm changeset`). The library and the action are one fixed group, so both get the bump.
2. On every push to `main`, the workflow's `changesets` job opens or updates the **Version
   packages** pull request while changesets are pending.
3. Merging it sets the new version. The `release` job then, on the merge commit:
   - checks every dependency's license (`pnpm licenses:check`);
   - builds the action bundle (`dist/action/index.js`, Node 24) and the library (`dist/cli.js`,
     Node 20 syntax), each with `licenses.txt`, the notices of what it inlines (`pnpm release:build`);
   - runs the action and library suites again against the builds (`pnpm release:test`);
   - commits `dist/action/` and `dist/licenses.txt` onto a **detached commit** whose parent is the
     merge commit, tags it `vX.Y.Z` and moves `v1` to it, on the runner (`scripts/release/tag.ts`);
   - packs the library and rehearses `npm publish --dry-run`;
   - and, outside a dry run: pushes `vX.Y.Z`, creates the GitHub release from the library's
     changelog section, publishes the tarball to npm with provenance, and force-pushes `v1` last.

Every run is a **dry run** until the repository variable `RELEASE_PUBLISH` is `true`. A manual run
(Actions → Release → Run workflow) is a dry run unless `dry_run` is unticked. The job summary says
which tag and commit a run prepared. Locally, the same dry run is:

```sh
pnpm release:build && pnpm release:test && pnpm licenses:check
node scripts/release/tag.ts     # tags on your clone only; delete with git tag -d vX.Y.Z (and re-tag v1)
```

## One-time setup, in order

1. **Domain first.** Buy `testnotary.dev` before anything below that publishes.
2. **Repository settings → Actions → General:** allow GitHub Actions to create and approve pull
   requests (the Version packages pull request). Note that a pull request opened with the job's
   `GITHUB_TOKEN` does not start CI; close and reopen it, or give the `changesets` job a GitHub App
   token instead.
3. **Repository settings → General → Releases:** turn on **immutable releases**. Each `vX.Y.Z`
   release is then locked to its commit, its tag name can never be reused, and GitHub writes a
   release attestation. `v1` stays a plain tag with no release, so it can move.
4. **Environment `release`** (Settings → Environments): create it (the workflow names it). Add
   required reviewers if a release should wait for approval; dry runs then wait too.
5. **Tag rules:** if a ruleset protects `v*` tags, let the Actions bot create `v*.*.*` and
   update `v1` (or exempt it), or the tag pushes fail.
6. **First npm publish, by hand** (trusted publishing needs the package to exist):
   ```sh
   pnpm install --frozen-lockfile
   pnpm --filter testnotary pack --pack-destination /tmp/testnotary-npm
   npm publish /tmp/testnotary-npm/testnotary-<version>.tgz --access public   # with your 2FA
   ```
   Publish an early version soon after the domain is bought, to hold the name. Tag the same commit
   by running the workflow rather than by hand, so the action and library versions stay in step.
7. **npm trusted publisher** for `testnotary` (npmjs.com → package → Settings → Trusted
   publishing, or `npm trust`): GitHub Actions, owner `Daniel88dev`, repository `testnotary`,
   workflow `release.yml`, environment `release`. Use it within two days or it expires. Then set
   the package to disallow token publishing.
8. **`RELEASE_PUBLISH=true`** (Settings → Variables → Actions). From now on a merged Version
   packages pull request releases for real.
9. **Marketplace:** after the first release exists, open it on GitHub and tick "Publish this Action
   to the GitHub Marketplace" (accept the Marketplace Developer Agreement; the listing name is
   "Testnotary"). Later releases created by the workflow update the listing.

## Maintainer checklist (settings no file can hold)

- [ ] Branch protection on `main`: pull requests only, no force pushes, the CI checks required
      (`lint`, `typecheck`, `licenses`, `library-node-floor`, `terraform`, `image`, `test`),
      signed commits required.
- [ ] A hardware second factor (security key or passkey) on the GitHub account.
- [ ] A hardware second factor on the npm account, required for publishing and settings.
- [ ] Dependabot alerts and security updates on (version updates come from `.github/dependabot.yml`,
      with a 7-day cooldown).
- [ ] Workflow actions pinned to full commit SHAs with a `# vX.Y.Z` comment (they are pinned by tag
      today; Dependabot keeps either form current).

## If a release half-fails

The steps are ordered so `v1` moves last. If a run stops after pushing `vX.Y.Z`:

- **Release missing:** `gh release create vX.Y.Z --verify-tag --notes-file <notes>` by hand.
- **npm missing:** a re-run skips because the tag exists, and trusted publishing works only from
  the workflow, so release the next patch version (an empty patch changeset) rather than
  publishing by hand.
- **`v1` not moved:** `git fetch --tags && git tag -f v1 vX.Y.Z^{} && git push -f origin refs/tags/v1`.

A `vX.Y.Z` tag is never deleted or reused: immutable releases forbid it, and users may pin it.
