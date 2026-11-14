# Which commit GitHub tests for a pull request

Research for Fenro task T-769, part of the Vouch map T-766. I read every source on 2026-11-14. Numbers in square brackets point to the source list at the end. A claim marked "observed" comes from reading public repositories or from a scratch repository on that day, with Git 2.56.0. A claim marked "unconfirmed" has no primary source behind it yet.

"Check" in this file always means a GitHub status check. "Head" means the last commit on the pull request's branch. "Base tip" means the last commit on the branch the pull request targets.

## The question

For each event a test workflow commonly runs on, which commit and which tree does GitHub Actions check out, and can a local run ever have seen that exact tree? The ticket's journal adds a second question. The Actions OIDC token names the merge commit and never the head, so how can the service learn a head SHA it can trust?

## Short answer

1. On `pull_request`, CI builds a commit that GitHub creates, the test merge of the base tip and the head [1] [10]. No local run can have that commit's SHA. A local run can have its tree, in two cases: the head already contains the base commit GitHub merged, or the developer merged that base commit before the run.
2. On `push` to a branch, CI builds the commit the developer pushed [1]. Same SHA, same tree, no gap.
3. On `merge_group`, and on the push to the default branch that follows a merge, CI builds another commit that GitHub creates [1] [4] [13]. Same rule as `pull_request`: the SHA never matches, the tree sometimes does.
4. `pull_request_target` builds the default branch, which holds none of the pull request's code [1]. It is not a test event.
5. The merge tree can be computed locally. `git merge-tree --write-tree <base> <head>` gave the same tree as GitHub in 17 of 17 merges I compared [16] [28]. The sample has limits, listed below.
6. The service can read the head SHA from GitHub three ways with the App's installation token. The cleanest is the test merge commit itself: its second parent is the head, its first parent is the base GitHub merged, and its tree is what CI checked out [10] [20] [28]. If the attestation names a tree, the service does not need the head SHA at all.
7. "Require branches to be up to date before merging" guarantees that the head which merges already contains the base tip [10]. For that head, the tested tree, the head's tree and the tree that lands on the base branch are the same tree.

My read: match attestations on the git tree, record the commit SHA beside it for attribution, and skip only when the tree of the commit CI is building equals the attested tree. That one rule covers every event and can never skip a tree nobody tested. Its cost is that a pull request behind its base does not skip until someone updates the branch and runs the tests again.

## What CI checks out, per event

| Event | `GITHUB_SHA` | `GITHUB_REF` | Who creates the commit |
| --- | --- | --- | --- |
| `push` to a branch | Tip commit pushed to the ref [1] | The updated ref [1] | Whoever pushed |
| `pull_request` | Last merge commit on the merge branch [1] | `refs/pull/N/merge` [1] | GitHub |
| `pull_request_target` | Last commit on the default branch [1] | The default branch [1] | Whoever last updated the default branch |
| `merge_group` | SHA of the merge group [1] | Ref of the merge group [1] | GitHub's merge queue |

`actions/checkout` with no `ref` input checks out "the reference or SHA for that event" and fetches one commit [6]. Its source sets the ref to `github.context.ref` and the commit to `github.context.sha`, and for a `refs/pull/` ref it fetches that exact commit [7]. So the table above is also the table of what a default checkout step puts on disk.

### `pull_request`

GitHub keeps a merge branch for every open pull request that has no conflict, and `actions/checkout` checks it out. The docs say it plainly: "Your CI tests run against the merged result, not just the head branch alone" [1]. `GITHUB_SHA` is the merge commit on that branch. The head commit is `github.event.pull_request.head.sha` [1]. `github.event` is the webhook payload of the event [9], so `github.event.pull_request.merge_commit_sha` and `base.sha` are there too [14].

The merge commit is a test merge. Its parents are "the latest commit on the base branch and the pull request's head commit" [10] [11], and GitHub adds it to neither branch [4]. Observed on 15 pull requests: the base is always the first parent and the head the second, GitHub is the committer, and GitHub signs the commit [28]. Observed on 7 of those: when the head already contains the base tip, GitHub still creates a two-parent merge commit, and its tree equals the head's tree [28].

