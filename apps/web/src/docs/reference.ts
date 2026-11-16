import type { FallbackReason, RefusalCode, WarningCode } from "@testnotary/core";

// The words the Reference pages give each code: what causes it and what to do. The pages render
// the codes from the core package's lists (REFUSAL_CODES, FALLBACK_REASONS, WARNING_CODES) and
// look the words up here, so a new code fails typecheck until it has both, and a code that is
// gone from the product can't stay on a page.
//
// In the text, `backticks` mark code and [words](/docs/page#anchor) is a link.

export interface CodeHelp {
  /** What makes the product answer with this code, as the reader would see it happen. */
  cause: string;
  /** What to do about it. */
  fix: string;
}

export const REFUSAL_HELP: Record<RefusalCode, CodeHelp> = {
  not_a_git_repo: {
    cause: "The run started outside a git repository, or in one with no commits yet, so there is no tree to attest.",
    fix: "Run inside a clone of the repo you want to attest, after committing what you want to test.",
  },
  no_remote: {
    cause: "The repository has no remote named `origin`, so the library can’t tell which GitHub repo the run is for.",
    fix: "Add the GitHub repo as `origin`: `git remote add origin <url>`.",
  },
  no_config_on_base: {
    cause:
      "The base branch has no `testnotary.json`, or the library can’t tell which branch the base is (no `origin/HEAD`, and `origin` didn’t answer). The base is `--base`, else the config’s `base`, else the remote’s default branch.",
    fix: "Merge the setup pull request that adds `testnotary.json` first. If the base can’t be told, pass `--base <branch>` or run `git remote set-head origin --auto`.",
  },
  config_invalid: {
    cause:
      "`testnotary.json` on the base branch isn’t valid JSON, breaks a rule of the [schema](/docs/config), or doesn’t declare the suite you named. Each problem is printed with where it is, such as `suites.unit.command[0]`. `exec` reads the checked-out file instead, and refuses a missing one the same way.",
    fix: "Fix the file on the base branch, or name a suite it declares. Your local copy is ignored by `run` and `check`.",
  },
  extra_arguments: {
    cause: "Something follows `--` on the command line. A run tests exactly the command the base branch declares, so it can’t take extra arguments.",
    fix: "To run part of the tests, declare another suite on the base branch and run it by name: `testnotary run <suite>`.",
  },
  history_dependent_command: {
    cause:
      "The command, or the `package.json` script it names (one level deep), picks tests by what changed since a commit: `--changed`, `--changedSince`, `--onlyChanged` (or Jest’s `-o`), `--since`, `--affected`, `nx affected`, or turbo’s `--filter`/`-F` with a `[git range]`. Such a run tests less than the tree it would attest.",
    fix: "Declare a suite that runs every test, without history filters, in `testnotary.json` on the base branch.",
  },
  command_not_found: {
    cause: "The suite command’s program isn’t on `PATH`, or the path it names doesn’t exist. This is checked before anything starts.",
    fix: "Install the program, or point the command at a `package.json` script, such as `[\"npm\", \"test\"]`.",
  },
  dirty_tree: {
    cause:
      "The working tree has changes that aren’t committed, untracked files git doesn’t ignore, or a submodule at another commit or with changes of its own. A run attests a commit’s tree, so everything it tests must be in it.",
    fix: "Commit (an unpushed commit is fine), stash, or add untracked files to `.gitignore`. For a submodule, commit and record its change, or bring it back with `git submodule update --recursive`.",
  },
  tree_changed_during_run: {
    cause: "`HEAD` moved, or a file git sees changed, while the command ran: the command commits, checks out, or writes into tracked or unignored files.",
    fix: "Send what the tests write (coverage, reports, snapshots) to a directory in `.gitignore`, and keep commits and checkouts out of the command.",
  },
  platform_not_allowed: {
    cause: "This machine’s `os/arch` isn’t in the `platforms` list of `testnotary.json` on the base branch.",
    fix: "Run the suite on one of the listed platforms, or change `platforms` on the base branch.",
  },
  platform_unsupported: {
    cause: "The run is on an operating system other than macOS or Linux. On Windows the line points to WSL.",
    fix: "Run `testnotary` inside WSL, which counts as Linux, or on a macOS or Linux machine.",
  },
  repo_not_installed: {
    cause:
      "`origin` isn’t a repository on github.com, or the Testnotary GitHub App isn’t installed on it (or its installation is suspended). The service knows a repo by its current name, so a clone whose `origin` still has an old name gets this too.",
    fix: "Install the App on the repo, or update `origin` to the repo’s current URL with `git remote set-url origin <url>`.",
  },
  no_write_access: {
    cause:
      "Your GitHub account can’t write to the repo, asked live. For a sandbox token it is its creator’s access that counts, and a sandbox token used on any repo but its own gets this too.",
    fix: "Only people with write access attest. Ask for access, or use the repo’s own sandbox token.",
  },
  token_rejected: {
    cause:
      "The service didn’t accept the token: it was revoked or has expired, or a repo admin blocked your laptop token on this repo. The service never says which.",
    fix: "Sign in again with `testnotary login`, or create a new sandbox token. A token blocked on a repo stays blocked there; it still works on your other repos.",
  },
  interrupted: {
    cause: "Ctrl-C reached the run while the command ran. The command gets the signal, and the run is refused with exit code 130.",
    fix: "Let the command finish, then run again.",
  },
  runtime_mismatch: {
    cause:
      "This Node doesn’t match the version the repo pins, read the way CI’s `setup-node` reads it: the file `nodeVersionFile` names, else `.node-version`, `.nvmrc`, `.tool-versions`, then `package.json`’s `volta.node`, `devEngines.runtime` and `engines.node`. Also when the pin isn’t a version `setup-node` can install, or `nodeVersionFile` names a file that doesn’t exist.",
    fix: "Switch to a matching Node (`nvm use`, `fnm use`, Volta, mise) and run again, or fix the pin on the base branch.",
  },
  package_manager_mismatch: {
    cause:
      "The package manager this run would use isn’t the one `package.json` pins in `packageManager` (or `devEngines.packageManager`), it isn’t on `PATH`, or the pin isn’t `<name>@<version>`. The library never runs a package manager: it reads the version from `npm_config_user_agent` when it was started through one, else from the installed tool’s own files. A shim such as Volta’s or mise’s hides the version, which refuses too.",
    fix:
      "Install the pinned version with `npm install --global <name>@<version>`, or let Corepack provide it: `npm install --global corepack && corepack enable` (Node 25 and later no longer ship Corepack). Or run Testnotary through the package manager, which tells it the version: `npx testnotary run`, `pnpm exec testnotary run` or `yarn testnotary run`.",
  },
  install_stale: {
    cause:
      "The installed dependencies don’t match the lockfile, judged from the install-state file the package manager wrote: npm’s `node_modules/.package-lock.json`, pnpm’s `node_modules/.pnpm-workspace-state-v1.json` (pnpm 10: `node_modules/.pnpm/lock.yaml`), Yarn Berry’s `.yarn/install-state.gz`, Yarn classic’s `node_modules/.yarn-integrity`. Also when that file is missing or can’t be read.",
    fix: "Run your install (`npm ci`, `pnpm install` or `yarn install`), then run again. Hand edits inside `node_modules` aren’t detected either way.",
  },
  package_manager_unsupported: {
    cause: "The repo’s `packageManager` pin or lockfile names Bun, Deno or another tool than npm, pnpm and Yarn, or the suite command runs `bun`, `bunx` or `deno`.",
    fix: "v1 supports npm, pnpm and Yarn only. Such a repo can’t attest yet, so CI runs its tests as before.",
  },
  laptop_token_in_sandbox: {
    cause:
      "`TESTNOTARY_TOKEN` holds a laptop token and a [sandbox marker](/docs/agents#sandbox-markers) is present. The refused run isn’t uploaded, so the token never leaves the sandbox through Testnotary.",
    fix: "Create a sandbox token for the repo on the dashboard and set it as `TESTNOTARY_TOKEN` instead. Revoke the laptop token on the dashboard’s Tokens page if it was copied anywhere.",
  },
};

