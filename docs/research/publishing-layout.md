# Where a published action and an npm package must live

Research for Fenro task T-771, part of the Vouch map T-766. I read every source on 2026-11-14. Numbers in square brackets point to the source list at the end. A claim marked "observed" comes from reading a public repository or a Marketplace page on that day. A claim marked "unconfirmed" has no primary source behind it yet.

npm calls its signed build record "provenance" and GitHub calls its signed release record a "release attestation". In this file "attestation" on its own keeps the glossary meaning, Vouch's signed record of a passing run.

## The question

What do the GitHub Marketplace and npm require of the repository that publishes an action and a package, and does either rule out keeping the library, the action, the service and the web app in one monorepo?

## Short answer

Neither rulebook forbids a monorepo. Two rules decide the layout anyway.

1. An action that other people's workflows use must sit in a public repository [1] [3]. A private repository can share its actions only with other private repositories of the same owner [7] [8]. So a private service can never share a repository with the action.
2. A Marketplace listing needs one `action.yml` at the root of a public repository. GitHub does not list an action in a subdirectory [1]. A listing is optional. `uses:` resolves any public repository, listed or not [4].

npm adds one hard rule of its own. It generates provenance only when a public package is published from a public repository [10] [11]. Trusted publishing itself works from a private repository, without provenance [10].

So a private service forces at least two repositories. A fully public product can live in one. The table under "Layouts that work" lists five layouts and what each costs per release.

My read: if the service stays private, the cheapest layout is one public repository that holds the library and the action with `action.yml` at its root, and one private repository for the service and the web app. Give the library and the action one shared version so a single `v1.2.3` tag line serves both the Marketplace and npm. T-780 owns the decision.

## What GitHub requires of an action's repository

### Hard rules for a Marketplace listing

GitHub publishes an action to the Marketplace at once and without review when it meets these rules [1].

| Rule | Source |
| --- | --- |
| The repository is public | [1] |
| The repository holds a single metadata file, `action.yml` or `action.yaml`, at its root | [1] |
| Metadata files in sub-folders are allowed, and GitHub does not list them | [1] |
| The `name` in the metadata file is unique across the Marketplace | [1] |
| The `name` matches no GitHub user or organization, unless that owner publishes the action | [1] |
| The `name` matches no Marketplace category and no GitHub feature name | [1] |
| The account that owns the repository has accepted the Marketplace Developer Agreement | [1] |
| The person who publishes uses two-factor authentication | [1] |

The metadata file needs `name` and `description`. `branding` is optional and sets the badge the listing shows [2].

Publishing means drafting a GitHub release and ticking "Publish this Action to the GitHub Marketplace" [1]. The listing shows the release tag as the version [1]. A listing belongs to one repository through its `name`. A transferred repository keeps its listing, and a deleted repository loses it [1]. Renaming the file between `action.yml` and `action.yaml` hides every earlier version from the Marketplace [2].

The same page says the repository should hold "only" the metadata file, the code and the files the action needs [1]. That sentence sits above the list of rules, not in it. GitHub's guide to managing actions words the same point as a recommendation: keep a shared action in its own repository so it has its own versions and is easier to find [5]. Observed: GraphQL Inspector has a live listing from a monorepo that also holds its npm packages and a website [20] [24]. Whether GitHub ever enforces the "only" sentence is unconfirmed.

### One action per repository or several

A repository can hold any number of actions, one per directory. Only the one at the root can have a listing [1]. `actions/cache` ships three this way. The root action has the listing, and `restore` and `save` live in sub-folders [16]. `changesets/action` does the same with six sub-actions [17].

### How `uses:` finds an action in a subdirectory

The forms are `{owner}/{repo}@{ref}` for the root and `{owner}/{repo}/{path}@{ref}` for a subdirectory [4]. The ref is a branch, a tag or a full commit SHA [4] [5]. It names a commit of the whole repository. No form versions a directory on its own.

Two more facts matter for a monorepo.

- The runner downloads an archive of the repository at that ref. This is observed in the runner's source, which fetches a tarball or zipball URL for the repository [15], and in sub-actions whose `runs.main` points outside their own directory, such as `main: ../dist/publish.js` [17] and `main: '../dist/restore-only/index.js'` [16]. The docs do not state it. In a monorepo every job that uses the action downloads the service and web code too.
- A JavaScript action runs the file that `runs.main` names, with no install or build step, so the bundled output must exist in the commit the ref points to [2] [9].

The docs now list a third form, `$/path/to/action`, for an action in the same repository as the running workflow. It takes no ref and does not exist on GitHub Enterprise Server [4]. It helps a monorepo test its own action in CI. Customers cannot use it to reach Vouch's action.

### Tags and releases