A pull request with a merge conflict gets no `pull_request` run at all [1].

**When GitHub recreates the test merge.** The docs name two triggers. GitHub creates the test merge when someone views the pull request and the merge button shows, and when a client gets, creates or edits the pull request through the REST API [3] [4]. Without that, "the `merge` Git refs will fall out of date until the next time someone views the pull request", and the docs warn against depending on the merge refs because they go stale without warning [3]. Until the merge is ready, the REST field `mergeable` is `null`. Once it is `true`, `merge_commit_sha` holds the test merge's SHA [4]. GraphQL exposes the same commit as `potentialMergeCommit` [5].

The docs do not say whether a `pull_request` event builds a fresh test merge against the current base tip before the run starts. Unconfirmed. Observed on two pull requests opened on 2026-11-13: GitHub created the test merge 1 and 4 seconds after the pull request, with the base tip as first parent [28].

Observed staleness: of ten open pull requests in `cli/cli`, six had a test merge whose first parent was 2 or 4 commits behind the base tip. Two REST reads of each pull request, 20 seconds apart, returned `mergeable: true` and did not rebuild them, and they were unchanged ten minutes later [28]. That differs from what [3] describes. Unconfirmed why.

**When CI runs again.** A workflow on `pull_request` runs by default for `opened`, `synchronize` and `reopened` [1]. `synchronize` means the head branch was updated [14]. None of the three fires when only the base branch moves. A re-run uses the same `GITHUB_SHA` and `GITHUB_REF` as the original event [8], so a re-run builds the old test merge even after the base moved.

So the green check on a pull request says the tests passed on the head merged with the base as it stood when the run started. The check does not track the base afterwards.

**Where the result is recorded.** Observed: the workflow run's `head_sha` in the REST API is the pull request head, its check runs sit on the head commit, and the test merge commit has no runs and no check runs [28]. The docs agree in two places. A check suite matches a pull request by head SHA and head branch [14], and required checks "must pass on the latest commit SHA" [12]. One exception matters for a GitHub App that writes its own check: if the test merge commit has a status of its own, GitHub requires that one to pass instead of the head's [12]. Vouch's App should write to the head SHA only.

### `push` to a branch

`GITHUB_SHA` is the tip commit pushed to the ref [1]. That is the developer's own commit. If the run happened on a clean checkout of it, the SHA and the tree are both identical to what CI builds. A push of several commits tests only the tip [1].

Checks from a workflow on `push` count for a pull request's required checks. `push` is on the list of events whose job checks GitHub evaluates [12].

### `pull_request_target`

`GITHUB_SHA` is the last commit on the default branch and `GITHUB_REF` is the default branch [1]. The run happens "in the context of the default branch of the base repository, rather than in the context of the merge commit", and the docs say to avoid the event "if you need to build or run code from the pull request" [1]. A default checkout puts the default branch on disk. Tests of that tree say nothing about the pull request.

A workflow can pass `ref: ${{ github.event.pull_request.head.sha }}` to check out the head. `actions/checkout` v7 refuses to do that for a fork pull request on this event unless the workflow sets `allow-unsafe-pr-checkout: true` [6]. T-768 already ruled the event out for anything that runs the pull request's code [26].

### `merge_group`

The merge queue creates temporary branches named `gh-readonly-queue/{base_branch}/...` that "contain a different `sha` from the pull request" [13]. A merge group holds the latest base branch, the changes of every pull request ahead in the queue, and this pull request's changes [13]. `GITHUB_SHA` is the SHA of the merge group [1]. The webhook payload carries `head_sha`, `head_ref`, `base_sha` as the group's parent commit, and `head_commit.tree_id` [14].

The queue recreates a group when a pull request ahead of it leaves the queue or another one jumps to the front [13]. The repository owner picks the queue's merge method: merge, rebase or squash [13].

Observed on `rust-lang/cargo`, which uses the merge method [28]:

