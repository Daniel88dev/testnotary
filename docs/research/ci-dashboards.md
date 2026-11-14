# What test and CI dashboards show today

Research for Fenro task T-772, part of the Vouch map T-766. I read every source on 2026-11-14. Numbers in square brackets point to the source list at the end. I read vendor documentation and product pages only. I did not sign in to any product, so every description below is what the vendor's docs say the screen shows, not what I saw on a live screen. A claim marked "unconfirmed" has no primary source behind it yet. A section marked "proposal" is my own reasoning from the map and the closed research, not something a source states.

In this file "run", "attestation" and "verification" carry their glossary meanings. The other products use "run" for a CI execution, so I write "CI run" for theirs. "Audit" means the CI re-run of a sampled attested commit, as in the map.

## The question

What do existing test-result and CI-insight products put on screen, and which of those views would a team using Vouch need or expect? What does each product need from the test runner? And what can only Vouch show?

## Short answer

1. The products split into two groups by the data they need. Nx Cloud, Datadog's pipeline product and GitHub's own Actions metrics work from the status and duration of a task or a job, with no report file [1] [26] [40]. Trunk, BuildPulse, Codecov, Currents and Datadog's test product need a result per test, and JUnit XML is the format all five accept [8] [15] [22] [28] [36].
2. Every dashboard leads with the cost of a problem. The top numbers are flaky test counts, failure rates, pull requests or pipelines hit, and CI time lost [1] [7] [13] [19] [31]. Only Datadog and Nx Cloud show time saved, and only for their own features [3] [19] [24].
3. Flaky tests, slowest tests, per-test failure rate, top errors and a pull request comment that names the failing test all need per-test data. A feed of CI runs, a pass rate, a duration trend, time lost and flakiness at the level of a whole task do not.
4. Vouch's own data is at the second level. A run gives an exit code, a duration, a tree, an identity and a machine. That is enough for every view only Vouch can show. I rank eight views that need no per-test data ahead of the one that does.
5. GitHub's usage metrics leave out skipped runs [40]. So the minutes Vouch saves disappear from GitHub's totals, and no product in this file reports them. That number belongs to Vouch alone, but it needs a baseline that the map has not specified yet.
6. Skipping the test job also skips whatever that job uploads. Every per-test product here sends its data from the CI job that ran the tests, in a step after them or from inside the test process [8] [16] [22] [28] [36]. A team that already uses one of them loses pull request data on every skipped commit. This is a new question for the map.

## Two groups of product

| Product | Unit it reports on | What it needs from the test runner | How the data arrives |
| --- | --- | --- | --- |
| Nx Cloud | Task, such as `my-app:test` | Nothing. It uses the task's input hash, exit status, duration and cache result [1] [4] | The Nx CLI reports each task [1] |
| Datadog CI Pipeline Visibility | Pipeline, job, step | Nothing [26] | A GitHub App with read access to Actions [26] |
| GitHub Actions metrics | Workflow, job, repository | Nothing [40] | GitHub's own records [40] |
| Trunk Flaky Tests | Test case | JUnit XML, Bazel BEP JSON or Xcode `.xcresult` [10] | `trunk-analytics-cli upload`, or `test` to wrap the command [10] |
| BuildPulse | Test case | JUnit XML [15] | `buildpulse/buildpulse-action`, upload or wrap mode [16] |
| Codecov Test Analytics | Test case | JUnit XML only [28] | `codecov/test-results-action` or `codecovcli` [28] |
| Currents | Test case, spec file | Its own reporter for Playwright, Cypress, Jest and `node:test`. JUnit XML for the rest [36] [39] | Reporter during the test, or `currents run upload` after it [36] |
| Datadog Test Optimization | Test case | A Datadog library inside the test process, or JUnit XML [18] [22] | The library, or `datadog-ci junit upload` [22] |

## Product by product

### Nx Cloud

Nx Cloud is the closest in data to Vouch. It never sees a single test. It sees tasks.

