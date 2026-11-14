# Prior art for trusting local test runs

Research for Fenro task T-767, part of the Vouch map T-766. Written 2026-11-14.

## The question

Who already lets a result produced outside CI stand in for a CI run, how does each one decide the
result can be trusted, and where has that trust been broken?

## Answer in short

Four groups do it today, and each trusts something different.

| Group                                         | What stands in for the CI run                | Why it is trusted                                             |
| --------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------- |
| `gh-signoff` and Rails local CI               | A commit status a developer posts            | The team trusts the developer. The tool checks git state only |
| Remote caches. Nx Cloud, Turborepo, Bazel     | A cached task result with the same input key | The cache key matches, and the writer held a write token      |
| SLSA, in-toto, Sigstore                       | A signed statement about an artifact         | The verifier trusts the signer and the platform it ran on     |
| In-repo "receipt" tools from autumn 2026      | A signed or App-published pass for a commit  | An allowlist of people, plus config read from the base branch |

Three findings matter most for Vouch.

1. No signature scheme can prove that a test ran on a machine its owner controls. SLSA says so in
   its own level definitions, and the attest README says the same about itself. The working tools
   name the signer and limit who may sign. WooCommerce also re-runs a sample in CI.
2. The break-ins on record are not forged signatures. They are a low-trust writer whose result a
   high-trust reader replayed, and inputs the cache key never covered. Vouch has to treat "who
   wrote this" and "which inputs does the claim cover" as the two places it will be attacked.
3. No hosted product covers Vouch's destination. The closest thing is a private tool at
   WooCommerce that already ships the same design, sampling included, for one repository.

## gh-signoff and the Rails local CI flow

### What a signoff records