- The group commit has the base as first parent and the pull request head as second, the same shape as a test merge.
- The group commit that passed became the tip of `master` and the pull request's `merge_commit_sha`, with the same SHA. The queue moved the base branch to the commit CI had tested.
- One pull request entered the queue twice. The two group commits had different SHAs and the same tree.

Unconfirmed: the same for the squash and rebase methods, and for a group with other pull requests ahead of it.

### Push to the default branch after a merge

After a merge, `merge_commit_sha` is the merge commit, the squashed commit, or the commit the base branch was updated to by a rebase [4]. GitHub creates all three. A rebase merge "always updates the committer information and creates new commit SHAs" [15]. So a `push` run on the default branch after a pull request merges builds a commit no laptop has seen. Its tree equals the head's tree when the head contained the base tip at merge time. Observed in a scratch repository for the merge, squash and rebase cases [28].

A direct push to the default branch, with no pull request, is the plain `push` case above.

## The gap, per event

| Event | Can a local run have the same commit SHA? | Can a local run have the same tree? | What differs when it does not |
| --- | --- | --- | --- |
| `push` to a branch | Yes | Yes, on a clean checkout of that commit | Nothing |
| `pull_request` | No. GitHub creates the commit | Yes, when the head contains the base commit GitHub merged, or the developer merged that commit before the run | Every change on the base branch between the merge base and the base commit GitHub merged |
| `pull_request_target` | Not relevant | Not relevant | CI builds the default branch, not the pull request |
| `merge_group` | No | Only when nothing is ahead in the queue and the local run already included the same base. Nobody knows the queue's content in advance | Base changes plus every pull request ahead in the queue |
| `push` to the default branch after a merge | No, unless the push is a direct push of local commits | Yes, when the head contained the base tip at merge time | Base changes since the head last took them in |

The `pull_request` gap is not small in a busy repository. In the `cli/cli` sample, 8 of 10 open pull requests had a test merge whose tree differed from the head's tree, by 113 to 1,038 files [28].

Two things are true at once, and the trust model has to hold both.

- A developer who tests the head has not tested what CI tests. CI adds the base branch's newer commits.
- CI has not tested what merges either, unless the repository forces it. The run used the base as it stood at the time of the event, and GitHub does not run it again when the base moves.

## What "Require branches to be up to date before merging" guarantees

With the setting on, called strict, "the branch must be up to date with the base branch before merging" [10] [11]. With it off, called loose, the branch does not have to be up to date, and "status checks may fail after you merge your branch if there are incompatible changes with the base branch" [10].

Strict mode starts no runs by itself. It blocks the merge until the head contains the base tip. Getting there means merging or rebasing the base into the branch [12] [25], which creates a new head commit, which fires `synchronize`, which starts a new run [1] [14]. Checks from an earlier commit do not count [12].

The guarantee follows from the shape of the test merge. When the head contains the base tip, merging the two adds nothing, so the test merge's tree is the head's tree. Observed on 7 pull requests and in the scratch repository [28]. Under strict mode, for the head that finally merges:

- the tree CI tested equals the head commit's tree, and
- the tree that lands on the base branch equals it too.

GitHub relies on the same equivalence. A pull request that is up to date and passes its checks "can be merged locally and pushed to the protected branch", and that works "without running status checks on the merge commit itself" [12].

Strict mode does not make every run meaningful. A run that starts while the head is behind the base still tests a merge tree that differs from the head. Its result cannot let the pull request merge, because the merge stays blocked until someone updates the branch.

A merge queue "provides the same benefits" without asking the author to update the branch [13]. It tests the group commit and, in the one repository I looked at, lands that exact commit [28].

## Can the merge tree be computed locally?

Yes, with one Git command, and the result matched GitHub every time I compared.

**What Git documents.** `git merge-tree --write-tree <branch1> <branch2>` performs a merge without touching the index or the working tree and prints the OID of the resulting tree. It uses the same machinery as `git merge`, including rename detection and a virtual merge base when the two commits have more than one. A clean merge exits 0 and a conflicted one exits 1 [16]. The mode arrived in Git 2.38 [17].