**Flaky task analytics.** Nx hashes a task's inputs on every execution. A task that fails and later succeeds with the same hash is flaky. The flag sits on the whole task, such as one Jest project or one Playwright spec file, and drops off after two weeks without an incident [1]. The page leads with three numbers for a 7-day or 30-day range: active flaky tasks, average flake rate weighted by volume, and high-risk tasks with a flake rate above 20 percent [1] [2]. A chart plots tasks by impact, which is flake rate times sample size. The table lists task, flake rate, total reruns, time wasted and last failure. Time wasted is reruns times average task duration [1]. A row opens a detail view with three tabs. Overview holds the rates and the count of automatic retries. Activity is a timeline of failed and successful executions with links to the CI runs. Environments shows where the task ran, so the user can see whether one environment causes the failures [1]. The view is for Enterprise workspaces [1] [2].

**Task analytics.** A table of every task that ran in the range, with average and maximum duration, cache rate, pass and fail percentages and a sparkline of average duration. Filters are time range, project and target. The user sorts to find the slowest or least cached tasks [2].

**CI pipeline executions.** A list of CI runs, one per CI pipeline invocation, with committer and commit message, sortable by duration [3].

**Time saved.** The release notes name an analytics screen with the trend of CI pipeline duration, the daily count of CI pipelines and the average daily time that distributed execution saved. They also name a "Time saved" page with a cache usage download, and "Time to Green" reports that compare hypothetical with observed savings [3]. Unconfirmed: what the Time saved page shows today and how Nx computes the figure. I found no docs page for it, only release notes.

**On the pull request.** Results appear as a status on the pull request, one per pipeline file [5].

The product page leads with pipeline speed and compute, a claim of a pipeline nine times faster on half the compute, and describes no dashboard [6].

The public API returns the same shape of data. Daily task statistics carry a count, cache hit ratios, average duration per cache outcome, and the ratio of zero to non-zero exit codes [4].

What the user does from these views: rank tasks by impact, open one, and compare the logs of a failed and a successful attempt [1].

### Trunk Flaky Tests

**Collections list.** One row per test collection, with tests tracked over 60 days, flaky and broken counts with a 10-day sparkline, CI runs per day, and the number of setup steps completed [7].

**Collection overview.** A 7-day or 30-day toggle sits above three cards: flaky tests, broken tests and pull requests impacted. Each count comes with its share of the total. Daily charts show new test cases, status changes split into newly flaky, newly broken and recovered, and CI runs of quarantined tests. Three top-10 tables follow: most unstable tests, longest-running tests and longest manually quarantined tests. Branch, code owner and repository filter the tables [7].

**Tests table.** Every test with status of Healthy, Flaky or Broken, failure rate, pull requests impacted and last run. The default sort is pull requests impacted [7].

**Test detail.** A summary tab groups past failures by failure type, which Trunk derives from the stack trace. A history tab lists every execution of the test with duration, pull request, branch and commit, and filters by result, SHA and branch. From here the user opens the CI job log or creates a ticket [7].

**On the pull request.** A comment lists the tests in five groups: passed, failed, flaked, skipped and quarantined. It posts only when a test failed [11].

**Detection.** Monitors decide a test's status. Pass-on-retry flags a test that fails and then passes on the same commit. Failure rate and failure count monitors use thresholds over a time window, set per branch type [9]. Trunk asks for uploads from pull request branches, stable branches and the merge queue, and says both pull request and stable branch uploads are needed for accurate detection [8].

**Data.** JUnit XML is the main format, with Bazel BEP JSON and Xcode results as alternatives. The CLI reads git and CODEOWNERS data itself [10]. For Vitest, Trunk requires the `file` attribute on each test case [12]. The CLI's `test` subcommand wraps the test command, records start and end times, keeps the exit code, and overrides it when every failure is quarantined [10].

### BuildPulse

**Top of the page.** Total time consumed by flaky tests, the percentage of builds not affected by flakiness, code coverage, and a bar chart of builds received. "Time consumed" is the summed duration of builds that failed because of a flaky test [13].

**Flaky tests tab.** A table of flaky tests with last seen, time consumed, disruptions, disruption frequency, a history chart and an issue link. A disruption is a pass-to-fail flip on unchanged code, or a failure under the statistical method. The default range is 14 days. The user sorts by most disruptive, quarantines a test or opens an issue [13].