export const REASON_HELP: Record<FallbackReason, CodeHelp> = {
  disabled: {
    cause: "The repo variable `TESTNOTARY_DISABLED` is `true` (any case). The action fetches no token and calls nothing.",
    fix: "Delete the variable, or set it to anything else, to turn skipping back on.",
  },
  host_not_supported: {
    cause: "The workflow runs on GitHub Enterprise Server or GHE.com: `GITHUB_SERVER_URL` isn’t `https://github.com`, or isn’t set. A notice says so, and nothing is called.",
    fix: "None in v1, which serves github.com only. See [Limits in v1](/docs/limits#github-enterprise).",
  },
  no_oidc_token: {
    cause:
      "The job has no Actions OIDC token: the workflow doesn’t grant `id-token: write`, the pull request is from a fork (which never gets one), or the runner’s token request failed. A fork gets a notice; a same-repo job gets a warning.",
    fix: "Add `permissions: id-token: write` to the job. Forks always run their tests.",
  },
  service_unreachable: {
    cause: "The service couldn’t be reached, twice: a connection error, then one retry a second later.",
    fix: "Nothing to fix in the repo; the tests ran. A self-hosted runner needs to reach `testnotary.dev`.",
  },
  service_error: {
    cause: "The service answered with an error, or with something the action can’t read. A 5xx or a 429 is retried once after a second; this is the answer that stood.",
    fix: "Nothing to fix in the repo; the tests ran. If it keeps happening, report it.",
  },
  timeout: {
    cause: "The verification took more than its 10-second budget, which covers the token, both attempts and the pause between them.",
    fix: "Nothing to fix in the repo; the tests ran.",
  },
  repo_not_installed: {
    cause: "The Testnotary GitHub App isn’t installed on this repo, or its installation is suspended.",
    fix: "Install the App on the repo from github.com.",
  },
  token_rejected: {
    cause:
      "The service didn’t accept the job’s OIDC token: its signature, issuer, audience or age failed, or it had been used before. The reason goes to the service’s log, never to the pull request.",
    fix: "Usually nothing: the next job gets a fresh token. A repeated rejection is worth a report.",
  },
  github_denied: {
    cause:
      "GitHub refused one of the service’s requests. The service records it like any other answer, so it counts on the dashboard. When an IP allow list is the cause, the line says so, quotes GitHub and links the limits page.",
    fix: "None for an IP allow list in v1: Testnotary has no fixed IP addresses. See [Limits in v1](/docs/limits#github-enterprise).",
  },
  unknown_suite: {
    cause: "`testnotary.json` at the built commit’s first parent doesn’t declare this job’s suite, can’t be parsed, or doesn’t exist there.",
    fix: "Name a suite the base branch declares in the action’s `suite` input, or merge the config change first.",
  },
  no_attestation: {
    cause:
      "No attestation for this repo and suite names the tree CI is building. The detail says when no attestation could be checked at all: the event isn’t one whose commit is the code the job tests (only `pull_request`, `merge_group` and a `push` to the default branch are), or the job’s checkout isn’t the tree the service verified.",
    fix: "Commit everything, bring the branch up to date with the base (CI tests the merge into it), then `testnotary run <suite>` and push. With an event or checkout detail, nothing: such a job always runs its tests.",
  },
  attestation_expired: {
    cause: "The attested run ended 24 hours ago or more.",
    fix: "Run the suite again and push.",
  },
  attestation_revoked: {
    cause:
      "The attestation’s token was revoked, blocked on this repo by an admin, or has expired. The detail says which: `token revoked`, `token blocked on this repo` or `token expired`.",
    fix: "Sign in again (`testnotary login`) or use a live sandbox token, then run the suite again.",
  },
  attester_no_write: {
    cause: "The person who attested, or the sandbox token’s creator, no longer has `admin` or `write` on the repo, asked live.",
    fix: "Someone with write access runs the suite and pushes.",
  },
  command_changed: {
    cause: "The command the run tested differs from the suite’s command in `testnotary.json` at the built commit’s first parent.",
    fix: "Update the branch from the base, run the suite again and push.",
  },
  guarded_file_changed: {
    cause:
      "The change touches a [guarded file](/docs/guarded). The detail names the first such path, or says the pull request changes 300 or more files, more than GitHub lists.",
    fix: "Nothing: such a change always runs its tests. Expected on the setup pull request.",
  },
  signature_missing: {
    cause:
      "The base branch’s `testnotary.json` sets `\"signatures\": \"required\"` and the attestation has no signature. The run that made it warned with `no_signing_key`.",
    fix: "Set up a signing key: on a laptop, git’s `gpg.format ssh` and `user.signingKey`, with the key added to GitHub as a signing key; in a sandbox, `testnotary sandbox-key`. See [Security](/docs/security).",
  },
  signature_invalid: {
    cause:
      "In signature mode, the action’s own check of the attestation failed. The detail starts with the check: `signature:`, `tree:`, `repository:`, `suite:`, `command:`, `age:`, `guarded file:`, `permission:`, `checkout:` when the repo requires signatures and the job has no checkout, or no first parent in it, or `config:` when the base’s `testnotary.json` isn’t JSON, or requires signatures in a form this release of the action can’t read.",
    fix: "Follow the detail. For `checkout:`, give `actions/checkout` `fetch-depth: 2`. For `config:`, fix the base’s config, or update the action’s pinned SHA to a release that reads it. For an untrusted key, add it to GitHub as a signing key or to `.testnotary/allowed_signers` on the base branch.",
  },
  github_unavailable: {
    cause:
      "GitHub couldn’t be asked: in signature mode, a call the action makes with the job’s token failed, took over 10 seconds, or hit the rate limit; or one of the service’s own calls to GitHub failed while it verified the job.",
    fix: "Nothing to fix in the repo; the tests ran. Re-run the job if you want the skip.",
  },
  audit: {
    cause: "This skip was drawn for an audit, in enforce mode: 1 in 10 by default, 1 in 5 for sandbox tokens. The tests run although an attestation covers the tree.",
    fix: "Nothing. If the tests fail where the run passed, it is a mismatch, and the repo goes back to shadow mode. See [Audits and mismatches](/docs/audits).",
  },
};