`gh signoff` posts one GitHub commit status per context. The script calls
`POST repos/:owner/:repo/statuses/<commit>` with `state=success`, a context of `signoff` or
`signoff/<name>`, and a description built from the local `git config user.name` followed by
"signed off". A `target_url` appears only when the caller passes `--url` or sets `signoff.url`.
Source: [gh-signoff script](https://github.com/basecamp/gh-signoff/blob/main/gh-signoff),
[README](https://github.com/basecamp/gh-signoff/blob/main/README.md).

The status holds no test output, no command, no environment and no hash of anything. The script
never starts a test runner. Before it posts, it checks three things.

- `git status --porcelain` prints nothing, so the working tree is clean.
- `HEAD` is contained in the push target, so the commit is on the remote.
- `git config user.name` is set.

The `-f` flag skips the first two checks. Source:
[gh-signoff script](https://github.com/basecamp/gh-signoff/blob/main/gh-signoff).

### Who may give one

Anyone with push access to the repository. GitHub lets any user with push access create a commit
status for a SHA, and the API records the creator on the status. Source:
[GitHub REST docs, commit statuses](https://docs.github.com/en/rest/commits/statuses). The name in
the description comes from local git config, which the user sets freely, so only the API's
`creator` field identifies the account.

### How branch protection consumes it

`gh signoff install` creates a repository ruleset named `signoff` that requires the `signoff`
status check, blocks force pushes and branch deletion, and gives repository admins a standing
bypass. The ruleset sets `strict_required_status_checks_policy` to `false`, so the branch does not
have to be up to date with its base. Source:
[README](https://github.com/basecamp/gh-signoff/blob/main/README.md),
[gh-signoff script](https://github.com/basecamp/gh-signoff/blob/main/gh-signoff).

The tool manages only checks that are not pinned to a GitHub App. GitHub's ruleset docs say a
required check with no pinned app accepts a status from anyone with write access, and that pinning
an app blocks the merge when anyone else sets the status. Source:
[GitHub docs, available rules for rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets).

A status belongs to one commit SHA, so a new push leaves the new head without a signoff. Source:
[GitHub REST docs, commit statuses](https://docs.github.com/en/rest/commits/statuses).

### The Rails flow around it

Rails 8.1 shipped on 2025-10-22 with a CI declaration in `config/ci.rb`, run by `bin/ci`. The
sample file runs setup, style, security and test steps, then calls `gh signoff` when every step
succeeded. The release notes describe the `gh` integration as optional and say it makes a passing
CI run a condition for merging a PR. Source:
[Rails 8.1 release notes](https://edgeguides.rubyonrails.org/8_1_release_notes.html),
[Rails 8.1 announcement](https://rubyonrails.org/2025/10/22/rails-8-1).

`bin/ci` is the only link between the tests and the signoff. Nothing stops a developer from
running `gh signoff` alone.

The reasoning behind it is cost and speed, not trust. The 37signals post from 2024-04-29 reports a
remote run of about 5 minutes 30 seconds on Buildkite and under half that on a developer machine,
for roughly 55,000 lines of Ruby and 5,000 test cases. The post does not discuss how a team knows a
local pass is real. Source:
[We're moving continuous integration back to developer machines](https://world.hey.com/dhh/we-re-moving-continuous-integration-back-to-developer-machines-3ac6c611).
The gh-signoff README states the trust model in one line: the team already trusts its members with
test, push and deploy discipline. Source:
[README](https://github.com/basecamp/gh-signoff/blob/main/README.md).

Repository facts on 2026-11-14: MIT license, created 2024-11-10, latest release v0.4.1 from
2026-08-22, 2,130 stars. Source:
[GitHub API, basecamp/gh-signoff](https://api.github.com/repos/basecamp/gh-signoff).

## Remote caches

A remote cache already does what Vouch wants whenever a developer machine holds a write token. The
developer runs `test`, the runner stores the result under a hash of the inputs, and CI computes the
same hash and replays the stored pass without running anything. Nx describes its cache as shared
across developer machines and CI jobs. Source:
[Nx remote cache](https://nx.dev/docs/features/ci-features/remote-cache). Turborepo's default is
`--cache=local:rw,remote:rw`, read and write on both. Source:
[turbo run reference](https://turborepo.dev/docs/reference/run).

### Which inputs each one hashes

| Input                 | Nx                                                         | Turborepo                                                      | Bazel                                                              |
| --------------------- | ---------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------ |
| Source files          | Yes, by fileset. Gitignored files are left out by default  | Yes, the source-controlled files in the package                | Yes, the declared inputs of the action                             |
| Task config           | Yes, project configuration of the task and its deps        | Yes, root and package `turbo.json`, plus `package.json`        | Yes, the command line is part of the action                        |
| CLI arguments         | Yes, except Nx-only flags                                  | Yes, passthrough arguments after `--`                          | Yes                                                                |
| Lockfile and deps     | Yes, all external dependencies unless narrowed             | Yes, lockfile changes that affect the package or the root      | Through declared inputs only                                       |
| Environment variables | Only the ones the config names                             | Only `env` and `globalEnv` entries, plus framework prefixes    | Only variables passed with `--action_env`, with a fixed `PATH`     |
| Runtime version       | Only through a `runtime` input such as `node --version`    | Only through the `engines` field in `package.json`             | Through declared inputs only                                       |
| OS and architecture   | No. `sharedGlobals` is empty in generated workspaces       | No. The docs give a workaround that writes a key file          | Not in the cache docs. The hermeticity page lists host binaries as a risk |

Sources: [Nx inputs reference](https://nx.dev/docs/reference/inputs),
[Turborepo caching](https://turborepo.dev/docs/crafting-your-repository/caching),
[Turborepo environment variables](https://turborepo.dev/docs/crafting-your-repository/using-environment-variables),
[Turborepo handling platforms](https://turborepo.dev/docs/guides/handling-platforms),
[Bazel remote caching](https://bazel.build/remote/caching),
[Bazel command-line reference](https://bazel.build/reference/command-line-reference),
[Bazel hermeticity](https://bazel.build/basics/hermeticity).

Two things follow for Vouch. First, none of the three hashes the OS or the runtime version unless
the repository owner adds it by hand. A pass recorded on an arm64 Mac with one Node version replays
on an x86 Linux runner with another. Second, the tools know this is a correctness problem.
Turborepo's docs warn that an undeclared variable can ship a preview configuration to production
on a cache hit. Source:
[Turborepo environment variables](https://turborepo.dev/docs/crafting-your-repository/using-environment-variables).

Bazel caches passing test results by default. With `--cache_test_results=auto` it re-runs a test
only when the test or its dependencies changed, the test is tagged `external`, several runs were
requested, or the test failed last time. Source:
[Bazel command-line reference](https://bazel.build/reference/command-line-reference).

### Poisoning on record

**CVE-2025-36852.** Published 2025-06-10 by the CNA HeroDevs, CVSS 4.0 score 9.4, CWE-829. Any
contributor who can open a pull request builds a bad artifact on a branch, uploads it first under
the key a trusted branch will compute, and the trusted build replays it. Checksums, encryption and
access control do not help, because the artifact is bad before the cache hashes it. The record
lists bucket-based cache plugins for Nx on S3, GCS, Azure and shared file systems, plus third-party
plugins. Source: [CVE-2025-36852 record](https://www.cve.org/CVERecord?id=CVE-2025-36852),
[Nx advisory post](https://nx.dev/blog/cve-2025-36852-critical-cache-poisoning-vulnerability-creep).

Nx says Nx Cloud is not affected, because protected branches write the shared cache while feature
branches write only to a cache scoped to their own branch. That is the vendor's own statement. I
found no independent audit of it. Source:
[Nx advisory post](https://nx.dev/blog/cve-2025-36852-critical-cache-poisoning-vulnerability-creep).

**Ultralytics, December 2024.** PyPI's analysis says the attack went through the project's GitHub
Actions cache and its release workflow, and tells maintainers to avoid shared caches in build and
release jobs. I did not re-read the detailed analysis PyPI links to. Source:
[PyPI, Ultralytics attack analysis](https://blog.pypi.org/posts/2024-12-11-ultralytics-attack-analysis/).

**Accidental poisoning.** Bazel lists as a known issue that a file edited during a build can put an
invalid result in the remote cache, and its default guard checks only source files in the main
repository. Source: [Bazel remote caching](https://bazel.build/remote/caching),
[Bazel command-line reference](https://bazel.build/reference/command-line-reference). Gradle gives
the same reason for its advice against developer uploads. Developers change inputs or outputs
while a task runs, often without noticing, and Gradle caches whatever is in the output directory.
Source:
[Gradle build cache use cases](https://docs.gradle.org/current/userguide/build_cache_use_cases.html).

I found no primary-source write-up of a cache-poisoning incident at Turborepo or in a Bazel
deployment. That absence comes from searching, so treat it as unconfirmed.

### The write-access rules that followed

- **Nx Cloud.** Use a read-write token only on protected branches. A read-only token reads the
  shared cache and writes to an isolated cache that only its own run can see. Entries are
  immutable once stored. Developers log in with their own account instead of sharing the CI token.
  Skip the cache when building the artifact that ships. Source:
  [Nx cache security](https://nx.dev/docs/kb/cache-security),
  [Nx access tokens](https://nx.dev/docs/kb/access-tokens).
- **Nx Cloud defaults.** The default access level for people who are not logged in starts at
  read-write, and the workspace owner can lower it to read-only or none. Source:
  [Nx personal access tokens](https://nx.dev/docs/kb/personal-access-tokens). So the secure setup
  is opt-in.
- **Turborepo.** Artifact signing is opt-in. It uses HMAC-SHA256 with one secret in
  `TURBO_REMOTE_CACHE_SIGNATURE_KEY`, and the client treats an artifact that fails verification as
  a cache miss. Source:
  [Turborepo remote caching](https://turborepo.dev/docs/core-concepts/remote-caching). A shared
  secret proves the writer held the key. It cannot say which person or machine wrote the entry.
  `--cache=local:rw,remote:r` makes a machine read-only. Source:
  [turbo run reference](https://turborepo.dev/docs/reference/run).
- **Bazel.** The docs tell owners to take care over who can write and suggest that only CI writes.
  `--remote_upload_local_results=false` turns a client read-only. Source:
  [Bazel remote caching](https://bazel.build/remote/caching).
- **Gradle.** Developer uploads to a shared cache are possible but not recommended. Source:
  [Gradle build cache use cases](https://docs.gradle.org/current/userguide/build_cache_use_cases.html).

The direction is the same everywhere. Vendors started with every machine able to write, and each
security review since has moved them toward "only CI on a protected branch writes". Vouch goes the
other way on purpose, so it needs an answer the caches never had: an identity on every write and a
check that catches a false one.

### Two neighbours worth knowing

Garden skips a test in CI when a developer already ran the same version from a laptop. Its docs
give the reason: the test runs in a remote environment, not on the laptop, and Garden versions
every file. The laptop only triggers the run. Source:
[Garden portable CI pipelines](https://docs.garden.io/overview/use-cases/portable-ci-pipelines),
[Garden team caching](https://docs.garden.io/features/team-caching).

Nix accepts a store path from another machine when a key in `trusted-public-keys` signed it.
Source: [Nix configuration reference](https://nix.dev/manual/nix/latest/command-ref/conf-file).
The signature stands for "this output belongs to this derivation", and the sandboxed build is what
makes that claim checkable by rebuilding.

## SLSA, in-toto and Sigstore

### What a signed attestation claims

SLSA defines an attestation as an authenticated statement about a software artifact. The signature
on the envelope says who created the statement and nothing more. The claim itself sits in the
predicate. Source: [SLSA attestation model](https://slsa.dev/attestation-model).

So a signature answers "who said this" and "was it changed since". It never answers "is it true".

### What SLSA says about a machine its owner controls

SLSA's build levels are a ranking of how far to believe provenance, and a laptop sits at the
bottom.

- **Build L1.** Provenance exists. It may be unsigned, and SLSA calls it "trivial to bypass or
  forge". Its stated use is catching mistakes.
- **Build L2.** The build runs on dedicated infrastructure, not an individual's workstation, and
  the platform signs the provenance with a key only the platform can reach.
- **Build L3.** The signing secret is out of reach of the user-defined build steps, and runs
  cannot influence each other.

Source: [SLSA v1.0 levels](https://slsa.dev/spec/v1.0/levels),
[SLSA v1.0 requirements](https://slsa.dev/spec/v1.0/requirements). SLSA v1.2 keeps the L1 wording
and files builds that are built and run on the same machine, unit tests included, under L0.
Source: [SLSA v1.2 build track](https://slsa.dev/spec/v1.2/build-track-basics).

A Vouch attestation signed on a laptop or in an agent sandbox is L1 at best. The person or agent
running the tests controls the process that reports the result, and the signing credential sits
where that process can reach it. Both facts break L2 and L3 by definition. Vouch should say this
in its own docs instead of borrowing SLSA's vocabulary to sound stronger than it is.

GitHub's artifact attestations show the same line from the other side. They reach Build L2, or L3
through a reusable workflow, because GitHub Actions runs the build and mints the identity. GitHub
adds that an attestation does not guarantee the artifact is secure. Source:
[GitHub artifact attestations](https://docs.github.com/en/actions/concepts/security/artifact-attestations).

### What in-toto offers

in-toto has a predicate for exactly this claim. The test-result predicate, type
`https://in-toto.io/attestation/test-result/v0.1`, takes the tested source as subject, with a git
commit digest in its example. It carries a `result` of `PASSED`, `WARNED` or `FAILED`, a required
`configuration` list that points at the test config, an optional `url`, and optional lists of
passed, warned and failed test names. Source:
[in-toto test-result predicate](https://github.com/in-toto/attestation/blob/main/spec/predicates/test-result.md).

The predicate says nothing about whether to believe the signer. The in-toto specification assumes
the people who perform steps are not malicious, and aims to tie a malicious actor to their actions
once someone detects them. For a compromised signer it points to thresholds, meaning more than one
party signs the same step. Source:
[in-toto specification](https://github.com/in-toto/docs/blob/master/in-toto-spec.md).

That is the same stance as the Vouch map: detect and attribute, do not pretend to prevent.

### What Sigstore adds and does not add

Fulcio issues a short-lived certificate that embeds the signer's OIDC identity and issuer. Rekor
is an append-only log, and an entry shows that a piece of data existed before a point in time. The
log helps only when someone monitors it, and Sigstore leaves that to users. Source:
[Sigstore security model](https://docs.sigstore.dev/about/security/).

Sigstore gives Vouch two things: a signature bound to a named account with no long-lived key to
steal, and a public record that makes a false attestation hard to deny later. It gives no evidence
that a test ran. T-770 owns the choice of signing method.

## Tools that skip CI because a test passed locally

I found no hosted product that sells this. I found one open-source tool and four repositories
that built it for themselves between September and November 2026. Several of those pull requests
were written by coding agents, which says something about where the demand comes from.

### WooCommerce and `gh local-ci`

This is the closest match to Vouch, and it is live on `trunk`. A contributor runs eligible test
jobs with a private `gh` extension. The extension publishes one check run per job on the head
commit through a GitHub App named Woo Local CI Checks. Each CI matrix job looks for that receipt
before it installs anything and skips install and test when the receipt holds. Source:
[woocommerce/woocommerce PR 69176](https://github.com/woocommerce/woocommerce/pull/69176), merged
2026-11-09,
[local-ci-receipt README](https://github.com/woocommerce/woocommerce/blob/trunk/.github/actions/local-ci-receipt/README.md).

The rules it applies:

- The newest receipt of that name comes from the App, passed, and was made under the config that
  `trunk` has.
- The PR author published it, and the API confirms the author has write permission.
- CI reads the contract file `.github/local-ci.json` from the base branch. A PR that changes it
  gets a full run.
- Receipts count on `pull_request` events only. Merge queue runs and pushes to `trunk` run
  everything.
- Any other state runs the job as before and logs the reason. A repository variable switches the
  whole thing off.
- An allowlist compiled into the private tool decides who may publish.

It also audits itself. Each rule has a `sampleRate`, 10 percent for JavaScript unit jobs in the
current config. A job is sampled when `sha256(head sha + job name) mod 100` falls below the rate,
so a re-run samples the same jobs. A sampled job runs in CI anyway, and a comparison step writes
an annotation that says whether CI and the receipt agree. A local pass with a CI failure is an
error. The annotation records whether the base branch moved, because CI tests the merge commit
while the receipt tested the head. The tool has a `--docker` mode for checking whether a mismatch
comes from the local toolchain. Source:
[local-ci-receipt README](https://github.com/woocommerce/woocommerce/blob/trunk/.github/actions/local-ci-receipt/README.md),
[local-ci.json](https://github.com/woocommerce/woocommerce/blob/trunk/.github/local-ci.json).

The PR reports four JavaScript unit jobs going from 1,183 seconds of runner time to 45. Source:
[PR 69176](https://github.com/woocommerce/woocommerce/pull/69176).

Why an App: GitHub gives write access to check runs only to GitHub Apps. A user token cannot
create one. Source: [GitHub REST docs, check runs](https://docs.github.com/en/rest/checks/runs).

The tool's repository is private, so I could not confirm how a laptop obtains a credential for the
App or how the allowlist is enforced.

### fredericrous/attest

An MIT-licensed GitHub Action and CLI, created 2026-08-27, one star on 2026-11-14. A pre-push hook
signs the list of gates that passed with an ed25519 SSH key and stores the signature in git notes.
The action verifies it and outputs the covered gates for `if:` conditions. Source:
[attest README](https://github.com/fredericrous/attest/blob/main/README.md),
[GitHub API, fredericrous/attest](https://api.github.com/repos/fredericrous/attest).

Design choices worth reading before T-775:

- The signature covers the git tree, not the commit. It survives an amend, a rebase and a squash
  merge, and it fails on a `pull_request` merge commit unless the branch is up to date.
- An attestation counts only on the platform that made it, as architecture plus OS. A list named
  `anywhere` exempts gates that cannot depend on platform, and the README warns against putting
  anything there that compiles or runs the product.
- An optional file declares which paths each gate reads, so an unrelated change does not void the
  attestation. The README calls an under-broad list a silent false skip.
- The verifier always exits 0. Every failure path means "nothing covered", and the tests run.
- An `explain` command answers why a skip did not happen.

Its README names two weaknesses plainly. The `allowed_signers` file is read from the tree under
verification, so a pull request can add its own key unless CODEOWNERS or required review guards
the file. And the signing key is a file on the machine, so anything that runs as the user can
sign, the test suite included. Source:
[attest README](https://github.com/fredericrous/attest/blob/main/README.md).

### Three smaller in-repo versions

- **Civ13.** A maintainer runs a local script that refuses a dirty tree, runs the CI suites,
  posts a receipt as a commit comment and sets a status that carries the receipt's SHA-256. The
  gate reads its verifier and the attester list from the PR base, never the head. It checks the
  status creator's user id, the receipt's head and tree, the pinned compiler version and the test
  selection. A change to any CI-control path always runs hosted CI. Source:
  [Civ13/Civ13 PR 3777](https://github.com/Civ13/Civ13/pull/3777).
- **Clouseau.** A signing step refuses to produce a receipt unless every command in the accepted
  base config ran and exited 0 on the exact head. Source:
  [gaulatti/clouseau PR 224](https://github.com/gaulatti/clouseau/pull/224).
- **xYang.** An agent adds the trailer `Local-Tests: passed` to the commit message and the heavy
  jobs skip. No signature, no identity. Pushes to `main`, tags and releases always run the full
  suite. Source: [exergy-connect/xYang PR 108](https://github.com/exergy-connect/xYang/pull/108).

### Teams that run locally and keep CI

Modern Treasury moved its checks onto developer machines with the Rails CI runner in 2026 and
pointed its agents at the same script. It kept cloud CI as a second layer, and names environment
differences and sign-off verification as the open problems. Source:
[Modern Treasury, local CI for developers and AI agents](https://moderntreasury.com/journal/reducing-feedback-latency-with-local-ci-for-developers-and-ai-agents).

## Published criticism

The fullest public critique is the Hacker News thread on gh-signoff from 2025-04-14, with 45
comments. These are individual commenters' views, not vendor statements. Source:
[Hacker News thread 43677174](https://news.ycombinator.com/item?id=43677174).

- The tool runs no tests and checks only for uncommitted changes, so it does nothing for a team
  whose members do not already run the suite.
  [Comment](https://news.ycombinator.com/item?id=43677769).
- CI's value is a controlled environment and a build log everyone can read as proof. A bare
  status has neither. [Comment](https://news.ycombinator.com/item?id=43677578).
- People misremember. They run the tests, make one more small change, and push believing the pass
  still holds. [Comment](https://news.ycombinator.com/item?id=43677905),
  [comment](https://news.ycombinator.com/item?id=43678007).
- Local state leaks in. An uncommitted file, a library version or an undeclared dependency exists
  on the laptop and nowhere else. [Comment](https://news.ycombinator.com/item?id=43678025),
  [comment](https://news.ycombinator.com/item?id=43678022).
- A neutral environment is the point of CI, and a run outside a container or VM does not qualify.
  [Comment](https://news.ycombinator.com/item?id=43678565).
- Someone built the same idea in 2012 and found that fixing the CI server paid off better than
  getting everyone to run and record tests locally.
  [Comment](https://news.ycombinator.com/item?id=43677548).

The thread also holds the best defence and the best design brief.

- CI does not protect against a developer you cannot trust either, since they can gut the tests.
  An explicit signoff creates someone to hold to account when a later run fails.
  [Comment](https://news.ycombinator.com/item?id=43677858).
- One commenter set three conditions for accepting the idea at scale. The run happens in a VM
  that matches CI, the results are uploaded and published, and it applies to pull requests only
  while real CI stays on the main branch.
  [Comment](https://news.ycombinator.com/item?id=43677669).
- Another asked for a version with signing and shared logs.
  [Comment](https://news.ycombinator.com/item?id=43677689).

Vouch's map already answers most of this list. The published log and the VM are the two it has
not yet decided.

## Known attacks and failure modes

| #   | Attack or mistake                                                              | Seen in                                                                                                             |
| --- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| 1   | A pass nobody earned. The claim is posted with no run behind it                | gh-signoff run alone, the xYang trailer                                                                             |
| 2   | A stale pass. The tests ran, then the tree changed                             | The Hacker News thread. gh-signoff's clean-tree check covers the uncommitted half                                   |
| 3   | An input the key does not cover. Env var, runtime version, OS, host tool       | Nx, Turborepo and Bazel docs above                                                                                  |
| 4   | An input edited while the run is in progress                                   | Bazel known issues, Gradle use-case docs                                                                            |
| 5   | A low-trust writer whose result a protected branch or a release replays        | CVE-2025-36852, the Ultralytics release                                                                             |
| 6   | The trust list or config read from the tree under test, so a PR edits its own gate | The attest README. WooCommerce and Civ13 read from the base branch to close it                                  |
| 7   | A command that differs from what CI would run, under the same name             | The attest README on gate names. Clouseau signs only the base config's commands                                     |
| 8   | The merge-commit gap. CI tests the merge result, the laptop tested the head    | WooCommerce's `base-moved` flag, attest's tree mismatch, gh-signoff's non-strict ruleset                            |
| 9   | The signing credential within reach of the process under test, or of an agent  | The attest README. SLSA L3 exists to forbid exactly this                                                            |
| 10  | A spoofed name. The label on the claim comes from local config                 | gh-signoff's description field                                                                                      |
| 11  | A shared signing secret. Any holder can forge, and nobody can tell who wrote   | Turborepo's HMAC key                                                                                                |
| 12  | The store itself is compromised or an entry is overwritten                     | Nx's immutability rule and its advice to skip the cache for shipped artifacts                                       |
| 13  | An agent hides a failure, for example by piping output so the exit code is lost | The attest README                                                                                                   |

Sources for each row are the sections above.

## What Vouch can borrow

**From gh-signoff.** The consumer contract. A required status check on the commit is all branch
protection needs, and a one-line install command that writes the ruleset removes the setup work.
Keep its clean-tree and pushed-commit checks. Do not copy its open source of truth: pin the
required check to the Vouch GitHub App as the expected source, which GitHub's rulesets support, so
no user token can post the pass.

**From WooCommerce.** Nearly the whole CI side.

- Publish the result through a GitHub App, since only Apps can write check runs.
- Read the contract and the list of who may attest from the base branch.
- Send any PR that touches the contract or the workflow to full CI.
- Honour attestations on pull requests only, and always run tests on the default branch and in
  the merge queue.
- Fail open into running the tests, and log the reason in one line.
- Sample deterministically from the head SHA and job name, so a re-run cannot dodge the sample.
- Report agree or mismatch as an annotation, with a flag for a moved base.
- Ship a kill switch.

**From attest.** A verifier that cannot fail the build, an `explain` command for "why did it not
skip", platform binding as the default, and the warning that any list of exempt checks is a trust
boundary. Its tree-versus-commit choice deserves a decision of its own.

**From the caches.** The input list. Hash the lockfile, the runtime version, OS and architecture,
the test command and its config, and the declared environment variables, because the caches leave
these to the user and their docs record what goes wrong. Make entries immutable. Scope what a
pull request's attestation can cover so it never satisfies a protected branch, which is the fix
Nx describes for CVE-2025-36852.

**From in-toto, SLSA and Sigstore.** Use the in-toto statement with the test-result predicate as
the attestation format, with the git commit as subject, so other verifiers can read it. Describe
the assurance honestly as SLSA Build L1 with attribution. Use an identity-bound signature and an
append-only record for the detect-and-attribute half of the trust model.

**From Garden and the critics.** An optional container or VM mode for the run is the only known
answer to environment drift that does not rely on a fingerprint. A published log answers the "no
proof" complaint.

## Does an existing tool already cover the destination

No. Each one covers a part.

| Tool                         | Covers                                                           | Missing against Vouch's destination                                                                    |
| ---------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| gh-signoff                   | Status check, ruleset install, git-state checks                  | Runs nothing, records nothing, no identity beyond push access, no audit                                |
| Nx Cloud, Turborepo cache    | Replays a local test pass in CI by input hash, hosted            | Needs the repo to adopt that task runner. No per-result identity. Vendor advice now points to CI-only writes |
| WooCommerce `gh local-ci`    | The full loop with App receipts, allowlist, sampling, parity     | Private, one repository, allowlist compiled into the tool                                              |
| fredericrous/attest          | Open-source signer and verifier action, platform binding         | No service, self-managed SSH keys, trust list in the tree, no sampling, one star                       |
| in-toto, SLSA, Sigstore      | Format, vocabulary, signing and transparency infrastructure      | Not a product. Nothing runs or verifies a test                                                         |

The gap Vouch would fill is the hosted part: identity through GitHub sign-in, one service across
repositories and organizations, a wrapper for any test command, and sampling that reports
mismatches in a dashboard.

Two risks to weigh. A team already on Nx Cloud or Turborepo gets a version of this for free by
leaving developer writes on. And WooCommerce's PR went from opened to merged in six weeks, with
Claude Code named as its author, so the product has to be easier to adopt than to rebuild.

## Unconfirmed

- That no commercial product sells "skip CI because it passed locally". Web searches on
  2026-11-14 found none. A search cannot prove absence.
- That no cache-poisoning incident is on record for Turborepo or a Bazel deployment. Same limit.
- How `gh local-ci` authenticates a laptop to its GitHub App and enforces its allowlist. The
  repository is private.
- Nx's claim that Nx Cloud is not affected by CVE-2025-36852. It is the vendor's statement.
- The mechanics of the Ultralytics cache attack. PyPI's post points to another analysis that I
  did not read.
- Whether Bazel's cache key includes OS or architecture by default. The pages I read do not say.
- Garden's test cache details such as who may write a result. The current docs do not say.
- The Hacker News points are commenters' opinions and carry no more weight than that.

## Questions this raises for the map

1. Does an attestation name the commit SHA or the git tree? The tree survives a rebase and a
   squash merge. The map says "same commit" today.
2. Do attestations count on pull request events only, with tests always running on the default
   branch and in the merge queue? WooCommerce, xYang and the strongest critic all land there.
   This sits next to T-776.
3. How does Vouch keep the signing credential away from the process under test and from an agent
   on the same machine? Every tool reviewed admits it cannot.
4. Does the library offer a container mode for the run, and is a platform mismatch a refusal or
   a setting?
5. Does a run publish its log, and who can read it?
6. How does Vouch explain itself to a repository that already uses Nx Cloud or Turborepo remote
   caching?
7. Should the required check be pinned to the Vouch GitHub App as its expected source? T-768 may
   already own this.

## Sources

- gh-signoff: <https://github.com/basecamp/gh-signoff>
- Rails 8.1 release notes: <https://edgeguides.rubyonrails.org/8_1_release_notes.html>
- 37signals on local CI:
  <https://world.hey.com/dhh/we-re-moving-continuous-integration-back-to-developer-machines-3ac6c611>
- GitHub commit statuses: <https://docs.github.com/en/rest/commits/statuses>
- GitHub check runs: <https://docs.github.com/en/rest/checks/runs>
- GitHub ruleset rules:
  <https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets>
- Nx inputs: <https://nx.dev/docs/reference/inputs>
- Nx remote cache: <https://nx.dev/docs/features/ci-features/remote-cache>
- Nx cache security: <https://nx.dev/docs/kb/cache-security>
- Nx access tokens: <https://nx.dev/docs/kb/access-tokens>
- Nx personal access tokens: <https://nx.dev/docs/kb/personal-access-tokens>
- Nx advisory post:
  <https://nx.dev/blog/cve-2025-36852-critical-cache-poisoning-vulnerability-creep>
- CVE-2025-36852: <https://www.cve.org/CVERecord?id=CVE-2025-36852>
- Turborepo caching: <https://turborepo.dev/docs/crafting-your-repository/caching>
- Turborepo environment variables:
  <https://turborepo.dev/docs/crafting-your-repository/using-environment-variables>
- Turborepo platforms: <https://turborepo.dev/docs/guides/handling-platforms>
- Turborepo remote caching: <https://turborepo.dev/docs/core-concepts/remote-caching>
- turbo run reference: <https://turborepo.dev/docs/reference/run>
- Bazel remote caching: <https://bazel.build/remote/caching>
- Bazel command-line reference: <https://bazel.build/reference/command-line-reference>
- Bazel hermeticity: <https://bazel.build/basics/hermeticity>
- Gradle build cache use cases:
  <https://docs.gradle.org/current/userguide/build_cache_use_cases.html>
- Garden portable CI pipelines:
  <https://docs.garden.io/overview/use-cases/portable-ci-pipelines>
- Garden team caching: <https://docs.garden.io/features/team-caching>
- Nix configuration reference: <https://nix.dev/manual/nix/latest/command-ref/conf-file>
- PyPI on the Ultralytics attack:
  <https://blog.pypi.org/posts/2024-12-11-ultralytics-attack-analysis/>
- SLSA attestation model: <https://slsa.dev/attestation-model>
- SLSA v1.0 levels: <https://slsa.dev/spec/v1.0/levels>
- SLSA v1.0 requirements: <https://slsa.dev/spec/v1.0/requirements>
- SLSA v1.2 build track: <https://slsa.dev/spec/v1.2/build-track-basics>
- in-toto test-result predicate:
  <https://github.com/in-toto/attestation/blob/main/spec/predicates/test-result.md>
- in-toto specification: <https://github.com/in-toto/docs/blob/master/in-toto-spec.md>
- Sigstore security model: <https://docs.sigstore.dev/about/security/>
- GitHub artifact attestations:
  <https://docs.github.com/en/actions/concepts/security/artifact-attestations>
- WooCommerce PR 69176: <https://github.com/woocommerce/woocommerce/pull/69176>
- WooCommerce local-ci-receipt README:
  <https://github.com/woocommerce/woocommerce/blob/trunk/.github/actions/local-ci-receipt/README.md>
- fredericrous/attest: <https://github.com/fredericrous/attest>
- Civ13 PR 3777: <https://github.com/Civ13/Civ13/pull/3777>
- Clouseau PR 224: <https://github.com/gaulatti/clouseau/pull/224>
- xYang PR 108: <https://github.com/exergy-connect/xYang/pull/108>
- Modern Treasury on local CI:
  <https://moderntreasury.com/journal/reducing-feedback-latency-with-local-ci-for-developers-and-ai-agents>
- Hacker News thread on gh-signoff: <https://news.ycombinator.com/item?id=43677174>