**Other tabs.** Metrics has charts of flaky tests, disruptions and time consumed. Builds lists the builds received, grouped by build URL. Tests lists every test case, sortable by duration and failure rate. Code coverage shows coverage by file and directory [13].

**Detection.** The git-based method flags a test that both passed and failed on unchanged code, and it compares git tree SHAs to decide what "unchanged" means. The statistical method uses a failure-rate threshold [13].

**Data.** JUnit XML [15]. The GitHub Action uploads it. Its wrap mode takes a `command` input, runs the tests itself, samples CPU and memory each second, and returns the command's exit code as an output [16].

The product page says BuildPulse ranks flaky tests by engineering hours lost, CI minutes wasted and pull requests blocked [17]. The getting-started page adds the number of tests run, time spent testing and disruptions found and fixed, with trends over time [14]. Unconfirmed: the charts on the Metrics tab and the test detail page. The docs do not describe them.

### Datadog

Datadog sells two products that this ticket groups together, and they need different data.

**CI Pipeline Visibility.** The pipeline list shows each pipeline's default branch with build frequency, failure rate, median duration and the change in median duration, plus the result and duration of the last build [27]. A pipeline's page shows total and failed executions over time, duration percentiles, and tables of stages and jobs that sort by duration, share of total time or failure rate. An execution opens as a flame graph, and a checkbox marks the critical path, the chain of jobs that sets the pipeline's total duration [27]. For GitHub Actions the data comes from a GitHub App with read access to Actions. A workflow run maps to a pipeline, and jobs and steps map directly. Datadog's feature table for GitHub Actions lists step granularity, queue time, critical path and log analysis [25] [26]. The setup page describes no change to the workflow file. Unconfirmed that none is needed, because the page does not say so outright [26].

**Test Health.** Four summary numbers: pipelines failed because of flaky tests, time wasted in CI on flaky failures, pipelines saved by automatic retries, and time saved in CI by Test Impact Analysis and automatic retries. A table behind each number splits flaky from non-flaky causes. Repositories with a recommendation show an estimate of what a feature would save, and a toggle turns the feature on from the dashboard [19]. With pipeline visibility enabled, Datadog counts failures and durations per job [19].

**Flaky Tests Management.** One row per flaky test with its state and three impact numbers: pipeline failures, CI time wasted and failure rate. States are Active, Quarantined, Disabled and Fixed. The user changes the state, opens the last failed run, creates a work item or asks for a generated fix [20]. An older table lists flaky tests per branch with average duration, first and last flaked commits, commits flaked and failure rate [21].

**Test Impact Analysis.** Datadog skips tests that a commit cannot affect and shows the time saved in purple on each test session and commit. A dashboard shows savings and adoption by repository, committer and service. A change to a tracked file runs every test, and so does a test marked unskippable [24]. The page does not explain how Datadog computes time saved. Unconfirmed.

**On the pull request.** A comment summarizes test executions, flakiness and the error messages of failed tests [23].

**Data.** Datadog recommends its own library inside the test process and says it gives more accurate timing than JUnit upload [22]. Flaky Tests Management requires the library [20]. The feature table in the docs is misaligned in its Markdown form. My reading of it is that JUnit upload lacks accurate durations, Test Impact Analysis, early flake detection and automatic retries [18]. With JUnit upload the user supplies environment tags such as OS and runtime by hand [22].

### Codecov Test Analytics

**Tests tab.** An overview of test run times and failure rates across the default branch and feature branches. The user sorts by average duration, failure rate and commits failed, and switches branch [28]. The product page and the launch post add total test suite run time, a slowest tests list, a flaky test count, a skipped tests view and a sort by flake rate [29] [30].

**On the pull request.** A comment lists the tests the pull request failed, with a stack trace. It marks the failed tests that are known to be flaky on the default branch [28].

**Data.** JUnit XML only, found by the file name pattern `*junit.xml`, uploaded with an action step that has to run even when tests fail. Codecov keeps test results for 60 days [28].

Unconfirmed: how Codecov decides a test is flaky. Neither the docs page nor the product page states the rule.