**What GitHub says it runs.** GitHub performs its merges with merge-ort, the strategy that is Git's default. It moved off its own libgit2-based code because users' local Git could merge what GitHub could not, and it says that when "correct" is debatable it tries to match what the Git command line does [18]. The post does not name the exact command GitHub runs for test merges.

**Live comparison.** For each commit below I fetched the GitHub-created merge commit, ran `git merge-tree --write-tree <parent 1> <parent 2>` locally, and compared the tree it printed with the commit's own tree [28].

| Repository | Commits compared | Head behind the merged base | GitHub's tree equals local `merge-tree` | Tree equals the head's tree |
| --- | --- | --- | --- | --- |
| `actions/checkout` | 5 test merges | 0 commits | 5 of 5 | 5 of 5 |
| `cli/cli` | 2 test merges | 0 commits | 2 of 2 | 2 of 2 |
| `cli/cli` | 8 test merges | 85 to 1,145 commits | 8 of 8 | 0 of 8 |
| `rust-lang/cargo` | 2 merge group commits | 10 and 185 commits | 2 of 2 | 0 of 2 |

Swapping the two arguments gave the same tree in all ten `cli/cli` cases.

**Scratch repository.** Observed with Git 2.56.0 [28]:

- For a clean three-way merge, `merge-tree` printed the same tree as the commit `git merge --no-ff` made, in either argument order.
- For a branch that contains the base tip, `merge-tree` printed the head's own tree. A no-fast-forward merge, a squash and a rebase of that branch onto the base all produced that tree too.
- For a branch behind the base, a squash onto the base and a rebase onto the base produced the same tree as the merge. Git does not promise that for every history.
- An edited tracked file and a staged new file did not change the output.
- The `.gitattributes` file on disk did change it. See the list of differences below.
- With two merge bases, `merge-tree` and `git merge` agreed.
- `git commit-tree <tree> -p <base> -p <head>` plus `git worktree add --detach` put the merged tree on disk without touching the developer's checkout. `git write-tree` in that worktree returned the same tree.

**Where a local result can differ from GitHub's.** These are the limits of the sample.

- Local Git config changes the answer. In the scratch repository, a rename on one side and an edit on the other merged cleanly by default and conflicted with `merge.renames=false`, with a different tree [28]. `merge.renames`, `merge.directoryRenames` and `merge.renameLimit` all feed the merge [29]. The library has to pin them on the command line.
- `.gitattributes` changes the answer, and `merge-tree` takes it from the checkout, not from the commits it merges. Two branches that both carried `log.txt merge=union` merged cleanly while that file was on disk and conflicted after I checked out a branch without it. `git --attr-source=<tree-ish> merge-tree` made the result independent of the checkout [28] [30] [31]. The library has to pass it. Unconfirmed: which attributes GitHub's server-side merge reads, and whether it honours `merge=union` or custom merge drivers.
- All 17 live merges had a single merge base. Unconfirmed: that GitHub and local Git agree on criss-cross histories, and on merges near the rename limit.
- Git versions differ. Unconfirmed: that an older local Git, 2.38 for example, prints the same tree as GitHub for every merge.
- The base moves. The local command needs the same base commit GitHub merged. If the base branch gets a commit between the local run and the pull request event, the trees differ.

Every one of these fails in the safe direction when the rule is "skip only on an equal tree". A wrong local tree matches nothing, and CI runs the tests.

**What it costs the library to use it.** The tests must run on the merged tree, not only hash it. That needs a `git fetch` of the base branch from the laptop or sandbox, Git 2.38 or newer, and either a second worktree with its own dependency install or a real merge into the developer's branch. Merging or rebasing the base into the branch before the run reaches the same tree with no extra machinery. The head then contains the base tip, and the head's tree is the merge tree.

## How the service can learn a head SHA it can trust

The action can read `github.event.pull_request.head.sha` on the runner and send it [1] [9]. Nothing signs that value. It is a claim from the runner, and the service must confirm it with GitHub. The OIDC token gives the service signed starting points: `repository`, `ref`, `run_id`, `check_run_id` and `sha` [22] [23]. T-768 found that the docs do not define `sha`, so its value on `pull_request` is still unconfirmed [26].

