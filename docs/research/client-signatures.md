# Client signatures the action can check without the service

Research for Fenro task T-794. I read every source and ran every test on 2026-11-15. Numbers in square brackets point to the source list at the end. A claim marked "unconfirmed" has no primary source or test behind it yet. A sentence that starts with "My read" is my conclusion from the sources, not a quote of them.

The signing research for T-770 [21] wrote the product's name as Vouch. This file uses Testnotary throughout, and the glossary's terms. I write "signature check" for the action checking a client signature, to keep it apart from a verification, which is the action asking the service.

## The question

If the library signed each attestation on the client, how could the action check that signature without trusting Testnotary's service for the public key? A compromised service could otherwise forge attestations and serve its own keys.

## Short answer

1. GitHub already publishes a key the action can trust. `GET /users/{username}/ssh_signing_keys` "is accessible by anyone" [5], and the `GITHUB_TOKEN` every job holds is an installation token that may call it [7] [10]. In a sample of 617 top contributors to seven popular JavaScript and TypeScript repos, 31% had an SSH signing key on GitHub and 54% had an SSH signing key or a GPG key. Those people need no setup. The rest create a key and add it as a signing key, which `gh ssh-key add --type signing` does in one command [20].
2. A signature alone does not stop a compromised service. The action has to work out for itself, from GitHub, the tree it builds, the repo, the suite, the attester's write permission and the attestation's age, then demand that the signed bytes match. The demand for a signature has to come from the workflow or the base branch, because a setting the service holds is a setting the attacker can switch off.
3. A sandbox has no GitHub signing key of its own. It can hold a key pair made for the sandbox token, with the private half stored next to the token. The action can trust the public half in one of three ways. A line in an allowed signers file on the base branch, which a reviewer approves in a PR. A repository variable. Or a short statement signed with the creator's GitHub signing key that names the sandbox key. Adding the sandbox key to the creator's GitHub account would also let it sign commits that GitHub marks Verified, so that one is out.
4. Node checks an `sshsig` signature with `node:crypto` and nothing else. My scratch verifier handles Ed25519, ECDSA P-256, P-384 and P-521 and RSA keys, agreed with `ssh-keygen -Y verify` on all five, and rejected a changed message, the wrong namespace and the wrong key. It is 102 lines, 3,881 bytes minified and 1,613 bytes gzipped. The two hardware-backed `sk-` key types are written but untested.
5. Fetching the key fits the 10-second budget. Each GitHub call took about 0.4 seconds from my machine, and a signature check needs two or three calls in a row. The tighter limit is `GITHUB_TOKEN`'s 1,000 requests per hour per repository [9], which a wide matrix on a busy repo could use up. A key file read from the checkout needs no calls at all.
6. GitHub's endpoint lists the keys an account holds now, with no history [5]. A key deleted after attesting makes the signature check fail, and CI runs the tests. Attestations expire after 24 hours, so an honest rotation costs at most a day of skips. The prior art does the same thing in other ways. Git's allowed signers take `valid-after` and `valid-before` and judge a signature by its own time [3] [4]. GitHub stores a verification record at push time [14]. gitsign proves the time through a transparency log [16] [17].

Client signatures move forgery out of the service's reach. They do not stop an agent that holds the key from signing a pass it never earned, which T-770 already found [21].

## What the action must check itself

The point of a client signature is that the action can catch a forged attestation even when every byte the service sends is hostile. So list what a compromised service could do, and what the action has to know without asking it.

