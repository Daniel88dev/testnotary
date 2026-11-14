# New entrants that sign or skip on local test passes

Research for Fenro task T-791, part of the Vouch map T-766. I read every page cited here on
2026-11-14. I signed up for nothing, installed nothing and ran none of the packages. Source code
was read on the web.

## The question

The prior-art file concluded that no hosted product covers Vouch's destination. The name research
then met products that file had not seen. What does each one do, does any of them already cover
the destination, and has anything else with the same aim launched since September 2026?

The destination, from the map: a hosted service, an open-source npm library and a GitHub Action
that let CI skip its test job when a valid attestation shows the tests passed for the same commit
on the developer's or the agent's own machine, with an identity on every attestation and CI
re-running a random sample as an audit.

## Answer in short

The conclusion holds, with one sentence changed. No hosted product lets a run on the developer's
or the agent's own machine stand in for the CI test job. What changed is that a funded vendor now
sells the same saving from the other side.

| Product             | What it turned out to be                                                                    | Covers the destination |
| ------------------- | ------------------------------------------------------------------------------------------- | ---------------------- |
| Chainguard Checks   | A hosted CI that runs checks in the vendor's microVMs. Skipping a repeat run is planned     | No                     |
| `prooft`            | An in-repo Python tool. An unsigned commit trailer lets CI skip jobs today                  | No                     |
| `mitchellh/vouch`   | A list of trusted contributors kept in the repo. Nothing to do with tests                   | No                     |
| `vouch` at vouch.sh | A credential broker behind a YubiKey. Nothing to do with tests                              | No                     |
| VouchCI             | An AI code review GitHub App. Nothing to do with tests                                      | No                     |
| `ci-lint`           | Found in the new search. An in-repo policy tool with trailers and a 1-in-10 audit sample    | No, and it is closest  |
| Vercel CI           | Found in the new search. A hosted CI that skips tasks already in its remote cache           | No                     |

Three corrections to the leads from the name research:

1. Chainguard Checks does not sign a verdict per run today. Its announcement says it does. Its
   docs say "Attestations for Checks runs are planned" and that until then the checks run on every
   push to a pull request.
2. `prooft` does skip CI today, in its own repository. It has no signature of any kind. Its stamp
   is a plain SHA-256 that anyone can compute.
3. None of the three tools named "vouch" attests a test run. They share the name and the word
   "trust" and nothing else.

## Chainguard Checks

### What it does today