### Currents

Currents documents more views than the other five. Its own reporters cover Playwright, Cypress, Jest and the Node.js test runner [39].

**Project overview.** Six tiles, each with a sparkline and the change from the previous period: CI runs, run success rate, test pass rate, flaky rate, run duration p95 and CI time on failed runs. The default range is 14 days, with a branch filter. Charts of run status and run duration follow, then the 10 latest runs, recent pull requests, and three lists of up to five tests: most flaky, most failing and slowest. Broken tests and top errors close the page. Every list links into an explorer with the same filters [31].

**Runs and pull requests.** A run has a status, a title taken from the pull request or commit, duration, branch, commit, author and a link to the CI provider [33]. The pull requests page has one row per pull request with author, latest status, a dot per recent run and a run count. A row expands into a timeline of its runs, and a run for a commit that ran again is marked as superseded [34].

**Test explorer.** One row per test with failure rate, flakiness rate, average duration, the trend of each, and an impact figure for each. Impact is the rate or the duration times the number of executions. Presets such as Top Flaky, Getting Worse and Slowing Down set the filters [32].

**Analytics.** Charts over time for run status, run duration, run completion, run size, test results, test flakiness and suite size [39].

**On the pull request.** A commit status, and a comment that lists failed and flaky tests with how often each failed or flaked in the last 30 days [38].

**Detection.** A test is flaky when it does not pass on its first attempt and passes on a retry, so the runner must have retries on [35].

**Data.** Reporters for Playwright, Cypress, Jest and the Node.js test runner. Other frameworks convert JUnit XML with `currents run upload`. The generic format needs per-test attempts with status, duration, start time and errors [36] [37] [39]. Unconfirmed: which dashboard features a JUnit-sourced run lacks. The docs do not say.

### GitHub Actions metrics

I add GitHub because every Vouch user already has it and it owns the CI minutes figure. Organization insights have usage metrics, which show minutes by workflow, job, repository, OS and runner type, and performance metrics, which show average run time, average queue time and failure rate. The metrics leave out skipped runs and runs that use zero minutes, and they do not apply billing multipliers [40]. Unconfirmed: which plans include them.

## What the dashboards have in common

These patterns repeat across at least four of the products, so a team will expect them.

- **A row of summary numbers with a short time range.** Trunk and Nx offer 7 and 30 days, BuildPulse and Currents default to 14 [1] [7] [13] [31]. Currents and Nx show the change from the previous period beside each number [2] [31].
- **Ranked lists that say what to fix first.** The rank is impact, not raw rate. Nx multiplies flake rate by sample size, Currents multiplies rate by executions, Trunk sorts by pull requests impacted, BuildPulse by disruptions [1] [7] [13] [32].
- **Time as the unit of cost.** Time wasted, time consumed, CI time on failed runs [1] [13] [19] [31].
- **A drill-down that ends at a log.** Overview, then a list, then one item's history, then one execution with its commit, author, branch and a link to the CI job [1] [7] [27] [33].
- **A message on the pull request.** A comment or a status, so most developers never open the dashboard [5] [11] [23] [28] [38].
- **Filters by branch, with the default branch treated as the clean signal** [7] [27] [28] [31].

None of them shows who ran the tests or whether a result can be trusted. The author column names the commit author. A machine appears in two places only, Nx's Environments tab and BuildPulse's runner metrics [1] [16]. Every product assumes the result is true because CI produced it.

## Which views need per-test data

| View | Needs a result per test | Works from exit code and duration |
| --- | --- | --- |
| Flaky tests list | Yes | No |
| Slowest tests | Yes | No |
| Failure rate per test, broken tests | Yes | No |
| Top errors, failure types | Yes, with the failure message | No |
| Pull request comment that names failed tests | Yes | No |
| Quarantine | Yes, and a way to change the runner's result | No |
| Feed of CI runs with status and duration | No | Yes |
| Run success rate, duration average and p95 | No | Yes |
| CI time on failed runs | No | Yes |
| Flaky task or flaky suite, Nx's rule | No | Yes, with a hash of the inputs [1] |
| Job failure rate, queue time, critical path | No | Yes, from the CI provider [26] [27] |
| Time saved | No | Yes, with a baseline duration |

