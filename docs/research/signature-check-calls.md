# Live test of the signature check's GitHub calls

Task T-803. Run on 2026-11-15 on GitHub-hosted `ubuntu-latest` runners (Ubuntu 26.04, region eastus2) against two throwaway repos in the `testnotary` organization: the public [`testnotary/live-probe`](https://github.com/testnotary/live-probe) and the private `testnotary/live-probe-private`. Run links break if the repos are deleted, so every value that matters is copied below.

The question: can the action's signature check (ADR 0003) make its GitHub calls with `GITHUB_TOKEN` under the setup guide's `permissions` block, inside the action's 10-second budget?

## The probe

One workflow, `sigcheck.yml`, on `pull_request` and `workflow_dispatch`. Two jobs:

- `guide` has the setup guide's block, a three-leg matrix:

  ```yaml
  permissions:
    contents: read
    id-token: write
    checks: write
  ```

- `minimal` sets the job's block to `id-token: write` and `checks: write` only, so `contents` is `none` as well. The runner's log lists the token's permissions as `Checks: write, Metadata: read`.

Each job checks out with `actions/checkout@v5` at `fetch-depth: 2`, prints git facts, then runs a Node script that calls the three endpoints with `fetch` and `GITHUB_TOKEN`, the way the action would:

1. `GET /user/{account_id}` to resolve the signer's account id to a login.
2. `GET /users/{login}/ssh_signing_keys`.
3. `GET /repos/{owner}/{repo}/collaborators/{login}/permission`.

For each of three account ids (Daniel88dev, the org owner; octocat, who has no access; and an id that does not exist) it ran the three calls in sequence twice, then once more with calls 2 and 3 in parallel. The first sequence in each job includes the TLS connection setup.

Runs: one `pull_request` run and two `workflow_dispatch` runs per repo, four jobs each, 24 jobs in all.

| Repo | `pull_request` | `workflow_dispatch` |
| --- | --- | --- |
| public | [43735852909](https://github.com/testnotary/live-probe/actions/runs/43735852909) on [PR 9](https://github.com/testnotary/live-probe/pull/9) | [43735862538](https://github.com/testnotary/live-probe/actions/runs/43735862538), [43735869335](https://github.com/testnotary/live-probe/actions/runs/43735869335) |
| private | 43735838161 on PR 2 | 43735866253, 43735872259 |

The public repo's `main` is behind a ruleset that only takes the merge queue, so its PR targets an unprotected base branch, `t803-base`. On both repos the PR branch was cut before the base moved one commit, and it changes `testnotary.json` and adds one file.

## Results

| Question | Answer |
| --- | --- |
| Do the three calls succeed with `GITHUB_TOKEN` under the guide's block? | Yes, all `200`, on the public and the private repo, in all 24 jobs. |
| Do they need `contents: read`? | No. The `minimal` job got the same `200`s with `contents: none`. |
| What do the calls ask of the token? | `ssh_signing_keys` answers `x-accepted-github-permissions: allows_permissionless_access=true`. The collaborator permission call answers `metadata=read`, which every `GITHUB_TOKEN` holds. |
| Latency of one call, warm | p50 165 to 201 ms, p95 225 to 485 ms over 144 samples per endpoint. |
| Latency of a whole check | Warm, with calls 2 and 3 in parallel: 290 to 499 ms over 48 sequences. The first sequence in a job, serial: 464 to 2,584 ms over 24 jobs. |
| Does `git show HEAD^1:testnotary.json` work on a `pull_request` merge commit at `fetch-depth: 2`? | Yes, exit 0, and it prints the base branch's version, not the PR's changed one. |
| Does `git diff --name-only HEAD^1 HEAD` work there? | Yes, exit 0. It lists exactly the PR's two files, and not the file that only the base added after the branch was cut. |
| Does a deleted signing key still show for up to 60 seconds? | No, not to a token. Authenticated reads dropped it at the next poll, within 2 seconds. Anonymous reads showed it for up to 6 more seconds. See [the cache test](#the-cache-test). |

### The calls

Every call returned `200` for the two real accounts in all 24 jobs. What the calls returned:

| Account | `user/{id}` | `ssh_signing_keys` | permission on public repo | permission on private repo |
| --- | --- | --- | --- | --- |
| Daniel88dev (org owner) | `200`, login | `200`, `[]` | `200`, `admin` | `200`, `admin` |
| octocat (no access) | `200`, login | `200`, `[]` | `200`, `read` | `200`, `none` |
| id 99999999999 (no such account) | `404 Not Found` | `404` (for a made-up login) | `404 … is not a user` | `404 … is not a user` |

So a user with no access reads `read` on a public repo and `none` on a private one, as T-793 saw with an installation token. The write check has to accept only `admin` and `write`.

Each response carried `cache-control: private, max-age=60, s-maxage=60`. The token's rate limit read `x-ratelimit-limit: 5000` on the `core` resource. The check costs three calls per matrix leg.

### Latency

Milliseconds, from `fetch` start to parsed body, measured on the runner.

| | n | min | p50 | p95 | max |
| --- | --- | --- | --- | --- | --- |
| `GET /user/{id}` | 144 | 82 | 187 | 485 | 2,227 |
| `GET /users/{login}/ssh_signing_keys` | 144 | 77 | 165 | 225 | 298 |
| `GET …/collaborators/{login}/permission` | 144 | 109 | 201 | 279 | 398 |
| Three calls in sequence | 96 | 305 | 568 | 1,081 | 2,584 |
| Call 1, then calls 2 and 3 in parallel | 48 | 290 | 377 | 466 | 499 |

The slow tail is the first call in each job, which opens the connection. The first `GET /user/{id}` in the 24 jobs took 236 to 2,227 ms, 11 of them over 400 ms. The 2,227 ms one came from a private-repo dispatch run (43735866253, `guide (2)`). Of the 360 calls after the first in each job, one took over 400 ms: the first octocat lookup in the private PR run's `guide (1)`, at 1,204 ms. The rest stayed under 335 ms.

The public and the private repo did not differ: warm parallel checks took 290 to 499 ms on the public repo and 295 to 466 ms on the private one.

### Git on the checkout

On the public repo's PR run, at `fetch-depth: 2`:

```
event=pull_request GITHUB_SHA=9868ce36d7cd10ec0ad24f22035df486ee9e6654
HEAD=9868ce36… tree=28b31e2c…
parents=1f0d5826… (base, t803-base) 17a873e8… (PR head)
shallow=true commits_present=3
--- git show HEAD^1:testnotary.json
{ "suites": { "unit": { "command": ["npm", "test"] } } }        (the base's command, exit 0)
--- git diff --name-only HEAD^1 HEAD
t803-pr.txt
testnotary.json                                                   (exit 0)
--- git diff --name-only HEAD^2 HEAD
t803-base.txt                                                     (the base-only file, for contrast)
```

The private repo's PR run printed the same, with its own SHAs. The PR's branch changed the command to `npm test -- --changed-on-branch`, and `HEAD^1` still gave the base's `npm test`. So `fetch-depth: 2` fetches the merge commit and both parents, which is all the two commands need.

On `workflow_dispatch`, `HEAD` is an ordinary commit. `HEAD^1` is its parent, and both commands work there too. `HEAD^2` does not exist.

### `contents: none`

The `minimal` job's three calls succeeded on both repos. Its checkout did not on the private repo:

```
remote: Repository not found.
fatal: repository 'https://github.com/testnotary/live-probe-private/' not found
```

On the public repo, checkout with `contents: none` worked. So the guide's `contents: read` is needed for `actions/checkout` on a private repo, not for the signature check's calls.

### The cache test

Every response carries `cache-control: … max-age=60`, so the question was whether a deleted key keeps verifying for up to a minute. A throwaway Ed25519 signing key was added to Daniel88dev's account and deleted while two pollers read `GET /users/Daniel88dev/ssh_signing_keys` every 2 to 3 seconds:

- the laptop, through `gh` (authenticated) and through plain `curl` (anonymous), plus an anonymous read with a unique query string that no cache could have seen;
- a runner, in `workflow_dispatch` [run 43736998819](https://github.com/testnotary/live-probe/actions/runs/43736998819), with `GITHUB_TOKEN` and anonymously.

| UTC | Event | Laptop, `gh` | Laptop, anonymous | Runner, `GITHUB_TOKEN` | Runner, anonymous |
| --- | --- | --- | --- | --- | --- |
| 16:41:21 | last read before the add | `[]` | `[]` | | |
| 16:41:23 | key `1334119` added | | | | |
| 16:41:24 | | key | `[]` (stale) | | |
| 16:41:33 | | key | key | | |
| 16:43:15 | key deleted | key (16:43:13) | | key | key |
| 16:43:16 | | `[]` | | | |
| 16:43:17 | | | | `[]` | key (stale) |
| 16:43:21 | | | | `[]` | `[]` |

- **Authenticated reads were fresh at the next poll**, on the laptop and on the runner, after both the add and the delete. The `max-age=60` is a hint to the client (`private` on authenticated responses), not a server-side cache.
- **Anonymous reads came from a shared cache for a few seconds.** After the add, the plain URL kept serving the old empty list for 7 to 10 seconds, while the same URL with a unique query string was already fresh. After the delete, the runner's anonymous read showed the key for 2 to 6 more seconds.
- The anonymous pollers ran out of their 60-requests-an-hour limit partway through (the laptop's at 16:42:46, the runner's at 16:44:52). The anonymous rows above come from before that. The authenticated rows cover the whole test.
- The key was deleted at the end and the account has no signing keys, as before the test.

So the action, which reads with `GITHUB_TOKEN` and Node's `fetch` (no HTTP cache), sees a deleted key gone within seconds. The 60-second window would only appear if the action cached responses itself or called the endpoint without a token.

## What this means for Testnotary

- The setup guide's `permissions` block stays as it is. The signature check needs nothing beyond what every `GITHUB_TOKEN` holds.
- Three calls fit the 10-second budget with room to spare: under 0.5 s warm, 2.6 s at worst on a cold connection.
- Running the keys call and the permission call in parallel after resolving the login keeps the warm check under half a second.
- `GET /user/{id}` returning `404` means the account is gone. That is a failed signature check (`signature_invalid`), not `github_unavailable`.
- `fetch-depth: 2` is enough on `pull_request`, `push` and dispatch alike.
- Removing a signing key on GitHub revokes it for signature checks within seconds, as long as the action reads with its token and keeps no cache of its own. The security page can say so.
