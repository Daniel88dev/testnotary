# How a GitHub workflow can skip its test job safely

Research for Fenro task T-768. I read every source on 2026-11-14. GitHub changes these rules often, so check the linked page before building on a claim. Numbers in square brackets point to the source list at the end. A claim marked "unconfirmed" has no primary source behind it yet.

In this file "check" always means a GitHub status check. The glossary word for Vouch's own question to the service is "verification".

## The question

Which GitHub mechanisms let one action decide that a workflow's test job does not need to run, while branch protection still sees a required check as passed?

## Short answer

Three mechanisms work today and Vouch can build on them.

1. A job skipped by its own `if` reports Success and satisfies a required check [1] [6]. The action can set a job output, and the test job can read it in `if`.
2. A workflow can request an OIDC token that GitHub signs. The token names the repository, the ref, the commit, the workflow and the actor [19]. The service verifies it with GitHub's public keys, so the action needs no stored secret [20] [21].
3. A GitHub App can write its own check run, and branch protection can require that check from that app only [3] [4]. Nobody else in the repository can produce it.

Three things are unsafe or unavailable.

1. A test job that `needs` the verification job and has a plain `if` is skipped when the verification job fails, and a skipped job passes [2] [7]. An outage of the service would wave every pull request through. The `if` must start with `!cancelled()` so a failed verification runs the tests.
2. Skipping the whole workflow leaves the required check pending and blocks the merge [2] [10]. Path filters, branch filters and `[skip ci]` all do this.
3. Pull requests from forks get a read-only token, no secrets and no OIDC token [7] [11] [28]. The action cannot prove who it is there, so the workflow runs its normal test job.

For the service itself, a GitHub App covers sign-in, access by installation and check runs. An OAuth app cannot create check runs at all [12].

## How required status checks treat skipped work

### What counts as passing

A required check passes when its latest result on the latest commit is `success`, `skipped` or `neutral` [2] [3]. Results from earlier commits do not count [2].

GitHub matches a required check by name only. For a workflow job the name is the job name, and the rule ignores the workflow, the matrix and the trigger [5]. Two jobs with the same name in different workflows make the result ambiguous and can block merging [3]. If a check run and a commit status share a required name, both must pass [2].

### The cases

| Case | What branch protection sees | Source |
| --- | --- | --- |
| A job skipped by its own `if` | Success. The pull request can merge. | [1] [6] |
| A job whose `if` reads another job's output, such as `needs.verify.outputs.attested` | The same as any job-level `if`. False means skipped, and skipped means Success. | [6] [9] |
| A job that `needs` a job that failed or was skipped | GitHub skips it too, unless its `if` uses a status function. The docs warn that it "may not block merging". | [2] [7] [8] |
| A workflow that never started because of a path filter, a branch filter or `[skip ci]` in the commit message | The check stays Pending with "Waiting for status to be reported". Merging is blocked. | [2] [10] |
| A workflow job started by an event other than `push`, `pull_request`, `pull_request_review`, `pull_request_target`, `deployment` or `deployment_status` | The check does not count for the pull request, even when it passes on the head commit. This limit covers checks from workflow jobs. Checks from an external GitHub App are exempt. | [2] |
| A pull request in a merge queue | The workflow needs the `merge_group` trigger, or the required check never reports and the merge fails. | [2] [11] |

The third row is the trap. Every `if` gets an implicit `success()` unless the expression calls a status function [8]. So this job is skipped, and passes, when `verify` crashes or times out:

```yaml
test:
  needs: verify
  if: needs.verify.outputs.attested != 'true'
```

GitHub's own advice for required checks that depend on other jobs is `always()` with `needs` [2]. The expressions page recommends `!cancelled()` over `always()` [8]. With either one, a failed `verify` leaves the output empty, the comparison is true, and the tests run:

```yaml
test:
  needs: verify
  if: ${{ !cancelled() && needs.verify.outputs.attested != 'true' }}
```

A second way avoids skipped jobs entirely. The test job always runs, calls the action in its first step, and puts `if: steps.verify.outputs.attested != 'true'` on the steps after it [7]. The job then finishes with a real Success. I have not measured what that costs in runner time against a skipped job.