| A compromised service could | The action catches it if it | Where the action gets the truth |
| --- | --- | --- |
| Invent an attestation | Checks a signature against a key it got outside the service | GitHub's key list, or a key file on the base branch |
| Replay a real attestation for another tree | Compares the signed tree with the tree it builds | `git rev-parse HEAD^{tree}` in the checkout, or the Git commits API |
| Replay one from another repo or suite | Compares the signed repo id and suite with its own | `GITHUB_REPOSITORY_ID` and the action's `suite` input |
| Replay a stale one | Compares the signed time with the clock and the 24-hour expiry | The runner's clock |
| Present a real signature from someone with no write access, such as any GitHub user who signed for a public repo's tree | Asks GitHub for the signer's permission | `GET /repos/{owner}/{repo}/collaborators/{username}/permission` [8] |
| Name the wrong account | Resolves the signed account id to a login itself | `GET /user/{account_id}` [7] |
| Turn off the demand for a signature | Reads the demand from somewhere the service cannot write | An action input in the workflow, or `testnotary.json` on the base branch. Both are guarded files. |

Some checks protect policy rather than authorship. A compromised service could hide a guarded file in the diff, accept a changed command, never pick an audit, or keep honouring a revoked token. Each of those still needs a real, signed attestation for the exact tree. The action can redo the guarded file and command checks with the compare and contents endpoints, at the cost of more calls. It cannot redo the audit sample, because the HMAC secret lives only on the service.

The signed bytes have to carry at least the tree, the commit, the repository id, the suite, the command, the signer's account id, the time, and the outcome. My read: the action should receive the exact signed bytes, check the signature over them, and only then parse them and compare fields. Rebuilding the bytes from database columns invites a canonical-form bug.

Client signatures do not help against one threat the store defence ticket lists. A malicious change released from `main` changes the action too. Only a workflow that pins the action by commit SHA defends against that, and it is outside this ticket.

## Where the action can get a key it trusts

### GitHub's SSH signing keys for the attesting account

`GET /users/{username}/ssh_signing_keys` returns each key's `id`, `key`, `title` and `created_at`, 30 per page by default and 100 at most [5]. GitHub's list of endpoints for installation access tokens includes it, along with `GET /users/{username}/gpg_keys`, `GET /users/{username}/keys` and `GET /user/{account_id}` [7]. `GITHUB_TOKEN` "is a GitHub App installation access token", and an action reads it from the `github.token` context [10] [11]. Unconfirmed: whether it can call this endpoint when the workflow's `permissions` block leaves every scope but `id-token` and `checks` at `none` [12]. The endpoint is public, so I expect it can.

Signatures use OpenSSH's `sshsig` format [1]. The `namespace` field exists so that "signatures intended for one intended domain" are not accepted in another [1]. `ssh-keygen` suggests the form `NAMESPACE@YOUR.DOMAIN` for custom uses [3]. A key a developer uses for commits signs under the namespace `git`. A Testnotary signature under a namespace such as `attestation@testnotary.dev` cannot pass as a commit signature, or the other way round. My verifier rejected a valid signature checked under the wrong namespace.

What it costs the developer:

- With a signing key already on GitHub, nothing. Git records the key in `user.signingKey`, as a path or as `key::` and the public key, when `gpg.format` is `ssh` [4]. The library can read that and sign with the same key.
- Without one, create a key and run `gh ssh-key add --type signing` [20], or add it in GitHub's settings. Git 2.34 or later is needed only for commit signing [14], not for Testnotary.

How the library signs:

- Node cannot read an OpenSSH private key. `crypto.createPrivateKey` on an `-----BEGIN OPENSSH PRIVATE KEY-----` file threw `ERR_OSSL_UNSUPPORTED` in my test. So the library either spawns `ssh-keygen -Y sign`, which can sign with a key held in `ssh-agent` [3], or speaks the agent protocol over `SSH_AUTH_SOCK` itself. Unconfirmed: the size of a pure Node agent client.
- Git lets a user swap `ssh-keygen` for another program through `gpg.ssh.program`, which is how password manager agents sign commits. Unconfirmed: whether those programs accept a namespace other than `git`.
- A hardware key "generally" wants a touch for each signature [3], so it puts a person in the path for every run.

Three limits:

- The key belongs to a person and lives on that person's machines. A sandbox does not have it.
- A thief who copies it can also sign commits that GitHub marks Verified [14]. That loss exists already for anyone who signs commits, and Testnotary adds a second use to it.
- The list is current state only. See the section on rotation.

### GitHub's GPG keys

`GET /users/{username}/gpg_keys` is public as well [6] [7]. Checking an OpenPGP signature needs an OpenPGP packet parser, which `node:crypto` does not have, and the library would need `gpg` on the machine to sign. Unconfirmed: the bundled size of a parser such as OpenPGP.js. In my sample, 142 accounts had a GPG key and no SSH signing key, 23% of the whole sample. SSH keys alone leave that group with the one-command setup. My read: start with SSH keys, and add GPG only if attesters ask for it.

### A file of allowed signers on the base branch

OpenSSH's allowed signers format lists principals, options and a public key on each line [3]. The options include `namespaces=`, `valid-after=` and `valid-before=`, and `ssh-keygen -Y verify` checks them [3]. Git documents keeping such a file in the repository itself: "only committers with an already valid key can add or change keys in the keyring", when the repository allows only signed commits [4].

For Testnotary, a file such as `.testnotary/allowed_signers` on the base branch could map account ids to keys. The action reads it from the base branch, as it already reads `testnotary.json` there, and it would be a guarded file.

- It works for any key, sandbox keys included, and for people with no GitHub signing key.
- It costs a PR for every new laptop or sandbox key, and a reviewer has to approve each one.
- The line's principal is only a claim. A writer could add their own key under another writer's account id, and only the reviewer would catch it. GitHub's key list does not have this gap, because only the account holder can add a key to it.
- Reading it costs no API call when the job has a checkout. The merge commit's first parent is the base tip, so `git show HEAD^1:.testnotary/allowed_signers` works with a fetch depth of 2. Unconfirmed: what depth the setup guide's checkout uses.

### A repository variable

The workflow could pass `${{ vars.TESTNOTARY_SIGNERS }}` to the action, the way the action contract passes the kill switch. For an organization repository, creating a variable needs write access, and for a personal repository it needs collaborator access [13]. So anyone who may attest may also add a key. It needs no PR, and nothing in the repo's history shows the change. My read: weaker than the file and no cheaper for the person.

### Places that do not work

- Keys the service serves. That is the premise of the ticket.
- A repository's deploy keys. Listing them needs the Administration permission [8], and `GITHUB_TOKEN` has no such scope [12].
- The account's authentication keys from `GET /users/{username}/keys` [7]. An attestation would read as signed by a key the person registered only to push. GitHub keeps signing keys apart, and a person can upload the same key again as a signing key [14].
- Adding a sandbox key to the creator's GitHub account as a signing key. The sandbox could then sign commits that show as Verified for that person [14].

### How many developers already have a signing key

GitHub publishes no figure that I found. So I sampled. I took GitHub's top 100 contributors of seven repos (`nodejs/node`, `facebook/react`, `vercel/next.js`, `microsoft/TypeScript`, `vitejs/vite`, `vercel/ai` and `withastro/astro`), kept user accounts, and asked the public endpoints about each. 655 accounts came back, and 38 lookups failed, which leaves 617.

| Key on GitHub | Accounts | Share |
| --- | --- | --- |
| SSH signing key | 189 | 30.6% |
| GPG key | 197 | 31.9% |
| SSH signing key or GPG key | 331 | 53.6% |
| SSH authentication key | 438 | 71.0% |

The 189 accounts held 298 signing keys. 268 were Ed25519, 24 RSA, 5 ECDSA P-256 and 1 a hardware-backed ECDSA key. 60 accounts held more than one.

These are heavy contributors to large projects, who sign commits more often than an average developer. A key on GitHub also says nothing about whether the person uses it. My read: treat 30% as an upper bound for Testnotary's early users, and expect most of them to need the one-command setup.

## What a sandbox token signs with

