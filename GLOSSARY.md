# Testnotary

Testnotary lets CI skip its test job for a commit whose tests already passed on a developer's or an agent's machine.

## Language

**Run**:
One local execution of the repo's test command, on a laptop or in a cloud agent sandbox.
_Avoid_: Test result, execution, job

**Attestation**:
The signed record that a run passed for one commit.
_Avoid_: Test result, signoff, proof, certificate, notarization, seal

**Verification**:
The CI action asking the service whether a valid attestation covers the commit CI is building.
_Avoid_: Check, validation, lookup