### Two details that affect the action

GitHub evaluates a job's `if` before it expands the matrix [7]. Unconfirmed: a skipped matrix job should then report one check under the plain job name and none under the per-combination names, which would leave a required `test (20)` check pending. Test this before the spec promises matrix support.

On `pull_request` the workflow file and the checked-out code both come from the pull request's merge commit, not from the base branch [18]. `GITHUB_SHA` is that merge commit. The head commit, the one a developer tested locally, is `github.event.pull_request.head.sha` [11]. T-769 and T-776 own what that means for the attestation.

## Who can write a check run or a commit status

### The two kinds of check

GitHub has check runs and commit statuses. Either kind can be a required check [1] [3]. Workflow jobs produce check runs, never commit statuses [1].

| Credential | Create a check run | Create a commit status | Source |
| --- | --- | --- | --- |
| GitHub App installation token with `checks: write` or `statuses: write` | Yes | Yes | [12] [14] [15] |
| GitHub App user access token | Yes, within what both the user and the app may do | Yes | [15] [33] |
| Workflow `GITHUB_TOKEN` with `checks: write` or `statuses: write` | Yes | Yes | [7] |
| OAuth app token | No | Yes, with the `repo:status` or `repo` scope | [12] [13] |
| Personal access token, classic | No | Yes, with push access | [12] [13] |
| Personal access token, fine-grained | No. The permission list has no Checks entry. | Yes, with the Commit statuses permission | [16] |

### Who can forge what

The baseline rule is blunt. "Any person or integration with write permissions to a repository can set the state of any status check in the repository" [3]. A required check that accepts "any source" is therefore only as strong as the list of people with push access. Any of them can post a commit status with the required name through the API [13].

Branch protection and rulesets can pin a required check to one GitHub App. If anyone else sets it, GitHub refuses the merge and says the check "was not set by the expected GitHub App" [2] [3] [4]. The REST API takes the app's id directly, as `app_id` on a branch protection rule and `integration_id` on a ruleset rule [35] [36]. In the settings page the app must have set that check recently before it can be chosen, and a ruleset also wants the app installed with `statuses: write` [3] [4]. The troubleshooting page adds that a required check must have completed successfully in the repository during the past seven days [2].

That leaves two sources worth comparing.

A check pinned to GitHub Actions. The `GITHUB_TOKEN` is an installation token of the GitHub App that GitHub installs when Actions is enabled, and its reach is the one repository [17]. So every workflow in the repository writes as that same app. My reading, not stated in the docs: a workflow on any branch that holds `checks: write` can create a check run with the required name for any commit SHA, and the pin to GitHub Actions cannot tell it from the real test job. Add the fact that a pull request runs its own copy of the workflow file [18], and the result is that a person with push access can make an Actions-authored check pass without running tests. This is true of every Actions-based required check today. Vouch does not make it worse.

A check pinned to Vouch's own GitHub App. Only a holder of the app's private key can mint its installation tokens [32]. No collaborator and no workflow in the customer's repository can write that check. The cost is that Vouch's service becomes the one party that can mark a commit as tested, which the map already lists as an open risk.

One GitHub plan feature narrows the first hole. Organization and enterprise rulesets on GitHub Enterprise Cloud can require a workflow to pass, and the ruleset names the repository that holds the workflow file [37]. The same section is missing from the page for other plans [4], so Vouch cannot assume it.

## The OIDC token

### What it is

A job that has `permissions: id-token: write` can ask GitHub's OIDC provider for a JSON Web Token. The permission lets the job fetch the token and grants no write access to anything else [19]. Each job gets its own token [20]. An action requests it with `core.getIDToken(audience)` from the Actions toolkit, or with a plain HTTP call using two environment variables on the runner [19] [39].

### Claims

The claims that matter to Vouch, from the reference and the provider's discovery document [19] [21]:

| Claim | Meaning |
| --- | --- |
| `iss` | `https://token.actions.githubusercontent.com` |
| `aud` | The repository owner's URL by default. The caller can set its own value. |
| `sub` | A string built from the repository and the ref, the environment or the word `pull_request`. Repositories created after 2026-07-15 use a form with owner and repository ids. |
| `repository`, `repository_id`, `repository_owner`, `repository_owner_id` | The repository the workflow runs in and its owner. GitHub calls the two ids immutable. |
| `repository_visibility` | `public`, `private` or `internal`. |
| `ref`, `ref_type` | The git ref that triggered the run. |
| `sha` | Listed in the discovery document and shown in the example token. The claims table in the reference leaves it out. |
| `head_ref`, `base_ref` | Source and target branch names of a pull request. |
| `event_name` | The trigger, such as `pull_request`. |
| `workflow`, `workflow_ref`, `workflow_sha` | The workflow's name, its file path with ref, and the commit of that file. |
| `job_workflow_ref`, `job_workflow_sha` | The reusable workflow the job belongs to, if any. |
| `actor`, `actor_id` | The account that started the run. |
| `run_id`, `run_attempt`, `check_run_id` | The run, the attempt and the check run of the current job. |
| `runner_environment` | `github-hosted` or `self-hosted`. |
| `jti`, `iat`, `nbf`, `exp` | Token id and validity window. |

Two limits follow from the table. The token carries no claim with the pull request's head commit, only branch names. And on `pull_request` the `sha` claim should be the merge commit, because that is `GITHUB_SHA` for the event [11]. The docs do not define the `sha` claim, so treat that as unconfirmed. Either way the token alone cannot prove which head commit a pull request workflow is building. The service has to check the head SHA another way, for example by reading the pull request through the app's installation. On `push` the gap does not exist, because `GITHUB_SHA` is the tip commit of the push [11].

### How a third-party service verifies it

GitHub documents the cloud-provider case, where the provider validates the token's claims against a stored trust rule [20]. For a service like Vouch the steps come from the OpenID Connect standard [22]:

1. Fetch the signing keys from the `jwks_uri` in the discovery document, `https://token.actions.githubusercontent.com/.well-known/jwks`. The only signing algorithm is RS256 [21].
2. Verify the signature, then check that `iss` is GitHub's issuer and that `exp` and `nbf` are in range [22].
3. Check that `aud` is the value Vouch's action asked for. A token minted for another service then fails here [19] [22].
4. Apply Vouch's own rule to the claims. GitHub tells providers they must set at least one condition, or any repository on GitHub can get a token that passes [19]. For Vouch the condition is that `repository_id` belongs to an installation.

The example token in the docs is valid for five minutes [20]. The docs do not state the lifetime as a rule, so unconfirmed.

Enterprise accounts can differ. A GitHub Enterprise Cloud admin can switch the issuer to `https://token.actions.githubusercontent.com/<enterpriseSlug>`, and enterprises on GHE.com use a different host [24]. A service that hard-codes one issuer rejects those customers.

### Does it remove the stored secret?

Yes, for runs inside the repository. The job proves its repository, workflow and run with a token GitHub signs for that job, and the customer stores nothing [19] [20]. What the token proves is narrow. It says the request came from a job in that repository. It does not say the job ran the tests. It is also a bearer token that any step in the job can request from the runner's environment [19].

A reusable workflow adds one useful claim. When the job runs inside a reusable workflow, `job_workflow_ref` names that workflow and its ref, while the other claims describe the caller [23]. If Vouch ships its gate as a reusable workflow, the service can tell that the request came from Vouch's own workflow at a known ref and not from an edited copy.

## What changes for forks and Dependabot

| | Same-repository pull request | Fork pull request | Dependabot pull request |
| --- | --- | --- | --- |
| `GITHUB_TOKEN` | The repository default, changed by `permissions` | Read-only. GitHub turns every write permission into read [7] [11]. | Read-only by default. The `permissions` key can raise it [7] [27]. |
| Secrets | Available | None except `GITHUB_TOKEN` [11] | Only Dependabot secrets [27] |
| OIDC token | Available with `id-token: write` [19] | Not available. See below. | Unconfirmed. See below. |
| Workflow start | Automatic | Can wait for a maintainer's approval [25] [26] | GitHub treats the run as if it came from a fork [11] [27]. |