A cloud agent sandbox holds no key of the developer's. T-770 found that a vendor proxy can attach a secret to a request but cannot sign anything, so a private key in a sandbox sits in a variable or a file the agent can read [21]. The sandbox token belongs to the account that created it in the dashboard.

Options:

1. **No signature.** Sandbox attestations stay what the service accepted from a token. Then a repo that demands signatures never skips on a sandbox run, and a repo that does not demand them gains nothing.
2. **A key pair for each sandbox token, trusted through the allowed signers file or a variable.** The person generates it, stores the private half in the sandbox's secret setting next to the token, and gets the public half approved in a PR. The service never sees the private half if the key is made on the person's laptop. Unconfirmed: whether the dashboard could make it in the browser instead.
3. **A key pair for each sandbox token, delegated by the creator's GitHub signing key.** On a laptop, `testnotary` signs a short statement with the creator's own key: this sandbox key may attest for repo R until time T. The service stores the statement, and the action checks two signatures, creator to sandbox key, then sandbox key to attestation. It needs no PR and no trust in the service. It needs the creator to have a GitHub signing key and a laptop with the key on it. Early revocation needs the service, and a compromised service could ignore a revocation, though it still could not make new keys. OpenSSH certificates do the same job natively through `cert-authority` [3], at the cost of a certificate parser in the action.
4. **The private key as the sandbox credential.** The library could sign its upload requests with the sandbox key instead of sending a bearer token. That merges the two secrets into one. It does not change who can read it.

The library can sign in a sandbox with `node:crypto` alone, given an Ed25519 key in JWK or PKCS#8 form rather than OpenSSH form. My scratch signer made an `sshsig` signature that `ssh-keygen -Y verify` accepted, and it came to 884 bytes minified, key generation included.

Whatever the option, the agent can read the key and sign anything with it. A signature here guards against the store, not against the agent.

## Checking an sshsig signature in Node

The format is short [1]. The armored blob holds `SSHSIG`, version 1, the public key, the namespace, a reserved string, the hash algorithm and the signature. The signed bytes are `SSHSIG`, the namespace, the reserved string, the hash name and the hash of the message. The hash is `sha256` or `sha512`, and RSA must use `rsa-sha2-256` or `rsa-sha2-512`, never SHA-1 [1]. `ssh-keygen` uses SHA-512 by default [3]. Hardware-backed keys sign a different blob: the SHA-256 of the application string, a flags byte, a counter and the SHA-256 of the message [2].

`node:crypto` has every piece:

- `crypto.createPublicKey` takes a JWK since v15.12.0 [15]. Ed25519 is a JWK `OKP` key, ECDSA an `EC` key and RSA an `RSA` key, so the action converts the SSH wire fields to JWK and never touches ASN.1.
- `crypto.verify` takes a `null` algorithm for Ed25519 and a `dsaEncoding` of `ieee-p1363` for ECDSA, which is the plain `r || s` form that SSH's two integers convert to [15].

What I ran, in a scratch directory with no dependencies, on Node 26.13.0 and OpenSSH 10.5:

- Generated Ed25519, ECDSA P-256, P-384, P-521 and RSA 3072 keys with `ssh-keygen`, signed one JSON message with `ssh-keygen -Y sign -n testnotary-attestation`, and checked it with `ssh-keygen -Y verify` and with my verifier. Both accepted all five.
- My verifier rejected each signature when I added one byte to the message, when I checked under the namespace `git`, and when I offered a different trusted key.
- Size: 102 lines and 5,656 bytes of source, 3,881 bytes after `esbuild --bundle --minify`, 1,613 bytes gzipped.
- Not tested: `sk-ssh-ed25519@openssh.com` and `sk-ecdsa-sha2-nistp256@openssh.com`, for want of a hardware key. The code follows `PROTOCOL.u2f` [2] and demands the user presence flag. Unconfirmed: whether `ssh-keygen -Y verify` demands it too.