GitHub recommends a release with a full version tag such as `v1.0.1`, plus a major tag such as `v1` that the maintainer moves to the newest compatible release. Users pin `@v1`, a full version or a SHA [5]. A branch named for a release works as well [5].

Tags belong to the repository, so in a monorepo the action's `v1` shares one namespace with every other tag. The projects below show three ways to handle that.

- Share one version between the package and the action, so one `v1.2.3` line serves both. Chromatic does this [18].
- Prefix the tags of everything except the root action. Before it removed its action on 2026-10-25, opencode tagged the action as `github-v1.2.28` and kept a moving `latest` tag [25].
- Ignore tags. GraphQL Inspector's docs tell users to pin `@master`, and its listing shows `release-1794603085678` as the latest version [22] [24].

Dependabot updates actions referenced as `owner/repo@ref` [13]. Its docs say nothing about prefixed tags. Its source compares only tags that share the prefix of the tag in use [14]. I did not test this, so how Dependabot treats a prefixed action tag is unconfirmed.

Observed: a release that a bot creates through the API becomes the listing's latest version. The newest releases of `changesets/action` and GraphQL Inspector both have a bot as author, and both show on their listings [17] [20] [24]. The docs describe only the web form [1]. Whether the first publication can skip the web form is unconfirmed.

Observed: a tag without a release does not update the listing. `chromaui/action` has tags up to `v18.14.4`, its last release is `v1` from 2020, and the listing shows `v1` [19] [23].

### Immutable releases

An owner can turn on immutable releases for one repository or for an organization. The setting covers future releases only [6]. A published immutable release locks its tag to one commit. Nobody can move or delete that tag while the release exists, and nobody can reuse the name after deleting the release, even in a recreated repository [6]. GitHub also writes a release attestation for it [6].

GitHub's guidance for actions under this setting: create releases only for full versions like `v1.0.0`, and keep `v1` as a plain tag with no release, moved by force push [6]. `changesets/action` follows a variant. The releases API reports `immutable: true` for its newest releases, and its moving ref is a branch named `v2` that the release script force-pushes with the built output [17].

### Actions in a private repository

A private repository's actions reach only other private repositories of the same user or organization, and only after the owner turns on the access setting [7] [8]. A workflow elsewhere would have to check the repository out with a token and use a local path [4]. "To share actions you've built with everyone, your repository must be public" [3].

## What npm requires

### Trusted publishing

Trusted publishing lets a workflow publish with a short-lived OIDC token and no stored npm token. It needs npm CLI 11.5.1 or later and Node 22.14.0 or later [10].

- A trusted publisher names four things: the GitHub owner, the repository, a workflow filename inside `.github/workflows/`, and optionally an environment [10]. It has no field for a directory. Every package in a monorepo that publishes from the same workflow gets the same four values.
- The configuration belongs to a package. The `npm trust` command does not know about workspaces and requires that the package already exists on the registry [12]. So a person publishes the first version of each new package name by hand, and adds the trusted publisher afterwards.
- A new configuration must complete a publish within 2 days or it expires. The first publish binds it to the repository's "immutable identity", and nobody can edit a configuration, only delete and recreate it [10]. Moving a package to another repository later costs one new configuration per package.
- `repository.url` in `package.json` must match the GitHub repository exactly [10].
- Only GitHub-hosted runners work [10].
- When a workflow calls a reusable workflow that runs the publish, npm checks the calling workflow's filename, and both need `id-token: write` [10].
- The trusted publishing page allows 10 configurations per package [10]. The `npm trust` page says the registry supports one [12]. The first page is newer, edited 2026-10-06 against 2026-06-02. Which holds today is unconfirmed.
- npm recommends disallowing tokens once trusted publishing works, and offers a stage-only permission that makes a maintainer approve each version with 2FA [10] [28].

pnpm publishes under trusted publishing too, and attaches provenance to a public package from a public repository without a flag [27].

### Provenance

npm generates provenance on its own when all three hold: the publish uses trusted publishing, the repository is public, and the package is public [10]. A private repository gets no provenance, even for a public package [10]. With a token instead of trusted publishing, `--provenance` needs a cloud-hosted runner and a `package.json` whose repository is public and matches, case-sensitive, the repository the workflow runs in [11].

### The `repository` field in a monorepo

A package whose `package.json` is not at the repository root adds `directory` beside `url` [26]:

```json
"repository": {
  "type": "git",
  "url": "git+https://github.com/OWNER/REPO.git",
  "directory": "packages/cli"
}
```

npm rewrites shorthand forms to this object on publish and warns about it [26]. The docs tie provenance and trusted publishing to `url` only [10] [11]. Whether npm checks `directory` against anything is unconfirmed.

## How three projects lay out their repos

### Changesets, two repositories