Fork pull requests. `id-token` has two levels, `write` and `none`, and a fork run loses every write permission, so the job cannot request the token [7]. GitHub's docs never say this in one sentence. The PyPI publishing action does, in the error it prints for this case: GitHub "doesn't give these workflows OIDC permissions, even if `id-token: write` is explicitly configured" [28]. Private repositories have a setting named "Send write tokens to workflows from pull requests" that lifts the downgrade [7] [25]. Vouch should not depend on a customer turning it on.

`pull_request_target` is the other way to reach a fork pull request with a write token and secrets. It runs the workflow from the default branch, and it is dangerous as soon as the job checks out or runs code from the pull request [11] [18]. A test job has to run that code. So `pull_request_target` cannot host the tests, and Vouch gains nothing from it for the skip decision.

Dependabot pull requests. The branch is in the same repository, but GitHub applies the fork rules to the run [11] [27]. Since 2021 these runs respect the `permissions` key [38], and the docs name no permission it cannot raise [27]. Whether that includes `id-token: write` is unconfirmed. I found no GitHub page that says yes or no. Dependabot's own update jobs do get OIDC tokens, with `event_name` set to `dynamic`, but that is a different job from a workflow triggered by its pull request [19].

For Vouch the practical answer is the same in both columns. No developer or agent ran the tests locally for a Dependabot commit, so no attestation exists and the workflow runs its normal test job. The action must treat a missing OIDC token as "no attestation" and never as an error that fails the job.

A check run written by Vouch's GitHub App does not depend on any of this, because the app uses its own token. One doc note to keep in mind: the Checks API does not detect pushes to a fork, and returns an empty `pull_requests` list for them [12]. Unconfirmed: that the app can still create a check run in the base repository for a fork pull request's head SHA.

## GitHub App or OAuth app

| Need | GitHub App | OAuth app |
| --- | --- | --- |
| Sign-in with GitHub | Yes. A GitHub App issues user access tokens through the same OAuth web flow, and through the device flow for a machine with no browser [31] [33]. | Yes [29] |
| Repository access by installation | Yes. The owner installs the app on an account and picks the repositories. The app gets a webhook when that changes [29]. | No. A token reaches everything the authorizing user can reach [29]. |
| Narrow permissions | Yes. The app asks only for what it needs, and it can hold a permission such as commit statuses without access to code [29] [30]. | No. Issues, pull requests and anything else owned by a repository need the broad `repo` scope [29]. |
| Write check runs | Yes, with `checks: write` [12] [15] | No. "OAuth apps and authenticated users are not able to create a check suite" [12]. |
| Act with no user present | Yes. An installation token comes from the app's private key and lasts one hour [29] [32]. | No. Every token belongs to a user [30]. |
| Read access that follows GitHub's repository permissions | Yes. A user access token only reaches what both the user and the app can reach [33]. | Yes, through the user's own access [29] |

A GitHub App is the answer. It is the only option that can write check runs, GitHub recommends it over OAuth apps in general [29] [30], and its user access token already gives the dashboard rule from the map, where access to a repository's results follows GitHub's repository permissions.

Two details for T-778. The device flow needs no browser on the machine that runs the library, but a person still has to enter a code on another device [33]. A sandbox that runs with nobody watching needs something else. User access tokens expire after eight hours by default and come with a refresh token that lasts six months [33].

## What Vouch's action can build on

### Option A: the workflow gates itself

A `verify` step or job calls the action. The action gets an OIDC token, asks the service about the commit, and sets an output. The test job, or its steps, read the output. The required check stays the customer's existing test job.

This rests on three documented behaviors. Skipped jobs pass [1] [6], a job can read the outputs of a job it `needs` [7] [9], and a job can get an OIDC token [19]. It needs no app permission on checks. Its trust is the same as any Actions-based required check today, including the forgery path described above.

Rules the action's docs must state:

- The test job's `if` starts with `!cancelled()` [2] [8].
- No path filter and no `[skip ci]` handling on the workflow that owns the required check [2] [10].
- A missing OIDC token, a service error and a timeout all mean "run the tests".
- The job name of the required check is unique across workflows [3].
- Add `merge_group` to the triggers if the repository uses a merge queue [2] [11].

### Option B: Vouch's app owns the required check