The per-test format is JUnit XML in every case [8] [15] [22] [28] [36]. The elements the products read are the test suite, the test case with `name`, `classname` and `time`, and the failure message [28]. Trunk also wants a `file` attribute [12]. Among the JavaScript runners, Vitest, Playwright and the Node.js test runner write JUnit XML with a built-in reporter [42] [44] [45]. Jest's documented example uses the separate `jest-junit` package [43].

Flaky detection needs more than one report. It needs retries inside one report, as Currents and Trunk's pass-on-retry use [9] [35]. Or it needs two results for the same code, as BuildPulse's tree SHA comparison and Nx's input hash use [1] [13]. Or it needs a failure rate over many CI runs of a stable branch [9].

## What Vouch can draw from its own data

This section is a proposal. It rests on the product description in the map and on the closed research.

A wrapped command gives the library five facts with no report file: the exit code, the duration, the commit and tree it ran on, the identity that signed, and the machine. The verification adds the repository, the pull request, the workflow and job, the outcome and a reason. An audit adds CI's own result for the same tree.

Three points shape the list below.

**Vouch can borrow two flakiness rules without per-test data.** Nx flags a task that fails and then passes on the same input hash [1]. BuildPulse flags a pass and a fail on the same git tree [13]. Vouch has the tree and the exit code, so it can flag a suite that failed and then passed on one tree. It cannot name the test.

**An audit mismatch has three possible causes, and exit codes cannot tell them apart.** The suite is flaky, the environments differ, or the attestation was false. WooCommerce records whether the base branch moved for this reason and ships a container mode to rule out the toolchain [46]. The mismatch view has to show the evidence for each cause side by side. Per-test results from both sides would help most here, and nowhere else in v1.

**Time saved needs a baseline that Vouch does not have by default.** The local duration is measured on another machine, so it is the wrong number. The right baseline is the duration of the same CI test job when it does run, which happens on every fallback and every audit. GitHub's API returns `started_at` and `completed_at` for a workflow job [41], and Datadog reads the same data through a GitHub App with read access to Actions [26]. The WooCommerce pull request reports four jobs going from 1,183 seconds of runner time to 45, so a skipped job still costs a little when the verification runs inside it [46]. Wall-clock time saved is a second number. It equals the test job's duration only when the test job is on the workflow's critical path, which Datadog marks on its pipeline view [27]. I would show CI minutes saved as the main figure and label wall-clock time as an upper bound until the service knows the other jobs' durations.

## Ranked candidate views

This section is a proposal. I ranked by four tests, in this order. Does the view answer a question no other product answers? Does trust in the product depend on it? Does v1 hold the data anyway? Do users of the products above expect it?

All of views 1 to 7 work from the exit code and the duration alone. Only view 9 needs per-test data.

| Rank | View | Leads with | Data it requires |
| --- | --- | --- | --- |
| 1 | Verification feed and commit detail | Outcome per commit: skipped, ran, audited | Verification records with outcome and reason, joined to the attestation and its run |
| 2 | Audits and mismatches | Agreement rate, open mismatches | Audit result from CI, the attestation, a base-moved flag, both environments |
| 3 | Savings overview | CI minutes saved, share of test jobs skipped | Verification outcomes plus a baseline duration per CI test job |
| 4 | Fallback reasons | Count per reason, top reason | A reason code on every verification that did not skip |
| 5 | People and agents | Attestations and mismatches per identity | Signing identity and credential kind on every attestation |
| 6 | Run history | Local pass rate, duration p50 and p95, flaky suite flag | Every run including failed ones: exit code, duration, tree, machine |
| 7 | Repository setup and health | Setup steps done, last verification | App installation, workflow state, config, kill switch |
| 8 | Environments | Mismatches per environment pair | A machine fingerprint on runs and on CI. Waits on T-777 |
| 9 | Per-test results | Tests that differ between local and CI | JUnit XML from the run and from the audit |

### 1. Verification feed and commit detail