| Path | What the service gets | App permission | Weak point |
| --- | --- | --- | --- |
| `GET /repos/{owner}/{repo}/git/commits/{sha}` with the token's `sha` | The test merge's tree, its first parent as the merged base, its second parent as the head [20] [28] | Contents, read [21] | Rests on the token's `sha` being the merge commit. Contents read lets the service read the customer's source |
| `GET /repos/{owner}/{repo}/actions/runs/{run_id}` with the token's `run_id` | `head_sha`, `head_commit.tree_id`, `event`, `pull_requests[].head.sha` [19] | Actions, read [21] | The docs list `head_sha` without defining it. Observed as the pull request head [28]. Gives the head's tree, not the merge tree |
| `GET /repos/{owner}/{repo}/pulls/{number}` with the number from the token's `ref` | `head.sha`, `merge_commit_sha`, `mergeable` [4] | Pull requests, read [21] | The head can move after the run started. Compare `merge_commit_sha` with the token's `sha` and refuse on a mismatch |
| GraphQL `PullRequest` | `headRefOid`, `baseRefOid`, `potentialMergeCommit` [5] | Not looked up | Same race as the REST read |
| Webhooks to the App: `pull_request`, `check_suite`, `workflow_run`, `merge_group` | Every head SHA as it appears, `before` and `after` on `synchronize`, `head_commit.tree_id` on merge groups [14] | Pull requests, Checks, Actions or Merge queues, read [14] | The service must be up to receive them. GitHub signs each delivery with the webhook secret [24] |

Three notes on the table.

- A commit object never changes, so the first path has no race. It also returns the one value the other paths lack, the tree CI checked out.
- Observed: the REST field `base.sha` on a pull request lagged both the base tip and the first parent of the test merge [28]. Do not treat it as the base CI merged. Read the first parent of the merge commit instead.
- Observed: a run for a fork pull request has an empty `pull_requests` list [28]. Fork pull requests get no OIDC token and run normal CI anyway [26].

The service cannot recompute the merge. It holds no clone. It can read GitHub's result, which is better than recomputing it.

## Ways to close the gap

| # | Way | What it does | Cost |
| --- | --- | --- | --- |
| 1 | Match on the tree | The service reads the tree of the commit CI is building and skips only when an attestation names that tree | The App needs Contents read, or the action reports the tree from the runner as an unsigned claim. A pull request behind its base never skips. In the `cli/cli` sample that was 8 of 10 [28] |
| 2 | Test the merge result locally | Before the run, the library merges or rebases the base into the branch, or builds the merge tree in a second worktree | A fetch from the laptop or sandbox, Git 2.38 or newer, pinned merge config and attribute source. A miss whenever the base moves before the pull request event. The miss costs one normal CI run |
| 3 | Accept a head attestation whatever the base | Skip when the attested commit is the pull request head. WooCommerce does this and flags sampled runs where the base moved [27] | The pull request check no longer covers the merge result. A break caused by newer base commits passes. Needs tests that always run on the default branch or the merge queue to catch it afterwards |
| 4 | Make CI test the head | The workflow checks out `github.event.pull_request.head.sha` [6], or runs its tests on `push` [1] | The customer gives up merge-result testing for every pull request, attested or not. On `push` the token's `sha` is the head, so the trusted-head problem goes away |
| 5 | Strict mode | The merge waits until the head contains the base tip [10] | A repository setting the customer must turn on. Each branch update makes a new head, which needs a new run. The docs warn of more builds [10] |
| 6 | Merge queue, always tested | The queue tests the commit that lands [13] | The tests run in CI once per merged pull request. Vouch saves only the runs on pull request events |

Ways 1 and 2 belong together, and they keep the map's bar intact: a pass counts when CI would have passed on the same tree. Way 5 or 6 removes most of way 1's cost at merge time, because the head that merges is up to date by rule. Way 3 buys the most skips and gives up the bar on pull requests. Way 4 changes what the customer's CI means, which is a lot to ask of a tool that promises the same result as CI.

