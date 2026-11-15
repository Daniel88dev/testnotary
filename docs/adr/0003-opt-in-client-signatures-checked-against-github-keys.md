# Opt-in client signatures checked against GitHub keys

A repo may require a signature on every attestation by setting `"signatures": "required"` in `testnotary.json` on its base branch. Then the action checks each attestation itself, against keys the service cannot touch: the attester's SSH signing keys on GitHub, or a line in `.testnotary/allowed_signers` on the base branch. Without the setting, an attestation is what the service accepted from an authenticated token. We made signatures opt-in because a hosted service that can mark a tree as tested is a supply-chain target. Repos that care can remove the service from their trust path. Everyone else can reach a first skip without adding a key, which about 70% of developers would have to do.

## Consequences

- When a repo requires signatures, the action trusts the service for two things only: the audit draw and token revocation. The action checks the signature over the exact signed bytes, under the namespace `attestation@testnotary.dev`. It also checks the tree, the repo id, the suite, the command from the base branch's config, an age under 24 hours, the signer's `admin` or `write` permission, and that the diff touches no guarded file. The checkout needs a fetch depth of 2.
- A compromised service can leave audits out, and the action cannot tell. It still cannot make CI skip without a real signature from a writer.
- A sandbox token signs with an Ed25519 key of its own. The key is made on the creator's laptop and trusted through a reviewed line in the allowed signers file. The agent can read that key, so the signature protects the store, not the run.
- A signature check spends 2 to 3 `GITHUB_TOKEN` calls per matrix leg. A failed or rate-limited call means CI runs its tests (`github_unavailable`).
- The signed bytes are stored and served exactly as uploaded, never rebuilt from columns.
- Signing does not cover a malicious release of the action itself. Only pinning the action by commit SHA does.

## Considered options

- Signatures on by default. Most developers would need key setup before their first skip, and every sandbox would need a key from day one.
- No signatures in v1. Then a compromised service could make every enforce-mode repo skip.
- GPG keys, keys in a repo variable, and sandbox keys delegated by the creator's GitHub key. GPG needs an OpenPGP parser in the action. Any writer could change a repo variable with no review. A delegation needs two signature checks, and the service handles its revocation.