Vouch's GitHub App writes a check run named for Vouch on the head commit. Branch protection requires that check from that app [3] [4]. The app passes it when a valid attestation exists. When none exists, the workflow runs the tests and the app copies the test job's result, which it can learn from the `check_run` or `workflow_job` webhook [34].

This closes the forgery path for people and workflows inside the repository. It also works when the workflow never starts, and it is the one design where the trigger restriction on workflow-job checks does not apply [2]. It costs more. The app needs `checks: write`, the service must be up for anything to merge, and the fork case rests on an unconfirmed point.

A pull request can still weaken the test command or the workflow in both options. That matches the bar in the map, where the reviewer catches such a change in the diff.

### My read

Start the spec from option A, because it is small and no worse than what customers have. Decide option B in the trust model ticket, T-775. The one thing A cannot give is a check that push access alone cannot fake, and the map's adversary list has to say whether that matters for v1.

## Unsafe or unavailable

- A plain `if` on a job that `needs` the verification job. A failed verification skips the tests and the check passes [2] [7].
- Skipping at the workflow level. The required check stays pending [2] [10].
- A required check with "any source". Anyone with push access can set it [3].
- A commit status written from the workflow as the required check. Anyone with push access can write the same status [3] [13].
- An OAuth app for the service. It cannot create check runs [12].
- Stored secrets or OIDC on fork pull requests. Neither exists there [11] [28].
- `pull_request_target` for anything that runs the pull request's code [18].
- Trusting the token's `sha` as the pull request head. On `pull_request`, `GITHUB_SHA` is the merge commit [11].
- A checks-producing workflow started by `workflow_dispatch` or `workflow_run`. Its jobs do not satisfy a required check on the pull request [2].

## Unconfirmed, needs a live test

1. Whether a workflow triggered by a Dependabot pull request can get an OIDC token when it sets `id-token: write`.
2. The exact value of the `sha` claim on `pull_request` and `merge_group` events.
3. The lifetime of the OIDC token.
4. How a skipped matrix job reports its checks.
5. Whether a check run created through the API with `GITHUB_TOKEN` satisfies a required check pinned to GitHub Actions.
6. Whether a GitHub App can create a check run in the base repository for a fork pull request's head SHA.

The ticket was reading only, so I ran none of these.

## Sources

All read on 2026-11-14.

1. Status checks. https://docs.github.com/en/pull-requests/reference/status-checks
2. Troubleshooting required status checks. https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks
3. About protected branches. https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches
4. Available rules for rulesets. https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets
5. Troubleshooting rules. https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/troubleshooting-rules
6. Using conditions to control job execution. https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-jobs-with-conditions
7. Workflow syntax for GitHub Actions. https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax
8. Evaluate expressions in workflows and actions. https://docs.github.com/en/actions/reference/workflows-and-actions/expressions
9. Contexts reference. https://docs.github.com/en/actions/reference/workflows-and-actions/contexts
10. Skipping workflow runs. https://docs.github.com/en/actions/how-tos/manage-workflow-runs/skip-workflow-runs
11. Events that trigger workflows. https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows
12. REST API endpoints for check runs. https://docs.github.com/en/rest/checks/runs
13. REST API endpoints for commit statuses. https://docs.github.com/en/rest/commits/statuses
14. Using the REST API to interact with checks. https://docs.github.com/en/rest/guides/using-the-rest-api-to-interact-with-checks
15. Permissions required for GitHub Apps. https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps
16. Permissions required for fine-grained personal access tokens. https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens
17. GITHUB_TOKEN. https://docs.github.com/en/actions/concepts/security/github_token
18. Securely using pull_request_target. https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target
19. OpenID Connect reference. https://docs.github.com/en/actions/reference/security/oidc
20. OpenID Connect. https://docs.github.com/en/actions/concepts/security/openid-connect
21. GitHub's OIDC discovery document. https://token.actions.githubusercontent.com/.well-known/openid-configuration
22. OpenID Connect Core 1.0, section 3.1.3.7, ID Token Validation. https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation
23. Using OpenID Connect with reusable workflows. https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-with-reusable-workflows
24. OpenID Connect reference, GitHub Enterprise Cloud version. https://docs.github.com/en/enterprise-cloud@latest/actions/reference/security/oidc
25. Managing GitHub Actions settings for a repository. https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository
26. Approving workflow runs from forks. https://docs.github.com/en/actions/how-tos/manage-workflow-runs/approve-runs-from-forks
27. Troubleshooting Dependabot on GitHub Actions. https://docs.github.com/en/code-security/reference/supply-chain-security/troubleshoot-dependabot/dependabot-on-actions
28. pypa/gh-action-pypi-publish, `oidc-exchange.py`. Not a GitHub source. https://github.com/pypa/gh-action-pypi-publish/blob/unstable/v1/oidc-exchange.py
29. Differences between GitHub Apps and OAuth apps. https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps
30. Deciding when to build a GitHub App. https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/deciding-when-to-build-a-github-app
31. About creating GitHub Apps. https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/about-creating-github-apps
32. About authentication with a GitHub App. https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/about-authentication-with-a-github-app
33. Generating a user access token for a GitHub App. https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app
34. Webhook events and payloads. https://docs.github.com/en/webhooks/webhook-events-and-payloads
35. REST API endpoints for protected branches. https://docs.github.com/en/rest/branches/branch-protection
36. REST API endpoints for rules. https://docs.github.com/en/rest/repos/rules
37. Available rules for rulesets, GitHub Enterprise Cloud version. https://docs.github.com/en/enterprise-cloud@latest/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets
38. GitHub changelog, 2021-10-06, workflows triggered by Dependabot PRs will respect the permissions key. https://github.blog/changelog/2021-10-06-github-actions-workflows-triggered-by-dependabot-prs-will-respect-permissions-key-in-workflows/
39. actions/toolkit, `@actions/core`, OIDC token. https://github.com/actions/toolkit/tree/main/packages/core#oidc-token