Agents make way 2 cheap. An agent that rebases onto the base and runs the tests before every push produces a head whose tree is the merge tree, as long as the base does not move in the seconds before the push.

## What this says to the two open questions from the prior-art research

**Commit SHA or git tree as the attested subject.** The tree. On `pull_request`, on `merge_group` and on the push after a merge, GitHub creates the commit CI builds [1] [4] [13]. A SHA made on a laptop can never equal it. The tree is the only identity a local run and CI can share on those events, and in the 17 merges I compared it was computable locally [28]. Recording both costs nothing. The tree decides the match, and the commit SHA says which commit the developer had checked out, which the audit trail and the sampled re-runs need.

A tree match also removes the trusted-head problem. The service needs the tree of the token's `sha` and nothing about the head.

One caution. A tree covers file names, modes and content. It does not cover the commit message or the history. A test command that picks its tests from history, for example "only what changed since `main`", can give different results on two commits with the same tree. That belongs to the run-record and environment tickets.

**Attestations on pull request events only.** With a commit SHA as the subject, the question answers itself: the SHA matches on `push` to a branch and nowhere else. With a tree as the subject, an attestation can match on a merge group or on the default branch, exactly when the tree is the one somebody tested. Whether to accept that match is a trust decision for T-775, not a technical limit. Two facts for it. Where a merge queue runs, the queue already tests the commit that lands [13] [28], so always running tests there costs one run per merged pull request. And if way 3 is ever allowed, always-tested default branch or queue runs are the only thing that catches a broken merge result.

## Unconfirmed

1. The value of the OIDC `sha` claim on `pull_request`. T-768 listed it, and T-787 owns the live test [26].
2. Whether a `pull_request` event always builds a fresh test merge against the current base tip before the run starts. Seen fresh on two new pull requests only.
3. Why REST reads did not rebuild six stale test merges, against what [3] describes.
4. The meaning of `head_sha` on a workflow run. The docs list the field without defining it. Observed as the pull request head on `pull_request` and `pull_request_target` runs.
5. That GitHub and local Git agree on merges with several merge bases, with `merge=union` or custom merge drivers in `.gitattributes`, near the rename limit, and across Git versions. Which commit's `.gitattributes` GitHub reads for a test merge.
6. The shape and tree of a merge group commit under the squash and rebase methods, and with pull requests ahead in the queue. Whether the queue always lands the tested commit with the same SHA. Seen on one repository with the merge method.
7. The exact meaning of `base.sha` on a pull request in the REST API.

## Questions for the map

1. Does the App ask for Contents read? The tree-match rule wants the Git commits endpoint. The alternative is a tree reported by the action from the runner, which nothing signs. This touches the trust model and the App's permission list.
2. What does the library do when the branch is behind its base: refuse, warn and attest the head tree anyway, or merge the base for the run?
3. Does the setup guide require strict mode or a merge queue, or only recommend one?
4. Test commands that select tests from Git history break the idea that the tree identifies what ran. The run-record ticket should decide whether a run records the command's history inputs or refuses such commands.
5. GitHub's "Update branch" button creates a head commit no laptop has seen [25]. With a tree match it still skips if someone tested that merged tree beforehand. Worth one line in the action contract.
6. T-787 could add three live tests from the list above: items 2, 5 for `merge=union`, and 6.

## How I checked

- Docs: fetched each page as Markdown from `https://docs.github.com/api/article/body?pathname=<path>` and the webhook schemas from `https://docs.github.com/api/webhooks/v1?category=<event>`, then read the passages cited.
- Test merges: `git fetch` of `refs/pull/N/head` and `refs/pull/N/merge` from three public repositories into bare scratch repositories under `/tmp`, then `git merge-tree --write-tree <merge>^1 <merge>^2` against `<merge>^{tree}`.
- Runs and commits: read-only `gh api` calls to `repos/{owner}/{repo}/pulls/{n}`, `actions/runs`, `commits/{sha}/check-runs` and `git/commits/{sha}` on the same public repositories.
- Scratch repository: nine small cases with Git 2.56.0 on macOS. Clean merge, up-to-date branch, squash and rebase, dirty working tree, worktree from a merge tree, conflict, rename with and without rename detection, `merge=union` with and without the attributes file on disk, two merge bases.

