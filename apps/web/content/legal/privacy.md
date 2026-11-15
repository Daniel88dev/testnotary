---
# A draft from the spec's "Legal and privacy" decisions. A Czech lawyer reviews it before launch
# (launch checklist); it has not been reviewed. Git history is the change log.
title: Privacy policy
effective: 2026-11-15
# Raise the version for a material change: the dashboard then shows a line for 30 days from the
# effective date. Version 1 is the first text and shows no line.
version: 1
---

This policy says what personal data Testnotary keeps, why, who receives it, how long it is kept and what you can ask for. What the library and the action send in the first place is listed in [What leaves your machine](/docs/data).

## Who is responsible

Testnotary is run by its maintainer, **[operator's full name]**, a private individual in the Czech Republic (the "operator", "we"). The operator is an independent controller of the data described here. During the beta there is no data processing agreement with the people or organisations that use Testnotary.

Write to [daniel@hrynusiw.cz](mailto:daniel@hrynusiw.cz) about anything in this policy.

## What we keep

- **Your account:** your GitHub account's numeric id, and your GitHub login as GitHub last gave it. Your avatar is fetched from GitHub through Testnotary when a page shows it, so your browser contacts only Testnotary.
- **Your tokens:** laptop and sandbox tokens, stored as hashes only, with their names, their repo for a sandbox token, and when they were last used.
- **Runs:** the record each run uploads: the suite, the outcome, the tree and commit, the command and its exit code, the times, the environment it ran in and the names (never the values) of variables passed to it. [What leaves your machine](/docs/data) lists every field.
- **Attestations:** the exact record a passed run uploads, and in signature mode its signature and public key.
- **Verifications and job reports:** what a CI job asked and the answer, the identity of the workflow run that GitHub gives it, and the outcome, duration and environment of the CI test job.
- **Mismatches** and admins' explanations of them, with copies of the account, token and environments they concern.
- **Repo settings** and who changed them.
- **Request logs** with IP addresses, kept by the host and never joined to accounts.

## Why we may keep it

- **Performance of a contract** (the terms you accept when you sign in): your account, your tokens, runs, attestations and verifications. Without them Testnotary cannot do what you use it for.
- **Legitimate interest:** showing the records of public repos, which name the account like the repo's own history on GitHub; keeping mismatches, anonymised once their account is deleted, so a repo's history stays complete; and request logs, to keep the service running and secure.

## Who receives it

- **Amazon Web Services**, in the `eu-central-1` region (Frankfurt), hosts the service and its database, as our processor.
- **GitHub** is a separate controller. Testnotary reads from GitHub what it needs (who you are, your access to a repo, commits and their trees), and the action writes its results back to your pull requests.
- On a **public** repo, anyone can read its runs, attestations, verifications and mismatches, which name the account.

We sell nothing. There are no ads and no analytics, and the library and the action send no telemetry.

## How long we keep it

- Runs, attestations, verifications and job reports: 90 days, then deleted.
- Mismatches and their explanations: as long as the repo has the GitHub App installed.
- Tokens: deleted 90 days after they are revoked or expire, if nothing still kept points at them.
- A repo's data, once it is uninstalled, removed, deleted or transferred: deleted after 30 days.
- Request logs with IP addresses: 30 days, kept by the host.

## Your rights

- **Delete your account** yourself: *Delete account* in the dashboard's account menu. It revokes your tokens and deletes your account and your login. Your records then point to a shared *deleted account* instead of you.
- **Ask for access to your data or an export of it** by writing to [daniel@hrynusiw.cz](mailto:daniel@hrynusiw.cz). We answer by hand within one month.

## Who may sign up

You must be 16 or older and allowed to hold a GitHub account.

## Cookies

The site sets only the cookies signing in needs. They are strictly necessary, so there is no cookie banner. No cookie is set until you sign in.

| Cookie | What it holds | How long |
| --- | --- | --- |
| `testnotary.session_token` | Your session, signed. | 8 hours |
| `testnotary.session_data` | Your session's contents, encrypted, including your browser's user agent. | 8 hours |
| `testnotary.account_data` | The GitHub token the dashboard reads GitHub with on your behalf, encrypted. | 8 hours |
| `testnotary.oauth_state` | The state of a sign-in in progress, so GitHub's answer can be matched to it. | 10 minutes, while signing in |

On `https`, each name starts with `__Secure-`. Fonts are served by Testnotary itself and avatars come through Testnotary, so your browser contacts no third party.

## Changes to this policy

When this policy changes in a way that matters, the dashboard shows a line about it for 30 days from the new effective date above. The date your account was created is the only record we keep of which version you accepted. Older versions are in the history of the Testnotary repository on GitHub.