A list with one row per verification: repository, pull request, commit, who attested, outcome and reason, time saved, time. A row opens the commit's page with the run behind the attestation, the command, the duration, the machine, the identity, every verification of that commit and any audit. The user answers "did CI skip this, and on whose word?"

This is the same shape as Currents' runs and pull requests pages and Datadog's execution list [27] [34]. It ranks first because every other view links into it, and because it is the public record that the critics of `gh-signoff` asked for [46]. If the run uploads its log, the log belongs here. The map has not decided that.

### 2. Audits and mismatches

Leads with the agreement rate over the range and the count of mismatches nobody has resolved. Lists each audit with commit, attester, local result, CI result and whether the base moved. A mismatch opens the commit detail with the two environments side by side. The user marks a mismatch as flaky, as an environment problem or as a false attestation.

No product in this file has this view, because none has a second result to compare. It ranks second because the map's trust model rests on it. The map says a faked pass cannot be prevented and has to be detectable and attributable. This view is where a team sees whether that works. A suite that fails an audit and passes on a re-run of the same tree gets the flaky flag from view 6.

### 3. Savings overview

A row of tiles in the style every product uses: CI minutes saved, share of test jobs skipped, wall-clock time saved, audit agreement rate. Each has the change from the previous period. A chart shows skipped, ran and audited per day. A table breaks savings down by repository.

Only Vouch can show this, because GitHub's metrics drop skipped runs [40]. It ranks third, not first, because the number is an estimate until the baseline question is settled, and a dashboard that leads with an estimate invites doubt. Show the local run time beside it, so the page does not claim time that moved to a laptop was free.

### 4. Fallback reasons

Counts per reason for the range, as a bar chart and a table, with the top reason first. A reason opens the feed filtered to it. The closed research already supplies most of the list:

- No attestation exists for the tree.
- The pull request is behind its base, so the tree CI builds is not the attested tree [48].
- A fork pull request has no OIDC token [47].
- A Dependabot pull request has no local run [47].
- The event is a push to the default branch or a merge queue run, if the trust model always tests there [46].
- A guarded file changed.
- The commit was sampled for an audit.
- The service did not answer in time, and the action fails open [47].
- The kill switch is on [46].
- The environment or the command differs from what CI declares. This waits on T-775 and T-777.

This is the view that raises the skip rate, because each reason has a fix. `attest` has an `explain` command for the same need, and WooCommerce logs the reason in one line [46]. It ranks below savings only because it serves the person tuning the setup, not everyone.

### 5. People and agents

One row per signing identity: runs, attestations, skips earned, audits, mismatches, last active. Agents sit under the account that delegated the credential, marked as unattended, which is all a sandbox attestation can honestly say [49]. The user finds the credential behind a cluster of mismatches and revokes it.

The other products show the commit author at most. Attribution is half of the map's answer to a faked pass, so the view has to exist. I rank it fifth because a small team reads the same facts from the feed.

### 6. Run history

One row per run, including runs that failed and never produced an attestation. Leads with local pass rate and the p50 and p95 duration of the test command, per repository. Flags a tree where the suite both failed and passed. This is Nx's task analytics and flaky task rule applied to one task, the test command [1] [2].

It needs a decision the map has not made: whether the library uploads failed runs. Without them the view shows passes only and the flaky flag never fires.

### 7. Repository setup and health

One row per repository: App installed, workflow calls the action, last attestation, last verification, sample rate, kill switch. Trunk's collections list has a setup-steps column for the same purpose [7]. It ranks low for a running team and high during the first week, so it may fit better inside onboarding than as a dashboard page.

### 8. Environments

Runs and mismatches grouped by OS, architecture and runtime version, compared with CI's. Nx gives each flaky task an Environments tab [1]. It depends on what T-777 decides the library records, so I leave it unranked against the others until then.

### 9. Per-test results

Flaky tests, slowest tests and per-test failure rate. Five products already do this well, and a team that wants it has probably installed one. Vouch would need a JUnit report from every run, which the wrapped command does not give without a reporter flag or a config change. I would leave this out of v1.

The narrow case worth keeping in mind is the mismatch page, where naming the test that passed locally and failed in CI would save the user a trip to the CI log. A link to the CI job covers that in v1.

