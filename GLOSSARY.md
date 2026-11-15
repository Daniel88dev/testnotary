# Testnotary

Testnotary lets CI skip its test job for a commit whose tests already passed on a developer's or an agent's machine.

## Language

**Run**:
One invocation of Testnotary on a laptop or in a cloud agent sandbox to test the repo's tree with its declared test command. Every run has an outcome, even one that never started the command.
_Avoid_: Test result, execution, job

**Outcome**:
How a run ended: *passed*, *failed* or *refused*. A refused run is one Testnotary would not attest, such as a run on a dirty tree, and it may never have started the command. Only a passed run yields an attestation.
_Avoid_: Status, result, verdict, refusal

**Environment**:
The OS, architecture, runtime and tool versions a run or a CI job executed with. It is recorded to explain results, never to decide whether CI skips.
_Avoid_: Fingerprint, machine, setup

**Platform**:
The pair of OS and architecture a run executed on, such as linux/x64. The narrower part of an environment that a repo may require.
_Avoid_: Environment, target, OS

**Attestation**:
The record, tied to a GitHub account, that a run passed on one tree: the exact set of files the run tested. It also names the commit the run had checked out, but only the tree decides what it covers.
_Avoid_: Test result, signoff, proof, certificate, notarization, seal

**Verification**:
The CI action asking the service whether a valid attestation names the tree of the commit CI is building. A match counts even when CI builds a different commit, such as the merge commit GitHub creates for a pull request.
_Avoid_: Check, validation, lookup

## Trust

**Guarded file**:
A file whose change in a pull request makes CI run its tests whatever attestation exists, because the change could make CI behave differently from the run.
_Avoid_: Protected file, sensitive file, surface

**Audit**:
A test run CI performs anyway on a commit an attestation covers, chosen at random, to compare its result with the attestation.
_Avoid_: Sample run, spot check, re-verification

**Mismatch**:
An audit or a shadow-mode comparison in which CI's test job fails although an attestation says the run passed.
_Avoid_: Disagreement, false pass, violation

**Shadow mode**:
The repo state in which verification reports what it would have skipped while CI still runs every test job.
_Avoid_: Dry run, observe mode, trial

## Identity

**Installation**:
The Testnotary GitHub App installed on one GitHub account, personal or organization, together with the repos that account gave it. Testnotary has no organizations, members or roles of its own beyond this.
_Avoid_: Organization, workspace, team, tenant

**Token**:
The credential the library uploads attestations with. Testnotary issues it, and it always belongs to the GitHub account that created it.
_Avoid_: API key, secret, credential, access token

**Laptop token**:
A token a person gets by signing in from one machine. It can attest for any repo that person can write to.
_Avoid_: User token, personal token, device token

**Sandbox token**:
A token a person creates in the dashboard for one repo, so a cloud agent sandbox can attest without anyone signing in. An attestation made with it names the token and its creator, never the agent.
_Avoid_: Agent token, bot token, CI token, service token