export const WARNING_HELP: Record<WarningCode, CodeHelp> = {
  not_signed_in: {
    cause: "The run has no token: no `TESTNOTARY_TOKEN`, no laptop token, and no proxy attached one. The tests run; nothing is attested.",
    fix: "Run `testnotary login`, or in an agent sandbox set `TESTNOTARY_TOKEN` to a sandbox token.",
  },
  service_unreachable: {
    cause: "The service didn’t answer the run’s first call within 3 seconds, or answered with an error. The tests run; nothing is attested.",
    fix: "Try again later. In a sandbox, let it reach `testnotary.dev`.",
  },
  upload_failed: {
    cause: "The tests passed, but the run’s upload didn’t reach the service, so nothing is attested.",
    fix: "Run the suite again.",
  },
  base_fetch_skipped: {
    cause: "The base branch couldn’t be fetched (offline, or 20 seconds passed), or wasn’t tried because the service couldn’t be reached first and nothing will be attested anyway. The last fetched copy is used, so its config and the branch-behind check may be out of date.",
    fix: "Fetch when you’re back online and run again.",
  },
  branch_behind_base: {
    cause: "The branch doesn’t contain the base branch’s tip. CI tests the branch merged into the base, so its tree won’t match the one this run attests.",
    fix: "Merge or rebase onto the base, then run again. Testnotary never does it for you.",
  },
  local_config_differs: {
    cause: "Your working tree’s `testnotary.json` differs from the base branch’s, which is the one the run uses.",
    fix: "Expected while you change the config: a pull request that changes it runs CI in full, and the new rules count once it is merged.",
  },
  ignored_env_file: {
    cause: "An ignored `.env` or `.env.*` file exists (other than `.env.example`). Test code that loads it with dotenv still reads it, and CI doesn’t have it.",
    fix: "Pass what the tests need with `env.pass` or `env.set`. See [Shell features and .env files](/docs/shell).",
  },
  runtime_sources_disagree: {
    cause: "A lower-priority Node pin, such as `engines.node`, asks for a Node this one isn’t, while the pin in use matches.",
    fix: "Make the pins agree, or set `nodeVersionFile` to the file CI’s `node-version-file` reads.",
  },
  no_signing_key: {
    cause: "The repo requires signatures, but this run found no usable signing key, or signing failed. The attestation uploads unsigned, and CI falls back with `signature_missing`.",
    fix: "Set up the key the line names. See [Security](/docs/security).",
  },
};