### Next to the dashboard: the pull request

Every product puts its result on the pull request, and most developers stop there [5] [11] [23] [28] [38]. Vouch's equivalent is one line on the check or the job summary that says the tests were skipped, who attested and how much time that saved, or that the tests ran and why. This belongs to the action contract in T-782, not to the dashboard, but T-783 should count it as the first screen most users see.

## Unconfirmed

- Every screen description. I read docs, not live screens. Vendors change dashboards faster than docs.
- Nx Cloud's flaky task page. `nx.dev/docs/features/ci-features/flaky-tasks` returned 404 to my fetch, so I read the copy on `canary.nx.dev` [1].
- What Nx Cloud's Time saved page shows and how Nx computes it. Release notes only [3].
- How Codecov decides a test is flaky [28] [29].
- Which plans include Codecov's flaky detection. I read the product page only, not the pricing page [29].
- The charts on BuildPulse's Metrics tab, its test detail page, and which git metadata its uploader sends [13] [16].
- Datadog's repository, branch and commit views. The pages I read name them but do not describe them [18] [23].
- How Datadog computes time saved [24].
- My reading of Datadog's feature table for JUnit upload. The table's Markdown is misaligned [18].
- Whether Datadog's GitHub Actions setup needs no workflow change [26].
- Which Currents features a JUnit-sourced run lacks, and whether its flaky detection works for one [35] [36].
- Whether Trunk still has a separate CI analytics product. `https://docs.trunk.io/ci-analytics` redirects to a login, so I could not read it.
- Which plans include GitHub Actions metrics, and which App permission reads workflow job timings. The REST page says anyone with read access to the repository can call it and names no App permission [40] [41].

## Questions this raises for the map

1. Skipping the test job skips its upload steps. Trunk, BuildPulse, Codecov, Datadog and Currents all upload from the job that ran the tests, and Codecov's coverage upload usually sits in the same job. A team with a required coverage check could find it never reports on a skipped commit. That last sentence is my inference, not a documented case. Does Vouch document this, upload the report itself, or leave coverage out of scope?
2. Where does the baseline for time saved come from? The options are the GitHub App reading workflow job timings, or the action reporting the duration of the test job when it runs. T-779 and T-782 need to settle it before the dashboard can show a number.
3. Does the library upload failed runs and runs it refused to attest, with a reason? Views 4 and 6 are half empty without them.
4. Are fallback reasons a fixed list in the action contract? The dashboard can only count what the action names.
5. Does a run record an optional report path, so per-test data can arrive later without changing the run format?
6. Does the action write a job summary or a check line on the pull request? Every product in this file does.
7. Does a sandbox token carry a label that names the agent product? The people and agents view needs something to show besides the delegating account.

## Sources

All read on 2026-11-14.