`changesets/changesets` is a pnpm monorepo that publishes the npm packages, each with `repository.directory` set [21]. `changesets/action` is a separate repository with `action.yml` at the root and six sub-actions. It is a private npm package, never published, and depends on the `@changesets/*` packages from the registry [17]. Its release script commits the built `dist` on a detached commit, tags `v2.1.2`, and force-pushes the branch `v2` [17]. This is the layout GitHub recommends [5]. The cost is a second release each time the action needs a new library version: publish the library, bump the dependency in the action repository, rebuild, tag.

### Chromatic, one source repository and a generated action repository

`chromaui/chromatic-cli` holds the source of the npm package `chromatic` and of the action [18]. Its release workflow publishes the package with trusted publishing, then runs a script that copies the built action, `action.yml` and the changelog into a clone of `chromaui/action`, commits, and force-pushes the tags `v<version>`, `v<major>` and `latest` [18]. The package and the action share one version [18]. The Marketplace listing "Publish to Chromatic" belongs to `chromaui/action` [23]. The cost is the copy script and a stored token that can push to a second repository [18].

### GraphQL Inspector, one monorepo with the action at the root

`graphql-hive/graphql-inspector` holds its npm packages under `packages/`, a `website/` directory, a root `action.yml`, and the committed bundle `action/index.js` that the root file runs [20]. The packages publish to npm with `repository.directory` set [20]. The listing "GraphQL Inspector" belongs to this repository [24]. The cost shows in the versions. The newest `v` tag is `v4.0.0` while the CLI package is at 7.0.4, the listing's latest version is a timestamp tag, and the docs tell users to pin `@master` [20] [22] [24].

## Layouts that work and what each costs

"Per release" counts what a pipeline does after the first setup. Every layout needs the same one-time steps: accept the Marketplace agreement, publish the first release through the web form, publish the first version of each npm package by hand, then add its trusted publisher.

| Layout | Marketplace listing | Service can be private | Per release | Standing cost |
| --- | --- | --- | --- | --- |
| A. One public monorepo, `action.yml` at the root | Yes | No | One pipeline. Build the action bundle into the tagged commit, create the release, move `v1`, publish to npm | One tag namespace. Jobs download the whole repository. GitHub advises against mixing [5] |
| B. One public monorepo, action in a subdirectory | No | No | Same as A, without a listing to feed | Users write `owner/repo/path@v1`. No Marketplace presence |
| C. Public repository for library and action, private repository for service and web app | Yes | Yes | One pipeline in the public repository. The service deploys on its own | Code shared with the service travels through npm or is duplicated |
| D. Separate public repositories for library and action, service anywhere | Yes | Yes | Two pipelines. Publish the library, then bump, rebuild and tag the action | Two releases for one change that touches both. Clean tags and listing |
| E. One source repository and a generated action repository | Yes | Only by giving up provenance and open source for the library | One pipeline plus a copy script that pushes to the second repository | A stored token with push access to the action repository. The action repository carries no review history |

Notes on the table.

- A and B put the service in public. They fit only if the service is open source too.
- In A and C a shared version for the library and the action removes the tag problem. Without it, the library's tags need a prefix and the bare `v` tags go to the action.
- In A, C and D the bundle has to exist at the tagged commit [2] [9]. Either commit the bundle to the main branch, or build it in the release job onto a detached commit or a release branch as `changesets/action` does [17].
- In E with a private source repository, npm generates no provenance for the library [10], and the library's source is not public unless the script mirrors it too. For a product that sells trust in a build record, shipping its own CLI without provenance is a bad look.
- T-768 settled that the action authenticates with the Actions OIDC token and no stored secret. Layout E adds a stored token to Vouch's own release pipeline, which cuts against that.

## What a private service next to public packages implies

- The action and the service cannot share a repository [1] [3] [7].
- The library can share a repository with the action. Both are public and both release from GitHub Actions.
- The service cannot import library code through a workspace link. It installs the published package, or the wire format lives in a small public package both sides depend on.
- The web app is free to sit on either side. Docs that the open-source users edit belong in the public repository. The dashboard needs the service's API and fits beside it.
- A change that touches the library, the action and the service spans two repositories and two pull requests, so the service has to accept the old and the new client for a while.

## Unconfirmed

- Whether GitHub enforces the sentence that a listed repository holds only the action's files. Observed counter-example: [20] [24].
- Whether an API-created release can be the first Marketplace publication. Observed for later releases only.
- Whether Dependabot proposes updates for an action whose tags carry a prefix. Source read, not tested [14].
- That the runner downloads the whole repository for a subdirectory action. Source and two repositories show it, the docs do not say it [15] [16] [17].
- Whether a package can have 10 trusted publishers or one. The two npm pages disagree [10] [12].
- Whether npm validates `repository.directory`.
- Whether a repository transfer or rename breaks a trusted publisher bound to the repository's "immutable identity" [10].