I created no repositories, pull requests or workflows, and ran no workflow.

## Sources

All read on 2026-11-14.

1. Events that trigger workflows. https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows
2. Pull requests, refs and merge branches. https://docs.github.com/en/pull-requests/reference/pull-requests#pull-request-refs-and-merge-branches
3. Using the REST API to interact with your Git database, checking mergeability of pull requests. https://docs.github.com/en/rest/guides/using-the-rest-api-to-interact-with-your-git-database#checking-mergeability-of-pull-requests
4. REST API endpoints for pull requests. https://docs.github.com/en/rest/pulls/pulls
5. GraphQL reference, pull requests. https://docs.github.com/en/graphql/reference/pulls
6. actions/checkout README, v7. https://github.com/actions/checkout/blob/main/README.md
7. actions/checkout source. https://github.com/actions/checkout/blob/main/src/input-helper.ts and https://github.com/actions/checkout/blob/main/src/ref-helper.ts
8. Re-running workflows and jobs. https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs
9. Contexts reference. https://docs.github.com/en/actions/reference/workflows-and-actions/contexts
10. About protected branches. https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches
11. Available rules for rulesets. https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets
12. Troubleshooting required status checks. https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks
13. Managing a merge queue. https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue
14. Webhook events and payloads: `pull_request`, `check_suite`, `workflow_run`, `merge_group`, `push`. https://docs.github.com/en/webhooks/webhook-events-and-payloads
15. Pull request merges. https://docs.github.com/en/pull-requests/reference/pull-request-merges
16. git-merge-tree. https://git-scm.com/docs/git-merge-tree
17. Git 2.38 release notes. https://github.com/git/git/blob/master/Documentation/RelNotes/2.38.0.adoc
18. Scaling merge-ort across GitHub, GitHub engineering blog, 2023-07-27. https://github.blog/engineering/infrastructure/scaling-merge-ort-across-github/
19. REST API endpoints for workflow runs. https://docs.github.com/en/rest/actions/workflow-runs
20. REST API endpoints for Git commits. https://docs.github.com/en/rest/git/commits
21. Permissions required for GitHub Apps. https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps
22. OpenID Connect reference. https://docs.github.com/en/actions/reference/security/oidc
23. OpenID Connect, example token. https://docs.github.com/en/actions/concepts/security/openid-connect
24. Validating webhook deliveries. https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
25. Keeping your pull request in sync with the base branch. https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/keeping-your-pull-request-in-sync-with-the-base-branch
26. T-768 findings, how a GitHub workflow can skip its test job safely. https://github.com/Daniel88dev/vouch/blob/research/ci-skip-mechanics/docs/research/ci-skip-mechanics.md
27. T-767 findings, prior art for trusting local test runs. https://github.com/Daniel88dev/vouch/blob/research/prior-art/docs/research/prior-art.md
28. Own observations on 2026-11-14. Test merges of https://github.com/actions/checkout pull requests 2578, 2548, 2599, 2590 and 2571. Test merges of https://github.com/cli/cli pull requests 15052, 15049, 14846, 14783, 14781, 14679, 14259, 14044, 13665 and 13899, with workflow runs 43458279601 and 40619509584. Merge group commits `382ecb8707`, `35420f1c78` and `790778c398` of https://github.com/rust-lang/cargo for pull requests 17732 and 17518. Scratch repository under `/tmp` with Git 2.56.0.
29. git-merge, configuration. https://git-scm.com/docs/git-merge
30. gitattributes, performing a three-way merge. https://git-scm.com/docs/gitattributes#_performing_a_three_way_merge
31. git, the `--attr-source` option. https://git-scm.com/docs/git