My read: the check costs nothing worth weighing in the action bundle. The work is in the tests, chiefly the `sk-` types and malformed input.

## Fetching keys inside the 10-second budget

The action contract gives verification 10 seconds with one retry [22]. A signature check against GitHub's keys needs these calls with `GITHUB_TOKEN`:

1. `GET /user/{account_id}` to turn the signed account id into a login [7]. Logins change, and keying on the id stops a renamed account's old login from pointing at someone else.
2. `GET /users/{login}/ssh_signing_keys` [5].
3. `GET /repos/{owner}/{repo}/collaborators/{login}/permission`, which needs Metadata read [8]. T-793 found that `permission` reads `read` for a user with no access on a public repo, so only `admin` and `write` count [22].

Calls 1 and 2 run in order, and call 3 can run beside call 2. Five calls to the key endpoint took 0.40 to 0.48 seconds each from my machine. Unconfirmed: the latency from a GitHub-hosted runner.

Rate limits:

- `GITHUB_TOKEN` gets 1,000 requests per hour per repository, and 15,000 on GitHub Enterprise Cloud [9]. Every job in the repo shares that budget. The action contract has one verification per job and each matrix leg is its own job [22], so a 20-leg matrix spends about 60 calls per workflow run on signature checks. Ten such runs an hour would use more than half the budget.
- Unauthenticated requests get 60 per hour per IP address [9]. I saw `x-ratelimit-limit: 60` on the key endpoint. Unconfirmed: whether GitHub-hosted runners share outgoing addresses.
- A conditional request with the previous `ETag` got `304 Not Modified` and did not lower my remaining count, while the next full request did. The response carried `Cache-Control: private, max-age=60`. Each job starts on a fresh runner, though, so the action has no earlier `ETag` to send.
- A key file read from the checkout costs no request.

A rate-limited call fails the signature check, so CI runs the tests. The cost is lost skips, not lost safety. The action contract's reason codes would need a new one for this, and for a bad signature. Adding a code is a minor version [22].

## Rotation and deletion

GitHub's endpoint returns the keys an account holds now [5]. It has no deleted keys and no dates beyond `created_at`.

- A key deleted after attesting fails the signature check, and CI runs the tests. Attestations expire after 24 hours, so this costs at most a day of skips for an honest rotation.
- A stolen key that the owner deletes stops working at the next verification. Unconfirmed: whether `max-age=60` means a deleted key can still appear for up to a minute.
- A key added after attesting changes nothing.
- The dashboard's history needs more. A mismatch lists commits skipped since the account's last agreeing audit, and those attestations may be weeks old. The service would have to record, at upload, which key fingerprint signed and whether GitHub listed it then. That record is the service's word again, which is fine for history and not for skipping.

With an allowed signers file, `valid-after` and `valid-before` keep an old key valid for signatures made while it was valid [3] [4]. That needs a trusted signing time, and the time inside an attestation is the signer's own claim. With a 24-hour expiry, deleting the old line works as well.

## Prior art

| Tool | Where the trusted key comes from | How it handles rotation |
| --- | --- | --- |
| `git verify-commit` with `gpg.ssh.allowedSignersFile` | A file outside the repo, or inside it when the repo accepts only signed commits [4] | `valid-after` and `valid-before`. Git counts a signature valid "if the signing key was valid at the time of the signature's creation" [4], and the commit supplies that time itself. |
| `ssh-keygen -Y verify` | An allowed signers file passed with `-f`, plus an optional revocation list with `-r` [3] | The same options, and `-O verify-time` to check at a chosen time [3] |
| GitHub's commit verification | The keys on the account at push time, checked with the `ssh_data` Ruby library [14] | A record stored at push "can't be edited and will persist", so a commit stays verified after the key is rotated or revoked [14] |
| gitsign | No GitHub keys. A Sigstore certificate valid for minutes, logged in Rekor [16] | Rekor's signed timestamp shows the certificate was valid when used [16] [17]. GitHub shows gitsign commits as Unverified [16]. |
| sequoia-git | `openpgp-policy.toml` in the repo, and a trust root commit [18] | A commit is checked against its parent's policy. Users are retired by policy change, and an `audit` right can goodlist a commit signed by a key later revoked [18]. |
| gittuf | Policy in `refs/gittuf/policy`, with root keys taken on first use [19] | Each change is checked against the policy in force when it was made, and entries an attacker signed with a compromised key can be skipped [19] |