## Sources

1. GitHub Docs, Publishing actions in GitHub Marketplace. https://docs.github.com/en/actions/how-tos/create-and-publish-actions/publish-in-github-marketplace
2. GitHub Docs, Metadata syntax reference. https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax
3. GitHub Docs, About custom actions. https://docs.github.com/en/actions/concepts/workflows-and-actions/custom-actions
4. GitHub Docs, Workflow syntax for GitHub Actions, `jobs.<job_id>.steps[*].uses`. https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax
5. GitHub Docs, Managing custom actions. https://docs.github.com/en/actions/how-tos/create-and-publish-actions/manage-custom-actions
6. GitHub Docs, Immutable releases, https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases. Preventing changes to your releases, https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/establish-provenance-and-integrity/prevent-release-changes. Using immutable releases and tags to manage your action's releases, https://docs.github.com/en/actions/how-tos/create-and-publish-actions/using-immutable-releases-and-tags-to-manage-your-actions-releases
7. GitHub Docs, Sharing actions and workflows from your private repository. https://docs.github.com/en/actions/how-tos/reuse-automations/share-across-private-repositories
8. GitHub Docs, Managing GitHub Actions settings for a repository, "Allowing access to components in a private repository". https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository
9. GitHub Docs, Creating a JavaScript action. https://docs.github.com/en/actions/tutorials/create-actions/create-a-javascript-action
10. npm Docs, Trusted publishing for npm packages, last edited 2026-10-06. https://docs.npmjs.com/trusted-publishers
11. npm Docs, Generating provenance statements. https://docs.npmjs.com/generating-provenance-statements
12. npm Docs, npm-trust, last edited 2026-06-02. https://docs.npmjs.com/cli/v11/commands/npm-trust
13. GitHub Docs, Dependabot supported ecosystems and repositories, GitHub Actions. https://docs.github.com/en/code-security/reference/supply-chain-security/supported-ecosystems-and-repositories
14. dependabot-core, `git_commit_checker.rb`, `VERSION_REGEX` and `same_prefix?`. https://github.com/dependabot/dependabot-core/blob/main/common/lib/dependabot/git_commit_checker.rb
15. actions/runner, `ActionManager.cs`. https://github.com/actions/runner/blob/main/src/Runner.Worker/ActionManager.cs
16. actions/cache, `restore/action.yml`. https://github.com/actions/cache/blob/main/restore/action.yml
17. changesets/action. Sub-action, https://github.com/changesets/action/blob/main/publish/action.yml. Release script, https://github.com/changesets/action/blob/main/scripts/release.ts. Manifest, https://github.com/changesets/action/blob/main/package.json. Releases, https://github.com/changesets/action/releases. Listing, https://github.com/marketplace/actions/changesets
18. chromaui/chromatic-cli. Manifest, https://github.com/chromaui/chromatic-cli/blob/main/package.json. Action publish script, https://github.com/chromaui/chromatic-cli/blob/main/scripts/publishAction.mjs. Release workflow, https://github.com/chromaui/chromatic-cli/blob/main/.github/workflows/release.yml
19. chromaui/action, tags and releases. https://github.com/chromaui/action/tags and https://github.com/chromaui/action/releases
20. graphql-hive/graphql-inspector. Root action, https://github.com/graphql-hive/graphql-inspector/blob/master/action.yml. CLI manifest, https://github.com/graphql-hive/graphql-inspector/blob/master/packages/cli/package.json. Tags, https://github.com/graphql-hive/graphql-inspector/tags. Releases, https://github.com/graphql-hive/graphql-inspector/releases
21. changesets/changesets, CLI manifest. https://github.com/changesets/changesets/blob/main/packages/cli/package.json
22. graphql-hive/graphql-inspector, action docs. https://github.com/graphql-hive/graphql-inspector/blob/master/website/content/docs/products/action.mdx
23. GitHub Marketplace, Publish to Chromatic. https://github.com/marketplace/actions/publish-to-chromatic
24. GitHub Marketplace, GraphQL Inspector. https://github.com/marketplace/actions/graphql-inspector
25. anomalyco/opencode. Action at the `latest` tag, https://github.com/anomalyco/opencode/blob/latest/github/action.yml. Tags, https://github.com/anomalyco/opencode/tags. History of the file, https://github.com/anomalyco/opencode/commits/dev/github/action.yml
26. npm Docs, package.json, `repository`. https://docs.npmjs.com/cli/v11/configuring-npm/package-json
27. pnpm Docs, pnpm publish, `--provenance`. https://pnpm.io/cli/publish
28. npm Docs, Staged publishing for npm packages. https://docs.npmjs.com/staged-publishing
