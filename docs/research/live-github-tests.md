# Live tests of unconfirmed GitHub behaviours

Task T-787. Run on 2026-11-15 against the throwaway repo [`testnotary/live-probe`](https://github.com/testnotary/live-probe), a public repo in the `testnotary` organization, with a fork at `Daniel88dev/live-probe`. Run links break if the repo is deleted, so every value that matters is copied below.

## The probe

One workflow, [`probe.yml`](https://github.com/testnotary/live-probe/blob/main/.github/workflows/probe.yml), runs on `push` to `main`, `pull_request` (opened, synchronize, reopened, labeled) and `merge_group`, with `id-token: write` and `checks: write`. Its jobs:

- `oidc` prints `GITHUB_SHA`, the checked-out commit with its tree and parents, the event's head and base SHA, and the tip of `main` at run time. It then requests an OIDC token with audience `testnotary-probe` and prints the decoded payload only, never the token.
- `gate` outputs `attested=true`. `mskip` is a two-leg matrix job with `if: ${{ !cancelled() && needs.gate.outputs.attested != 'true' }}`, so it is always skipped. `mrun` is the same matrix, always run.
- `api-check` creates a check run named `api-made-check` with the workflow's `GITHUB_TOKEN`.

Required checks were set through one repository ruleset on `main` and changed between tests. A PR's merge state was read through GraphQL `mergeStateStatus` after each change.

## Results

| # | Question | What GitHub did |
| --- | --- | --- |
| 1 | Does a Dependabot-triggered run get an OIDC token with `id-token: write`? | Yes. `actor` is `dependabot[bot]`. The raised `checks: write` worked too. |
| 2 | What does the OIDC `sha` claim hold? | Always `GITHUB_SHA`. On `pull_request` that is the test merge commit, on `push` the pushed tip, on `merge_group` the merge group's head commit. |
| 3 | How long does the OIDC token live? | 300 seconds from `iat` to `exp`, with `nbf` 300 seconds before `iat`. Same in all 19 runs that got one. |
| 4 | How does a skipped matrix job report? | One check run under the bare job name, `mskip`, conclusion `skipped`. No `mskip (20)` or `mskip (22)`. |
| 5 | Does a check run made with `GITHUB_TOKEN` satisfy a required check pinned to GitHub Actions? | Yes. The check run belongs to `github-actions` (app id 15368) and the PR became mergeable. |
| 6 | Can a GitHub App write a check run on a fork PR's head SHA? | Not run. The test App was not created. |
| 7 | Does every `pull_request` event rebuild the test merge on the current base tip? | No. Only `opened` and `synchronize` ran on a fresh merge. `labeled` and `reopened` reused a merge on the old base. |
| 8 | How does GitHub's merge treat `merge=union`? | It ignores it. The PR shows a conflict, no merge ref is built and no `pull_request` run starts. Local `git merge-tree` merges the same PR cleanly. |
| 9 | What does a merge group test and land under squash and rebase? | Under both, the commit the group tests is the exact commit that lands on `main` by fast-forward. Its tree equals `git merge-tree --write-tree <base tip> <PR head>`. |
| 10 | Can an installation token with Contents read and Metadata read call the collaborator permission endpoint? | Not run. Needs the test App. |
| 11 | Can the same token call the compare endpoint? | Not run. Needs the test App. |

## Details

### 1. Dependabot and OIDC

Dependabot opened [PR 1](https://github.com/testnotary/live-probe/pull/1) minutes after `dependabot.yml` landed. All three runs it triggered (`opened` and two `labeled`, one per label Dependabot added) got a token. [Run 43724576249](https://github.com/testnotary/live-probe/actions/runs/43724576249) shows:

```
event=pull_request action=opened actor=dependabot[bot]
"actor": "dependabot[bot]", "event_name": "pull_request", "ref": "refs/pull/1/merge",
"sha": "f6a2038432b182effdadfea2b8aa9899c558202c"   (the merge commit, parents f4eccc6 and 6e45433)
```

In the same run, `api-check` created a check run with `GITHUB_TOKEN`, so the `permissions` key raised `checks` from read to write for Dependabot as well.

For contrast, the fork PR ([PR 8](https://github.com/testnotary/live-probe/pull/8), [run 43725785008](https://github.com/testnotary/live-probe/actions/runs/43725785008)) had no `ACTIONS_ID_TOKEN_REQUEST_URL` at all, and `api-check` got `Resource not accessible by integration (HTTP 403)`.

### 2. The `sha` claim

| Event | Run | `sha` claim | What it is |
| --- | --- | --- | --- |
| `push` | [43724492094](https://github.com/testnotary/live-probe/actions/runs/43724492094) | `f4eccc6` | the pushed tip of `main` |
| `pull_request` | [43724832674](https://github.com/testnotary/live-probe/actions/runs/43724832674) | `619cb6f` | `refs/pull/3/merge`, parents `f4eccc6` (base) and `6cb74f9` (head) |
| `merge_group` | [43725537748](https://github.com/testnotary/live-probe/actions/runs/43725537748) | `8586c6d` | the merge group head, `merge_group.head_sha` |

In all 19 runs that got a token, `sha` equalled `GITHUB_SHA`, and so did `workflow_sha`. On `merge_group`, `ref` is `refs/heads/gh-readonly-queue/main/pr-3-909ab97…` and `base_ref` and `head_ref` are empty. The repo was created after 2026-07-15, and `sub` used the id form: `repo:testnotary@356912382/live-probe@1458884501:pull_request`.

### 3. Token lifetime

Every token had `exp - iat = 300` and `iat - nbf = 300`. So a token is valid from five minutes before it was issued until five minutes after.

### 4. Skipped matrix job

On [PR 2](https://github.com/testnotary/live-probe/pull/2) ([run 43724684183](https://github.com/testnotary/live-probe/actions/runs/43724684183)), the skipped matrix job reported one check run, `mskip`, `skipped`. The matrix job that ran reported `mrun (20)` and `mrun (22)` and no bare `mrun`.

| Required check | Merge state |
| --- | --- |
| `mskip (20)` | `BLOCKED`. The check is never reported. |
| `mskip` | `CLEAN` |

So neither name works in both cases. Requiring `test (20)` blocks every PR whose tests were skipped. Requiring `test` blocks every PR whose tests ran, because a matrix job that runs never reports the bare name.

### 5. Check runs made with `GITHUB_TOKEN`

`api-check` created `api-made-check` on the PR head with `GITHUB_TOKEN`. The API returned `app_slug: github-actions, app_id: 15368`. On PR 2:

| Required check | Merge state |
| --- | --- |
| `api-made-check`, pinned to GitHub Actions (15368) | `CLEAN` |
| `api-made-check`, any source | `CLEAN` |
| `does-not-exist`, pinned to GitHub Actions (control) | `BLOCKED` |

Any workflow whose token has `checks: write` can therefore satisfy a required check of any name pinned to GitHub Actions, without running that job.

### 7. Merge ref freshness

[PR 3](https://github.com/testnotary/live-probe/pull/3) was opened on base `f4eccc6`. `main` then moved to `bc32bbd` by merging PR 2. What each later event ran on:

| Event | When | Run | Merge parents | `pull_request.base.sha` |
| --- | --- | --- | --- | --- |
| `opened` | before the base moved | [43724832674](https://github.com/testnotary/live-probe/actions/runs/43724832674) | `f4eccc6`, `6cb74f9` | `f4eccc6` |
| `labeled` | 2 s after the base moved | [43724888748](https://github.com/testnotary/live-probe/actions/runs/43724888748) | `f4eccc6`, `6cb74f9` (stale) | `f4eccc6` (stale) |
| `labeled` | 122 s after | [43725076267](https://github.com/testnotary/live-probe/actions/runs/43725076267) | stale | stale |
| `labeled` | after two REST reads of the PR | [43725164796](https://github.com/testnotary/live-probe/actions/runs/43725164796) | stale | stale |
| `reopened` | after close and reopen | [43725236443](https://github.com/testnotary/live-probe/actions/runs/43725236443) | stale | stale |
| `synchronize` | after a push to the head | [43725288432](https://github.com/testnotary/live-probe/actions/runs/43725288432) | `bc32bbd`, `9e38a10` (fresh) | `bc32bbd` |

`git ls-remote` showed `refs/pull/3/merge` unchanged at `619cb6f` for at least two minutes after the base moved, and the REST reads returned `merge_commit_sha` `619cb6f` and `base.sha` `f4eccc6`. Closing and reopening did rebuild the ref (to `5f69b97`, parents `bc32bbd` and `6cb74f9`), but after the `reopened` run had already started on the old one. On every stale run the OIDC `sha` was the stale merge commit, so the claim always names the commit CI actually tested.

### 8. `merge=union`

`main` carried `.gitattributes` with `union.txt merge=union`. [PR 5](https://github.com/testnotary/live-probe/pull/5) and `main` each appended a different line to `union.txt`. [PR 6](https://github.com/testnotary/live-probe/pull/6) did the same to `plain.txt`, which has no attribute, as the control.

- GitHub: both PRs `mergeable=false`, `mergeable_state=dirty`. Neither got a `refs/pull/N/merge` ref, and neither triggered a `pull_request` run.
- Local git 2.56: `git merge-tree --write-tree` merged PR 5 cleanly to tree `c9eb324` and reported a conflict on PR 6.

### 9. Merge groups

The ruleset required `oidc` and turned on a merge queue (`ALLGREEN`, one entry minimum).

**Squash.** [PR 3](https://github.com/testnotary/live-probe/pull/3) had two commits, head `9e38a10`. The merge group ([run 43725537748](https://github.com/testnotary/live-probe/actions/runs/43725537748)) tested `8586c6d`, a single commit whose parent was the tip of `main` (`909ab97`). `main` then fast-forwarded to `8586c6d`. Its tree `909e226` equals `git merge-tree --write-tree 909ab97 9e38a10`.

**Rebase.** [PR 7](https://github.com/testnotary/live-probe/pull/7) had two commits, head `a9a7528`, branched one commit behind `main`. The merge group ([run 43725691566](https://github.com/testnotary/live-probe/actions/runs/43725691566)) tested `f0bd4c1`, the second of two rebased commits (`80ed8e2` then `f0bd4c1`) on the tip of `main` (`8586c6d`). `main` then fast-forwarded to `f0bd4c1`. Its tree `2753f81` equals `git merge-tree --write-tree 8586c6d a9a7528`.

Under both methods the commit that lands is the commit the queue tested, and the following `push` run on `main` sees the same tree.

## What this means for Testnotary

- **The tree rule holds as decided in Merge-commit gap (T-776).** Resolving the OIDC `sha` gives the tree CI really builds, on every event. When a `pull_request` run reuses a stale merge, that tree is the stale merge's tree, and an attestation for the current merge does not match. That is a fallback, never a wrong skip.
- **The action has to expect a token on Dependabot runs.** The service will see `actor: dependabot[bot]` with no attestation and answer with a fallback. Fork runs get no token, and the action reports that as a fallback too, never as an error.
- **The token is short-lived.** The action requests it just before calling the service. The service allows the 300-second window plus clock skew, and can reject a `jti` it has already seen.
- **A matrix test job cannot be gated by a job-level `if`.** The bare-name check of a skipped matrix and the per-leg checks of a run matrix never coincide. The action contract has to pick one of: a step-level skip inside each leg, or one aggregate job that `needs` the matrix, runs with `!cancelled()` and is the only required check.
- **Pinning the required check to GitHub Actions protects nothing.** Any workflow with `checks: write` can post a passing check of the same name. This fits the trust model, where the reviewer catches a workflow edit in the diff. The setup guide can recommend `permissions: checks: none` (or omitting it) on workflows that do not need it.
- **GitHub ignores custom merge attributes.** A tree the library predicts with `git merge-tree` can differ from GitHub's for a repo with `merge=union`. Today that only produces an attestation for a merge GitHub never builds, so no skip is wrong. The library contract could run `merge-tree` with attributes off to match GitHub.
- **A merge queue under squash or rebase needs no second test run.** The group's tree equals the PR's merge on the current base, so an attestation for that tree covers the merge group and the push to `main` after it.

## Not run

Tests 6, 10 and 11 need a test GitHub App with Checks write, Contents read and Metadata read installed on the repo, and the App was not created in this session. Test 6 (an App writing a check run on a fork PR's head) only mattered for an App-owned required check, which the trust model ruled out of v1. Tests 10 and 11 still matter for the service.