I found no tool that checks arbitrary signed data against the keys in `GET /users/{username}/ssh_signing_keys`. GitHub does it for commits, inside its own service.

Two patterns repeat. Every tool takes its trust root from somewhere outside the thing it checks, whether the forge, a file the reviewers own, or a first-use pin. And every tool that survives rotation pins a signing time it trusts, from a push record, a transparency log or the parent commit. Testnotary's 24-hour expiry lets it skip the second problem for skipping, and keep it for history.

## Comparison

| Key source | Developer setup | Sandbox | Calls per signature check | Who could add a false key | After rotation |
| --- | --- | --- | --- | --- | --- |
| GitHub SSH signing keys | None for about 30% of the sample. One command for the rest [20]. | Not available | 2 to 3 [5] [7] [8] | Only the account holder, or a thief of their GitHub session | Old attestations fail and fall back |
| GitHub GPG keys | None for those who have one | Not available | 2 to 3 | Only the account holder | Old attestations fail and fall back |
| Allowed signers file on the base branch | One reviewed PR per key | Works | 0 with a checkout, 1 without | A writer, past a reviewer | `valid-before`, or remove the line |
| Repository variable | A writer sets it [13] | Works | 0 | Any writer, with no review | Edit the variable |
| Delegation signed with the creator's GitHub key | The creator signs once per sandbox key on a laptop | Works | 2 to 3 | Only the creator | The delegation's own expiry |

## My read

The GitHub signing key list is the best trust anchor for laptops. It is the one source a Testnotary compromise cannot touch and a writer cannot fake for someone else. It costs most developers one command, and the check is small.

The sandbox is the hard part. Option 3, a delegation signed with the creator's GitHub key, keeps the service out of the trust path and needs no PR. The allowed signers file is simpler to build and puts a reviewer in front of every key. Either way the key sits where the agent can read it.

Two things decide whether this is worth building in v1. The first is whether the action redoes the tree, repo, suite, time and write checks, since a signature check without them protects little. The second is the demand for signatures. It has to live in the workflow or on the base branch, and a repo that sets it gives up skips for every attester without a key.

## Unconfirmed, needs a live test or a vendor answer

1. Whether `GITHUB_TOKEN` can call `GET /users/{username}/ssh_signing_keys`, `GET /user/{account_id}` and the collaborator permission endpoint under the setup guide's `permissions` block, which sets everything but `id-token` and `checks` to `none` [12].
2. The latency of these calls from a GitHub-hosted runner, and whether hosted runners share outgoing IP addresses for the 60-per-hour unauthenticated limit.
3. Whether a deleted signing key can still appear in the endpoint's response for up to 60 seconds.
4. My verifier's handling of `sk-ssh-ed25519@openssh.com` and `sk-ecdsa-sha2-nistp256@openssh.com` signatures, which needs a hardware key.
5. Whether password manager signing programs set in `gpg.ssh.program` accept a namespace other than `git`.
6. The bundled size of an OpenPGP parser, if GPG keys were ever supported.
7. The size of a pure Node `ssh-agent` client, as an alternative to spawning `ssh-keygen`.
8. Whether a browser can generate an Ed25519 sandbox key in the dashboard so that the service never sees the private half.
9. The fetch depth the setup guide's checkout uses, which decides whether the action can read the base branch's key file from the checkout.

I created no tokens, apps or GitHub keys. The keys in my tests were scratch keys that never left the machine. The sample made only public read calls, and this file reports totals, not accounts.