1. Nx, Identify and re-run flaky tasks. https://canary.nx.dev/docs/features/ci-features/flaky-tasks
2. Nx blog, Nx Cloud release: enterprise task analytics, 2025-11-07. https://nx.dev/blog/nx-cloud-release-introducing-enterprise-task-analytics
3. Nx Cloud enterprise release notes. https://nx.dev/docs/reference/nx-cloud/release-notes
4. Nx Cloud public API. https://nx.dev/docs/reference/nx-cloud/public-api
5. Nx, Continuous integration with Nx Cloud. https://nx.dev/docs/features/ci-features
6. Nx Cloud product page. https://nx.dev/nx-cloud
7. Trunk, Flaky Tests dashboard. https://docs.trunk.io/flaky-tests/dashboard
8. Trunk, Flaky Tests get started. https://docs.trunk.io/flaky-tests/get-started
9. Trunk, Flake detection. https://docs.trunk.io/flaky-tests/detection
10. Trunk, Analytics CLI. https://docs.trunk.io/flaky-tests/uploader
11. Trunk, GitHub pull request comments. https://docs.trunk.io/flaky-tests/github-pull-request-comments
12. Trunk, Vitest. https://docs.trunk.io/flaky-tests/get-started/frameworks/vitest
13. BuildPulse, Flaky tests dashboard. https://docs.buildpulse.io/flaky-tests/guides/Flaky%20Tests%20Dashboard
14. BuildPulse, BuildPulse dashboard. https://docs.buildpulse.io/Getting%20Started/BuildPulse%20Dashboard
15. BuildPulse, Export test results. https://docs.buildpulse.io/Getting%20Started/Export%20Test%20Results
16. BuildPulse GitHub Action, README. https://github.com/buildpulse/buildpulse-action
17. BuildPulse, Flaky tests product page. https://buildpulse.io/products/flaky-tests
18. Datadog, Test Optimization. https://docs.datadoghq.com/tests/
19. Datadog, Test Health. https://docs.datadoghq.com/tests/test_health/
20. Datadog, Flaky Tests Management. https://docs.datadoghq.com/tests/flaky_management/
21. Datadog, Flaky test management. https://docs.datadoghq.com/tests/flaky_test_management/
22. Datadog, Uploading JUnit test report files. https://docs.datadoghq.com/tests/setup/junit_xml/
23. Datadog, Developer workflows. https://docs.datadoghq.com/tests/developer_workflows/
24. Datadog, Test Impact Analysis. https://docs.datadoghq.com/tests/test_impact_analysis/
25. Datadog, CI Pipeline Visibility. https://docs.datadoghq.com/continuous_integration/pipelines/
26. Datadog, GitHub Actions setup for CI Visibility. https://docs.datadoghq.com/continuous_integration/pipelines/github/
27. Datadog, Search and manage CI pipelines. https://docs.datadoghq.com/continuous_integration/search/
28. Codecov, Test Analytics. https://docs.codecov.com/docs/test-analytics
29. Codecov, Test Analytics product page. https://about.codecov.io/product/feature/test-analytics/
30. Codecov blog, Find failing and flaky tests with Codecov Test Analytics, 2024-11-14. https://about.codecov.io/blog/find-failing-and-flaky-tests-with-codecov-test-analytics/
31. Currents, Project overview. https://docs.currents.dev/dashboard/projects/project-overview.md
32. Currents, Tests explorer. https://docs.currents.dev/dashboard/test-suite-performance-explorer/tests-explorer.md
33. Currents, Run details. https://docs.currents.dev/dashboard/runs/run-details.md
34. Currents, Pull requests. https://docs.currents.dev/dashboard/runs/pull-requests.md
35. Currents, Flaky tests. https://docs.currents.dev/dashboard/tests/flaky-tests.md
36. Currents, Other frameworks. https://docs.currents.dev/getting-started/other-frameworks/others.md
37. Currents, Data format reference. https://docs.currents.dev/resources/reporters/data-format-reference.md
38. Currents, GitHub integration. https://docs.currents.dev/resources/integrations/github.md
39. Currents, documentation index. https://docs.currents.dev/llms.txt
40. GitHub, Viewing GitHub Actions metrics for your organization. https://docs.github.com/en/organizations/collaborating-with-groups-in-organizations/viewing-github-actions-metrics-for-your-organization
41. GitHub, REST API endpoints for workflow jobs. https://docs.github.com/en/rest/actions/workflow-jobs
42. Vitest, Reporters. https://vitest.dev/guide/reporters
43. Jest, Configuring Jest. https://jestjs.io/docs/configuration
44. Node.js, Test runner. https://nodejs.org/api/test.html
45. Playwright, Reporters. https://playwright.dev/docs/test-reporters
46. Vouch research, Prior art for trusting local test runs, T-767. https://github.com/Daniel88dev/vouch/blob/research/prior-art/docs/research/prior-art.md
47. Vouch research, How a GitHub workflow can skip its test job safely, T-768. https://github.com/Daniel88dev/vouch/blob/research/ci-skip-mechanics/docs/research/ci-skip-mechanics.md
48. Vouch research, Which commit GitHub tests for a pull request, T-769. https://github.com/Daniel88dev/vouch/blob/research/pr-tested-commit/docs/research/pr-tested-commit.md
49. Vouch research, Signing and identity options for attestations, T-770. https://github.com/Daniel88dev/vouch/blob/research/signing-and-identity/docs/research/signing-and-identity.md