[1]: https://docs.github.com/en/pull-requests/reference/status-checks
[2]: https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks
[3]: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches
[4]: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets
[5]: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/troubleshooting-rules
[6]: https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-jobs-with-conditions
[7]: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax
[8]: https://docs.github.com/en/actions/reference/workflows-and-actions/expressions
[9]: https://docs.github.com/en/actions/reference/workflows-and-actions/contexts
[10]: https://docs.github.com/en/actions/how-tos/manage-workflow-runs/skip-workflow-runs
[11]: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows
[12]: https://docs.github.com/en/rest/checks/runs
[13]: https://docs.github.com/en/rest/commits/statuses
[14]: https://docs.github.com/en/rest/guides/using-the-rest-api-to-interact-with-checks
[15]: https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps
[16]: https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens
[17]: https://docs.github.com/en/actions/concepts/security/github_token
[18]: https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target
[19]: https://docs.github.com/en/actions/reference/security/oidc
[20]: https://docs.github.com/en/actions/concepts/security/openid-connect
[21]: https://token.actions.githubusercontent.com/.well-known/openid-configuration
[22]: https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation
[23]: https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-with-reusable-workflows
[24]: https://docs.github.com/en/enterprise-cloud@latest/actions/reference/security/oidc
[25]: https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository
[26]: https://docs.github.com/en/actions/how-tos/manage-workflow-runs/approve-runs-from-forks
[27]: https://docs.github.com/en/code-security/reference/supply-chain-security/troubleshoot-dependabot/dependabot-on-actions
[28]: https://github.com/pypa/gh-action-pypi-publish/blob/unstable/v1/oidc-exchange.py
[29]: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps
[30]: https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/deciding-when-to-build-a-github-app
[31]: https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/about-creating-github-apps
[32]: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/about-authentication-with-a-github-app
[33]: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app
[34]: https://docs.github.com/en/webhooks/webhook-events-and-payloads
[35]: https://docs.github.com/en/rest/branches/branch-protection
[36]: https://docs.github.com/en/rest/repos/rules
[37]: https://docs.github.com/en/enterprise-cloud@latest/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets
[38]: https://github.blog/changelog/2021-10-06-github-actions-workflows-triggered-by-dependabot-prs-will-respect-permissions-key-in-workflows/
[39]: https://github.com/actions/toolkit/tree/main/packages/core#oidc-token