Chainguard Checks is a CI service. It runs a repository's pull request checks on Chainguard's own
infrastructure and reports them on the pull request's Checks tab. Each check runs in its own
microVM that starts fresh, holds no long-lived credentials and reaches only the network hosts the
check lists. The checks live in `.chainguard/ci.yaml` in Chainguard's own format. It does not run
GitHub Actions workflows, so a team that moves to it rewrites its workflow. Source:
[Checks docs overview](https://www.chainguard.dev/docs/chainguard/checks).

It launched in beta on 2026-10-14. Source:
[Introducing Chainguard Checks](https://www.chainguard.dev/unchained/introducing-chainguard-checks).
The docs call it a Technology Preview, say Technology Previews "aren't recommended for production
use", and list the beta limits: github.com only, no merge queue support, a two-hour cap on a run.
Source: [Checks docs overview](https://www.chainguard.dev/docs/chainguard/checks).

The run never happens on the developer's machine. There are three ways to start one before a pull
request exists, and none of them counts for the pull request.

- `run-ci` inside a Chainguard Workspaces session runs the checks against uncommitted changes in
  the session's VM. The docs say "a pass from `run-ci` predicts that the pull request's checks
  will pass, but only the pull request's run in fresh VMs decides what GitHub shows". It ignores
  `needs`, `when`, `trigger` and `timeout`, and skips checks that need a workload identity or a
  service. Source:
  [Run checks before you push](https://www.chainguard.dev/docs/chainguard/checks/run-checks).
- `chainctl develop check` starts the same session run from a laptop. Source:
  [Run checks before you push](https://www.chainguard.dev/docs/chainguard/checks/run-checks).
- `chainctl checks run` runs a pushed commit's checks in fresh VMs. The docs say this run is "for
  your information only. It doesn't appear on GitHub and never counts as a pull request's or
  commit's result". It still uses the organization's compute allowance. Source:
  [Inspect and run checks](https://www.chainguard.dev/docs/chainguard/checks/inspect-and-run-checks).

On a pull request, the Chainguard GitHub App test-merges the head into the latest base commit and
runs every check. Each new push cancels the earlier run and starts another. Source:
[Checks docs overview](https://www.chainguard.dev/docs/chainguard/checks),
[Checks on GitHub](https://www.chainguard.dev/docs/chainguard/checks/github).

So today the pre-push run and the pull request run are two separate runs, and the customer pays
for both.

### What the vendor says and what it plans

The launch post and the product page describe signing in the present tense.

- "Every path runs the same checks in the same warm, isolated microVMs and returns the same signed
  verdict." Source:
  [Introducing Chainguard Checks](https://www.chainguard.dev/unchained/introducing-chainguard-checks).
- "Attestation Gating: Downstream CI suites don't re-run passing code, saving expensive runner
  minutes in GitHub Actions or legacy CI." Source: the same post.
- "The merge gate can verify the Checks attestation on the PR and merge immediately." Source:
  [Checks product page](https://www.chainguard.dev/checks).

The same launch post puts the merge gate in the future: "Teams will also be able to configure
merge gates to verify these passing verdicts directly, allowing repositories to recognize
validated code and safely skip redundant CI runs to cut compute costs."

The docs settle which reading is current: "Attestations for Checks runs are planned. With them,
Chainguard Checks will verify an earlier passing run instead of running your checks again. Until
then, Chainguard Checks runs your checks on every push to a pull request." Source:
[Checks docs overview](https://www.chainguard.dev/docs/chainguard/checks). The docs page on
identity covers workload identities for cloud access and says nothing about signing a result.
Source:
[Identities and trust](https://www.chainguard.dev/docs/chainguard/checks/identity-and-trust).

I take the docs over the marketing pages. Signed verdicts, merge gates and skipping a repeat run
are plans. No page gives a date, a signing method or a statement of what the attestation will bind
to.

### Who it trusts to write a result

Only its own runners. That is the whole design, and the launch post says so: "Checks give agents
a verdict they can't fake." A person needs the `owner`, `limited_owner` or `sandbox.user` role in
the Chainguard organization to start or read a run from the CLI. Source:
[chainctl checks reference](https://www.chainguard.dev/docs/chainguard/checks/chainctl-checks-reference).
Pull requests from forks run without approval. Source:
[Checks on GitHub](https://www.chainguard.dev/docs/chainguard/checks/github).

### Price and license

The Starter plan is $0 a month with 500 vCPU-hours of Checks. Team is $500 a month with 1,000
vCPU-hours. Enterprise is custom. Source: [Chainguard pricing](https://www.chainguard.dev/pricing).
The docs add that Team meters use up to 2,000 vCPU-hours. Source:
[Checks docs overview](https://www.chainguard.dev/docs/chainguard/checks). No page I read says
Checks or `chainctl` is open source, so I count it as closed.

### What it means for Vouch

Chainguard sells the same saving to the same buyer, teams whose agents open many pull requests,
and it picks the opposite trust model. Vouch trusts a run on a machine the developer controls and
audits it. Chainguard moves the run to a machine it controls, so there is nothing to audit.

That choice costs the customer three things Vouch does not ask for. The team rewrites its CI in
Chainguard's format. Every pre-push run uses paid vendor compute, while the laptop or the sandbox
that already ran the tests goes unused. And the planned gate skips a second Chainguard run, so the
saving only exists for teams that moved their CI to Chainguard first.

It also buys something Vouch cannot offer. Attacks 1, 9, 10 and 13 in the table below do not
apply when the client never holds the result.

## `prooft`

### What it does today

`prooft` is a Python package on PyPI, version 0.2.0 from 2026-11-10, first published 2026-11-08,
BSD-3-Clause, marked Alpha. Source: [PyPI, prooft](https://pypi.org/project/prooft/). Its
repository `forge-ci/prooft` was created on 2026-11-08 and has no stars. Source:
[GitHub API, forge-ci/prooft](https://api.github.com/repos/forge-ci/prooft).

`prooft run LANE -- CMD` runs a command on a clean `HEAD`. On exit code 0 it amends the commit
message with one `Ci-Attestation:` trailer per gate the lane covers. A CI job reads the trailers
and outputs `skip_<job>` for every job whose gates are all valid. Source:
[prooft README](https://github.com/forge-ci/prooft/blob/main/README.md).

It skips CI today. Its own workflow has a `verify` job whose outputs feed the `if:` of the lint
and test jobs, and its roadmap records a hosted run that skipped both. Source:
[prooft ci.yml](https://github.com/forge-ci/prooft/blob/main/.github/workflows/ci.yml),
[prooft ROADMAP](https://github.com/forge-ci/prooft/blob/main/docs/ROADMAP.md). I found no
repository other than its own that uses it. The case it cites, `obs-rust/obs-studio`, runs the
sibling tool `ci-lint`. Source:
[prooft case document](https://github.com/forge-ci/prooft/blob/main/docs/CASE-OBS-RUST.md).

### What it attests and who may write

A trailer is JSON with the gate name, the git tree, the parent commits, the lane, a host label, a
timestamp and a stamp. The stamp is `sha256(tree, parents, canonical JSON)` cut to 32 hex digits.
No key goes into it. Source:
[attestation.py](https://github.com/forge-ci/prooft/blob/main/src/prooft/attestation.py).

So anyone who can write a commit can write a valid trailer without running anything. The README
says this itself: "a trailer is an honesty contract, not a signature. A forged pass can skip a PR
job, but the push to `main` runs the jobs on the merged commit, so a lie turns into a visible red
`main`, never a silent green." Signed attestations sit under "Later" in the roadmap. Source:
[prooft README](https://github.com/forge-ci/prooft/blob/main/README.md),
[prooft ROADMAP](https://github.com/forge-ci/prooft/blob/main/docs/ROADMAP.md).

The trailer carries no identity. The verifier refuses to skip for a fork, for a pull request
whose title carries `[ci-full]`, and for one that edits the policy, the workflows or `ci.toml`.
Source: [prooft README](https://github.com/forge-ci/prooft/blob/main/README.md).

### What it gets right

- The verifier, its wrapper script and the policy are checked out from the pull request's base,
  so a pull request cannot edit what judges it. Source:
  [prooft ci.yml](https://github.com/forge-ci/prooft/blob/main/.github/workflows/ci.yml).
- A trailer binds the tree and the parents, so an amend or a rebase voids it. A lane that declares
  its input files binds to those instead and survives a rebase that left them alone. Source:
  [verify.py](https://github.com/forge-ci/prooft/blob/main/src/prooft/verify.py).
- A trailer expires after 24 hours by default. Source: the same file.
- `run` refuses a dirty tree and refuses when the command changed tracked files or moved `HEAD`.
  Source: [prooft README](https://github.com/forge-ci/prooft/blob/main/README.md).
- A merge queue commit gets credit only when its tree equals the attested head or the lane's
  declared inputs are unchanged. Source: the same README.
- Pushes to `main` and releases always run everything. Source: the same README.

Its own retrospective records the weak spot of input lists. The lint lane declared `src/**` and
`tests/**`, the formatter also read the Python blocks in Markdown files, and a README-only change
would have kept a stale pass valid. A person caught it, not the tool. Source:
[prooft RETROSPECTIVE](https://github.com/forge-ci/prooft/blob/main/docs/RETROSPECTIVE.md).

### What it lacks against the destination

No service, no identity, no signature, no audit sample, no dashboard, and it is a Python tool
where Vouch ships on npm. It is free and open source.

## The three tools named "vouch"

None of them attests a test run or skips CI. They matter for the name ticket only.

**`mitchellh/vouch`.** A trust list for people, not for commits. A project keeps a flat file,
`VOUCHED.td`, of contributors it vouches for or denounces, and GitHub Actions can close issues
and pull requests from people who are not on it. The README leaves the policy to each project. In the
shipped comment workflows, collaborators with the admin, maintain, write or triage role can vouch.
MIT license, 5,176 stars, created 2026-02-05, no hosted part and no price. Source:
[mitchellh/vouch README](https://github.com/mitchellh/vouch),
[GitHub API](https://api.github.com/repos/mitchellh/vouch).

**`vouch` at vouch.sh.** A credential broker. After one login with a YubiKey and a PIN it issues
short-lived SSH certificates, AWS sessions, GitHub tokens and other credentials for up to eight
hours. Apache-2.0 or MIT, 28 stars, created 2026-01-22. The site runs a hosted US instance and the
README covers self-hosting the server. Neither states a price. Source: [vouch.sh](https://vouch.sh),
[vouch-sh/vouch README](https://github.com/vouch-sh/vouch),
[GitHub API](https://api.github.com/repos/vouch-sh/vouch).

**VouchCI.** A GitHub App that reviews pull requests with AI and posts one of three verdicts,
"Vouched", "Worth a look" or "Not yet". Its site mentions no tests, no local runs and no price,
and its footer says "All rights reserved". The App listing has no description and names a personal
account as its developer. Source: [VouchCI site](https://vouchci-dashboard.vercel.app),
[App listing](https://github.com/apps/vouchci).

One thing here is useful beyond the name. The vouch.sh login needs a human touch on a hardware
key, which is the property the map cannot have, because a run in a cloud sandbox has nobody to
touch anything.

## What the new search found

I searched again for products launched since September 2026 with the same aim. The searches found
no hosted product that counts a local run. They found one more open-source tool worth a section, one new hosted CI
that touches the question, and a growing pile of repositories that built the idea for themselves.

### `ci-lint` in `forge-ci/ci.yml`

This is the tool `prooft` copies its trailer format from, and it is the closest open-source match
to Vouch's trust model that I have seen. The repository was created on 2026-09-27, has two stars
and no license file. Source: [GitHub API, forge-ci/ci.yml](https://api.github.com/repos/forge-ci/ci.yml).
It is a policy and a Python checker for one owner's group of repositories, run from each
repository's own workflows. Nothing is hosted. Source:
[ci.yml README](https://github.com/forge-ci/ci.yml/blob/main/README.md).

Its rule GATE-008 lets an attested pull request head skip its remote jobs, and sets these
conditions. Source:
[policy-general.md, GATE-008](https://github.com/forge-ci/ci.yml/blob/main/docs/policy-general.md#attested-skip-of-the-remote-quick-gate-gate-008).

- The trust settings are read from the pull request's base commit.
- The author is an OWNER, MEMBER or COLLABORATOR, and the pull request is not from a fork.
- The trailer covers the exact tree and every lane the base declares.
- No changed path is a "surface". Surfaces are the policy file, the files named in a lane's
  command, the Python files those import, and the skip and verify workflows.
- "the head is not in the 1-in-N audit sample (default 10, keyed by head SHA)".
- The push to the default branch always runs for real.

Two parts go further than anything in the prior-art file.

It has an adoption recipe. Run in `shadow` mode for a week and read what it would have trusted.
Switch to `enforce`, and keep the audit rate at 1 in 10 until at least 20 sampled heads have run
without a disagreement. "A remote failure on an attested head (audit or `main`) is a finding:
switch the repository to `mode = "shadow"` until it is explained."

It publishes numbers. On one repository between 2026-10-03 and 2026-10-26, 127 trusted heads
finished in a median of 39 seconds against a baseline of 914, and 11 audit heads showed no
disagreement. That is the vendor's own measurement of its own repository.

Its trailer is the same unkeyed hash as `prooft`'s. The format document says "The stamp is
tamper-evident; it is not a signature." Source:
[ci-attestations.md](https://github.com/forge-ci/ci.yml/blob/main/docs/ci-attestations.md). So it
names the author through GitHub's author association and audits a sample, and it signs nothing.

### Vercel CI

Vercel CI went into beta on 2026-10-28. It is a hosted CI for Turborepo repositories on GitHub.
On each push it checks Vercel Remote Cache, restores the tasks that are cached and runs the rest
on Vercel's compute. Source: [Introducing Vercel CI](https://vercel.com/blog/introducing-vercel-ci),
[Vercel CI docs](https://vercel.com/docs/ci). The Hobby plan includes 200 CPU minutes a month and
Pro costs $0.0035 per CPU minute. Source: [Vercel CI pricing](https://vercel.com/docs/ci/pricing).

The prior-art file already covers this mechanism as the Turborepo remote cache. The new fact is
how Vercel now limits who may write. Each Vercel CI run gets a cache policy. A pull request run
reads two namespaces, the repository's shared one and its own branch's, and only verified builds
upload to those. The docs give the reason: "a feature branch, fork, or redeploy can't overwrite
the artifacts that your default branch builds reuse." Source:
[Vercel Remote Caching](https://vercel.com/docs/monorepos/remote-caching).

The page lists no namespace that a developer's laptop writes to. I read that as Vercel CI not
restoring a task from an artifact a laptop uploaded, and I could not confirm it. If it holds, the
newest hosted CI has moved the same way the older caches did, toward "only verified CI writes".
The launch post also plans a `vc ci` command "for distributed execution before pushing", which is
the Chainguard shape again, with the pre-push run on the vendor's machines.

### A repository building its own hosted service

`kaeawc/auto-mobile` has an open epic, opened 2026-10-12, to reuse local pre-push results as a CI
signal. Its design is a Go service on Fly.io with an append-only Postgres store, Ed25519 signed
attestations and a GitHub App used as transport only. CI recomputes an input hash, asks the
service and gets skip, advisory or ignore. Ignore is the default. The epic says skips do not
happen yet. Everything sits in that one repository, and nothing offers it to others. Source:
[auto-mobile epic 11972](https://github.com/kaeawc/auto-mobile/issues/11972),
[issue 11981](https://github.com/kaeawc/auto-mobile/issues/11981).

This is Vouch's architecture, built by one project for itself. It is the second sign, after
WooCommerce, that a team with agents will build this before it buys it.

### More in-repo versions

- **HoBo.** Merged 2026-11-11. A trusted machine runs the pull request's required jobs and signs
  the tree, the base tree, the tool versions and result digests with an Ed25519 key. CI reads the
  key list from the base commit through the contents API. Two details are worth copying. The steps
  run with an allowlisted environment and a scratch `HOME` that does not hold the signing key, and
  keys expire after at most 90 days. The description states the limit plainly. Anyone who holds a
  trusted key can make the covered checks pass without running them. It has no audit sample.
  Source: [Hobo-Labs/HoBo PR 1860](https://github.com/Hobo-Labs/HoBo/pull/1860).
- Four more pull requests merged in October 2026 do the same with a commit status or a trailer. I
  read only their titles and states, so I list them as evidence of demand and nothing else.
  [code-foundry PR 137](https://github.com/alexwaumann/code-foundry/pull/137),
  [agentscm PR 86](https://github.com/agentscm/agentscm/pull/86),
  [warehouse_management PR 424](https://github.com/arb-rajab/warehouse_management/pull/424),
  [agentic-security PR 83](https://github.com/Clear-Capabilities/agentic-security/pull/83).

### Neighbours that do not skip CI

These came up in the searches and are older than September 2026 or aim elsewhere. I list them so
nobody has to check them again.

- **CircleCI Chunk sidecars.** Sync local code to a remote Linux microVM and run the tests there
  before a push. Free on every CircleCI plan for now. Its page says nothing about a pass counting
  in the pipeline afterwards. The `chunk-cli` repository dates from 2026-02-26. Source:
  [chunk.ai](https://chunk.ai/),
  [GitHub API, chunk-cli](https://api.github.com/repos/CircleCI-Public/chunk-cli).
- **ProofRun.** A local Go CLI from August 2026 that records which commands ran against the
  current code and signs the receipt with an HMAC key kept on the same machine. Its GitHub Action
  deletes any receipt on the branch and runs every check again, so it never skips. MIT, 15 stars.
  Source: [yebiguo/ProofRun](https://github.com/yebiguo/ProofRun).
- **attest-it.** An npm package from January 2026 for tests that cannot run in CI at all, such as
  ones that need a desktop app. A person runs the suite and signs a seal with an Ed25519 key, and
  CI verifies the seal. It replaces a job CI could never run. It does not skip one CI could run.
  MIT. Source: [npm, attest-it](https://www.npmjs.com/package/attest-it).
- **verify.** A Rust CLI from February 2026 that writes a `Verified:` line of hashes into the
  commit message and lets CI skip checks whose hashes match. Unsigned, one star, no license file.
  Source: [yonaskolb/verify](https://github.com/yonaskolb/verify).

## How each one handles the known attacks

The rows are the 13 attacks from `docs/research/prior-art.md`. The three "vouch" tools attest no
test run, so the table leaves them out. The Chainguard column describes the product as its docs
describe it today plus the stated plan. Where a cell says "not published", the vendor has given no
detail.

| #   | Attack or mistake                         | Chainguard Checks                                                                                  | `prooft`                                                                      | `ci-lint`                                                              |
| --- | ----------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1   | A pass nobody earned                      | Does not apply. Only its own runners produce a result                                              | Open. Anyone can write a valid trailer. The run on `main` catches it later    | Open in the trailer. The 1-in-10 audit and the run on `main` catch it  |
| 2   | A stale pass                              | Every push starts a new run today. Binding of the planned attestation is not published            | Tree and parents bound. Dirty tree refused. 24-hour expiry                    | Exact tree. 24-hour expiry                                             |
| 3   | An input the key does not cover           | Fresh microVM built from declared packages, network closed by default                              | Host label recorded and not compared. Environment and runtime not covered     | Gate names carry the platform. Emulated lanes may not prove `test`     |
| 4   | An input edited during the run            | Does not apply. The run is remote                                                                  | Refuses when tracked files changed or `HEAD` moved. Untracked files not covered | I did not read how it handles this                                     |
| 5   | A low-trust writer replayed by a branch   | Fork pull requests run without approval. Whether a fork's verdict will count is not published      | Forks skip nothing. `main` and releases recompute                             | Forks and non-members skip nothing. `main` and releases recompute      |
| 6   | Trust list read from the tree under test  | Trust rings come from the default branch. Check config comes from the test merge, so a PR edits it | Policy and verifier from the base. A PR that edits them runs everything       | Trust settings from the base. A changed surface runs everything        |
| 7   | A different command under the same name   | Session runs skip some checks and ignore conditions. The docs call them a prediction               | Open for tree-bound lanes. The caller types the command                       | Lane commands and the Python they import are surfaces                  |
| 8   | The merge-commit gap                      | PR runs test a merge with the latest base. No merge queue support                                  | Verifies the head. Credits a queue commit only on equal tree or equal inputs  | Exact tree of the head. `main` always runs                             |
| 9   | Signing credential within reach           | The VM holds no long-lived credentials. Signing is not published                                   | Does not apply. There is no credential                                        | Does not apply. There is no credential                                 |
| 10  | A spoofed name                            | Does not apply. The client names nothing                                                           | Open. The host label is self-reported and no identity is checked              | Author association comes from GitHub                                   |
| 11  | A shared signing secret                   | Not published                                                                                      | Weaker than shared. There is no secret                                        | Weaker than shared. There is no secret                                 |
| 12  | The store compromised or overwritten      | Not published                                                                                      | The commit message is the store. Ledger artifacts count only from the CI workflow | The commit message is the store                                        |
| 13  | An agent hides a failure                  | The runner reads the exit code in its own VM. A PR can still change the check's command            | Trusts the exit code of whatever command the caller typed                     | Same, with lane commands guarded as surfaces                           |

Sources for each cell are the product sections above.

## Comparison

"Vouch as designed" follows the map T-766 and its closed decisions. Nothing in that row is built.

| Product                 | Where the run happens                         | Who may write a result                                                         | Skips CI today                                                  | Audit or sampling                                   | Hosted or in-repo                      | Open source                 | Price                                                    |
| ----------------------- | --------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------- | --------------------------- | -------------------------------------------------------- |
| Chainguard Checks       | The vendor's microVMs                         | Only the vendor's runners                                                      | No. Planned, no date. Every push runs the checks                | None described                                      | Hosted                                 | Not stated, treated as no   | $0 for 500 vCPU-hours a month, $500 a month for 1,000    |
| `prooft`                | The developer's machine                       | Anyone who can write the commit, unless a fork or a guarded-file edit          | Yes, in its own repository                                      | None. The run on `main` is the backstop             | In-repo                                | Yes, BSD-3-Clause           | Free                                                     |
| `ci-lint`               | The developer's machine                       | An owner, member or collaborator, same guards as above                         | Yes, in its owner's repositories                                | 1 in 10 heads, keyed by head SHA                    | In-repo                                | Public, no license file     | Free                                                     |
| `mitchellh/vouch`       | Does not run tests                            | Collaborators vouch for people                                                 | No. Not its purpose                                             | None                                                | In-repo                                | Yes, MIT                    | Free                                                     |
| `vouch` at vouch.sh     | Does not run tests                            | The server issues credentials after a hardware-key login                       | No. Not its purpose                                             | None                                                | Hosted and self-hosted                 | Yes, Apache-2.0 or MIT      | Not stated                                               |
| VouchCI                 | Does not run tests. Reviews the diff with AI  | The App posts a review verdict                                                 | No. Not its purpose                                             | None                                                | Hosted                                 | No                          | Not stated                                               |
| Vercel CI               | The vendor's machines                         | Verified CI builds write the cache. Laptop writes unconfirmed                  | Yes, for tasks its own earlier runs cached                      | None described                                      | Hosted                                 | No. Turborepo itself is     | 200 CPU minutes free on Hobby, $0.0035 a CPU minute on Pro |
| WooCommerce `gh local-ci` | The developer's machine                     | Allowlisted people, through a GitHub App                                       | Yes, in one repository                                          | 10 percent of JavaScript unit jobs                  | In-repo, private tool                  | No                          | Not for sale                                             |
| Vouch as designed       | The developer's laptop or the agent's sandbox | A GitHub-signed-in identity holding a token the service issued                 | Not built                                                       | CI re-runs a random sample and flags any mismatch   | Hosted service, in-repo library and action | Library and action yes  | Free public beta                                         |

The WooCommerce row comes from the prior-art file and is here for comparison. Sources for the
other rows are the product sections above.

## Does the prior-art conclusion still hold

Yes. Read the sentence as "no hosted product lets a run on the developer's or the agent's own
machine stand in for the CI test job" and nothing I found breaks it.

- The one hosted product from the leads, Chainguard Checks, runs the tests on its own machines
  and does not skip anything yet.
- The one tool from the leads that skips on a local pass, `prooft`, is an in-repo script with no
  identity and no signature.
- The three "vouch" tools are in other fields.
- The wider search found a second in-repo tool with sampling, a hosted CI that restricts cache
  writes to its own builds, and six more repositories that built or started their own version
  since the start of October 2026.

The prior-art file's wording was looser than that. It said "I found no hosted product that sells
this", and a reader could take "this" to mean the saving. Chainguard now sells the saving. The
map's decision line should carry the narrower sentence.

## What is left for Vouch that the others do not do

1. **Count the run that already happened.** An agent's sandbox has run the tests by the time it
   opens the pull request. Chainguard and Vercel both ask for a second run on their machines.
   Only the in-repo tools use the first run, and none of them is a product.
2. **Put an identity on the result.** `prooft` and `ci-lint` have none in the trailer. HoBo and
   `attest` manage key files by hand. A token issued after GitHub sign-in, as T-770 chose, is
   something no tool in this file has.
3. **Keep the workflow.** Vouch wraps the test command the repository already declares. Chainguard
   needs its own config format and Vercel CI needs Turborepo.
4. **Audit across repositories and show it.** `ci-lint` and WooCommerce sample. Neither shows
   mismatches anywhere but a log line or an annotation, and each works for one owner.
5. **Ship on npm for any repository.** The two working open-source tools are Python and tied to
   their author's CI policy.

## What Vouch should take from the new entrants

- From `ci-lint`, the adoption recipe. Shadow mode first, then enforce, a fixed number of clean
  audits before the rate may drop, and an automatic return to shadow when an audit disagrees.
- From `ci-lint` and `prooft`, an expiry on every attestation. Both use 24 hours.
- From `prooft`, a verifier that comes from the base branch along with the policy. Vouch's
  verifier is a published action, so the matching rule is a pinned action version that a pull
  request cannot change without forcing a full run.
- From `prooft`'s retrospective, a warning. A declared list of input files drifts from what the
  command really reads, and nothing catches it. Binding the whole tree is the safe default.
- From HoBo, a way to keep the credential from the tests: run the test command with an allowlisted
  environment and a scratch home directory that the credential is not in.
- From Chainguard's pitch, the sentence Vouch will be measured against: "a verdict they can't
  fake". Vouch cannot say that, and T-770 already found why. Its honest sentence is that a faked
  pass is signed by a named account and gets caught by the sample.

## Unconfirmed

- That Chainguard has shipped no signing yet. I rely on one sentence in its docs, last updated
  2026-11-12 on the page I read. The launch post and the product page say the opposite in the
  present tense. I did not sign up, so I did not see the product.
- That Chainguard Checks is closed source. No page says either way.
- Whether Vercel CI restores a task from an artifact a laptop uploaded. The cache policy page
  lists no laptop namespace and does not say what happens to those uploads.
- That no repository other than its own uses `prooft`. This comes from its own documents.
- The `ci-lint` measurements. They are the author's numbers for the author's repository.
- VouchCI's price and how it works inside. Its site and listing say almost nothing.
- The four pull requests I list by title only.
- That no other hosted product exists. About a dozen searches on 2026-11-14 found none. A search
  cannot prove absence, and this file exists because the last search missed several.

## Questions this raises for the map

1. How does Vouch explain itself next to Chainguard Checks? The landing page prototype T-784 is
   blocked on this ticket and needs the answer. The comparison is "the run you already paid for"
   against "a verdict nobody can fake".
2. Does v1 ship a shadow mode, a rule for when the audit rate may drop, and an automatic fallback
   when an audit disagrees? `ci-lint` has all three. This belongs with the trust model, T-775.
3. Does an attestation expire, and after how long? Both open-source tools say 24 hours. The map
   lists retention as not yet specified and says nothing about freshness.
4. Does the library run the test command with a stripped environment so the token is out of the
   tests' reach? HoBo does. The prior-art file asked the same question and had no example.
5. Should a later version offer a run on a machine the service controls, for teams that want
   Chainguard's guarantee? The prior-art file raised a container mode. This is the stronger form.
6. The words "attestation" and "verdict" are now Chainguard's marketing terms for a result its
   own runners produce. The glossary uses "attestation" for a client-signed record. The name
   ticket T-774 and the docs should expect readers to arrive with Chainguard's meaning.

## Sources

- Chainguard, Introducing Chainguard Checks, 2026-10-14:
  <https://www.chainguard.dev/unchained/introducing-chainguard-checks>
- Chainguard Checks product page: <https://www.chainguard.dev/checks>
- Chainguard Checks docs overview: <https://www.chainguard.dev/docs/chainguard/checks>
- Chainguard, Run checks before you push:
  <https://www.chainguard.dev/docs/chainguard/checks/run-checks>
- Chainguard, Inspect and run checks:
  <https://www.chainguard.dev/docs/chainguard/checks/inspect-and-run-checks>
- Chainguard, chainctl checks reference:
  <https://www.chainguard.dev/docs/chainguard/checks/chainctl-checks-reference>
- Chainguard, Checks on GitHub: <https://www.chainguard.dev/docs/chainguard/checks/github>
- Chainguard, Identities and trust:
  <https://www.chainguard.dev/docs/chainguard/checks/identity-and-trust>
- Chainguard pricing: <https://www.chainguard.dev/pricing>
- PyPI, prooft: <https://pypi.org/project/prooft/>
- forge-ci/prooft: <https://github.com/forge-ci/prooft>
- prooft `attestation.py`:
  <https://github.com/forge-ci/prooft/blob/main/src/prooft/attestation.py>
- prooft `verify.py`: <https://github.com/forge-ci/prooft/blob/main/src/prooft/verify.py>
- prooft workflow: <https://github.com/forge-ci/prooft/blob/main/.github/workflows/ci.yml>
- prooft roadmap, case document and retrospective:
  <https://github.com/forge-ci/prooft/tree/main/docs>
- forge-ci/ci.yml: <https://github.com/forge-ci/ci.yml>
- ci.yml policy, GATE-008:
  <https://github.com/forge-ci/ci.yml/blob/main/docs/policy-general.md#attested-skip-of-the-remote-quick-gate-gate-008>
- ci.yml attestation format:
  <https://github.com/forge-ci/ci.yml/blob/main/docs/ci-attestations.md>
- mitchellh/vouch: <https://github.com/mitchellh/vouch>
- vouch.sh: <https://vouch.sh>
- vouch-sh/vouch: <https://github.com/vouch-sh/vouch>
- VouchCI site: <https://vouchci-dashboard.vercel.app>
- VouchCI App listing: <https://github.com/apps/vouchci>
- Vercel, Introducing Vercel CI, 2026-10-28: <https://vercel.com/blog/introducing-vercel-ci>
- Vercel CI docs: <https://vercel.com/docs/ci>
- Vercel CI pricing: <https://vercel.com/docs/ci/pricing>
- Vercel Remote Caching: <https://vercel.com/docs/monorepos/remote-caching>
- kaeawc/auto-mobile epic 11972: <https://github.com/kaeawc/auto-mobile/issues/11972>
- kaeawc/auto-mobile issue 11981: <https://github.com/kaeawc/auto-mobile/issues/11981>
- Hobo-Labs/HoBo PR 1860: <https://github.com/Hobo-Labs/HoBo/pull/1860>
- alexwaumann/code-foundry PR 137: <https://github.com/alexwaumann/code-foundry/pull/137>
- agentscm/agentscm PR 86: <https://github.com/agentscm/agentscm/pull/86>
- arb-rajab/warehouse_management PR 424:
  <https://github.com/arb-rajab/warehouse_management/pull/424>
- Clear-Capabilities/agentic-security PR 83:
  <https://github.com/Clear-Capabilities/agentic-security/pull/83>
- CircleCI Chunk: <https://chunk.ai/>
- yebiguo/ProofRun: <https://github.com/yebiguo/ProofRun>
- npm, attest-it: <https://www.npmjs.com/package/attest-it>
- yonaskolb/verify: <https://github.com/yonaskolb/verify>
- Prior art for trusting local test runs, T-767: `docs/research/prior-art.md` on the branch
  `research/prior-art`
- Candidate project names and their availability, T-773: `docs/research/project-names.md` on the
  branch `research/project-names`