## Sources

All read on 2026-11-15.

1. OpenSSH, `PROTOCOL.sshsig`. https://github.com/openssh/openssh-portable/blob/master/PROTOCOL.sshsig
2. OpenSSH, `PROTOCOL.u2f`. https://github.com/openssh/openssh-portable/blob/master/PROTOCOL.u2f
3. OpenBSD manual, `ssh-keygen`, sections on `-Y` and ALLOWED SIGNERS. https://man.openbsd.org/ssh-keygen
4. Git manual, `git-config`, entries `gpg.ssh.allowedSignersFile` and `user.signingKey`, read from Git 2.56.0's local manual. https://git-scm.com/docs/git-config
5. GitHub, REST API endpoints for SSH signing keys. https://docs.github.com/en/rest/users/ssh-signing-keys
6. GitHub, REST API endpoints for GPG keys. https://docs.github.com/en/rest/users/gpg-keys
7. GitHub, endpoints available for GitHub App installation access tokens. https://docs.github.com/en/rest/authentication/endpoints-available-for-github-app-installation-access-tokens
8. GitHub, permissions required for GitHub Apps. https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps
9. GitHub, rate limits for the REST API. https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
10. GitHub, `GITHUB_TOKEN`. https://docs.github.com/en/actions/concepts/security/github_token
11. GitHub, use `GITHUB_TOKEN` for authentication in workflows. https://docs.github.com/en/actions/tutorials/authenticate-with-github_token
12. GitHub, workflow syntax, `permissions`. https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax
13. GitHub, store information in variables. https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-variables
14. GitHub, about commit signature verification. https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification
15. Node.js, `crypto`, entries `crypto.createPublicKey` and `crypto.verify`. https://nodejs.org/api/crypto.html
16. sigstore/gitsign, README. https://github.com/sigstore/gitsign
17. Sigstore, security model. https://docs.sigstore.dev/about/security/
18. sequoia-git, README. https://gitlab.com/sequoia-pgp/sequoia-git
19. gittuf, design document. https://github.com/gittuf/gittuf/blob/main/docs/design-document.md
20. GitHub CLI manual, `gh ssh-key add`. https://cli.github.com/manual/gh_ssh-key_add
21. Testnotary research, signing and identity options for attestations, T-770. https://github.com/Daniel88dev/testnotary/blob/research/signing-and-identity/docs/research/signing-and-identity.md
22. Testnotary map, action contract decisions, T-782, and the live test of the App's permissions, T-793. Fenro tasks, not public.

[1]: https://github.com/openssh/openssh-portable/blob/master/PROTOCOL.sshsig
[2]: https://github.com/openssh/openssh-portable/blob/master/PROTOCOL.u2f
[3]: https://man.openbsd.org/ssh-keygen
[4]: https://git-scm.com/docs/git-config
[5]: https://docs.github.com/en/rest/users/ssh-signing-keys
[6]: https://docs.github.com/en/rest/users/gpg-keys
[7]: https://docs.github.com/en/rest/authentication/endpoints-available-for-github-app-installation-access-tokens
[8]: https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps
[9]: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
[10]: https://docs.github.com/en/actions/concepts/security/github_token
[11]: https://docs.github.com/en/actions/tutorials/authenticate-with-github_token
[12]: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax
[13]: https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-variables
[14]: https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification
[15]: https://nodejs.org/api/crypto.html
[16]: https://github.com/sigstore/gitsign
[17]: https://docs.sigstore.dev/about/security/
[18]: https://gitlab.com/sequoia-pgp/sequoia-git
[19]: https://github.com/gittuf/gittuf/blob/main/docs/design-document.md
[20]: https://cli.github.com/manual/gh_ssh-key_add
[21]: https://github.com/Daniel88dev/testnotary/blob/research/signing-and-identity/docs/research/signing-and-identity.md
