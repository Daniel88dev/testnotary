---
# A draft from the spec's "Legal and privacy" decisions. A Czech lawyer reviews it before launch
# (launch checklist); it has not been reviewed. Git history is the change log.
title: Terms of service
effective: 2026-11-15
# Raise the version for a material change: the dashboard then shows a line for 30 days from the
# effective date. Version 1 is the first text and shows no line.
version: 1
---

These terms apply when you use Testnotary: the website at testnotary.dev, the dashboard, the service's API, the `testnotary` library and command line, and the Testnotary GitHub App and action.

## Who runs Testnotary

Testnotary is run by its maintainer, **[operator's full name]**, a private individual in the Czech Republic (the "operator", "we"). There is no company behind it. Write to [daniel@hrynusiw.cz](mailto:daniel@hrynusiw.cz) about anything in these terms.

How we handle personal data is in the [privacy policy](/privacy).

## Who may use it

You must be 16 or older and allowed to hold a GitHub account. You sign in with your GitHub account, and your Testnotary account is that GitHub account. By signing in, on the website or with `testnotary login`, you agree to these terms.

## Public records

On a **public** repo, runs, attestations, verifications and mismatches are public and name the account that made them, like the repo's own history on GitHub.

A mismatch, where an audit in CI fails while the attestation said the suite passed, states a fact, not bad faith. A mismatch is never removed on request. A repo admin can add an explanation to it.

Deleting your account anonymises it: your records stay, and show *deleted account* instead of your name.

## The beta

Testnotary is in beta. It is provided as is and free of charge, with no warranty and no promise of uptime.

We are not liable for anything that a skipped or failed test let through.

The beta ends only after 30 days' notice on the landing page and in the dashboard. When it ends, the data is deleted.

## Acceptable use

You may not:

- knowingly upload false attestations, such as a pass for tests that did not pass;
- tamper with the API or flood it with requests;
- use someone else's token;
- probe for data you are not allowed to read, such as private repos' records.

If you break these terms, the operator may revoke your tokens or suspend your account. A mismatch alone is not grounds for either.

## Deleting your account

You can delete your account yourself from the dashboard's account menu, with *Delete account*. It takes effect at once: your tokens are revoked, and your records show *deleted account*. See the [privacy policy](/privacy) for what happens to your data.

## Changes to these terms

When these terms change in a way that matters, the dashboard shows a line about it for 30 days from the new effective date above. Older versions are in the history of the Testnotary repository on GitHub.

## Law and courts

These terms are governed by Czech law, and the Czech courts decide disputes about them. If you use Testnotary as a consumer, this does not take away the protection the law of the country where you live gives you.
