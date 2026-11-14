# Signing and identity options for attestations

Research for Fenro task T-770. I read every source on 2026-11-14. The agent products change month to month, and two of the three vendors renamed or moved their docs this year, so check the linked page before building on a claim. Numbers in square brackets point to the source list at the end. A claim marked "unconfirmed" has no primary source behind it yet. A sentence that starts with "My read" is my conclusion from the sources, not a quote of them.

In this file "attestation" means Vouch's own signed record, as in the glossary. I write GitHub's product of a similar name as "GitHub artifact attestation" every time.

## The question

How can a run on a laptop or in a cloud agent sandbox sign its attestation so the service knows which GitHub identity produced it, and what does each option cost the user to set up?

## Short answer

Four options exist. Two fit Vouch and two do not.

1. A token that Vouch issues after GitHub sign-in fits both places a run happens. On a laptop the device flow gives it with one code typed into a browser [1]. A sandbox cannot do that step, so a person creates a token in the dashboard once and stores it in the sandbox's secret setting.
2. A key pair per machine fits laptops. GitHub publishes every user's SSH signing keys and GPG keys to anyone [4] [5], so a developer who already signs commits needs no setup at all. In a sandbox the private key has to sit where the agent can read it, which makes it weaker there than a token.
3. Sigstore keyless signing does not fit. A person needs a browser for every sign-in [12], the public instance accepts no identity that a laptop or a vendor's sandbox holds [11], and each signing writes the signer's email address to a public log that nobody can edit [15] [16].
4. GitHub artifact attestations do not fit. The identity in one comes from a GitHub Actions run [19] [23], and for a private repository GitHub's signing service accepts nothing else [19].

No option stops an agent that holds the credential from sending an attestation for tests it never ran. A signature says which credential made the claim. It says nothing about what happened before the claim. Signing gives Vouch attribution, and the map's audit re-runs have to do the rest.

A sandbox attestation can honestly name the account that delegated the credential, and the fact that the credential is an unattended one. It cannot honestly name a person as the one who ran the tests. Two setups add a statement signed by the vendor, a third may, and I list them below.

## What the three comparison questions mean

The ticket asks for three things about each option.

- Setup effort. What a developer does once on a laptop, and what somebody does once for a sandbox.
- What a stolen credential allows. What a copy of the secret lets a thief do, for how long, and how the owner stops it.
- Whether an agent holding the credential can mint an attestation without running the tests. The agent and the library run as the same operating system user on the same machine, so I ask whether anything other than the agent's own restraint stands between the credential and a made-up pass.

## Option 1: a token issued by the service after GitHub sign-in

### How sign-in works

T-768 settled that the service is a GitHub App. A GitHub App signs a user in with the web flow or the device flow and gets a user access token [1].

The device flow has these steps [1]:

1. The app owner enables the device flow in the app's settings.
2. The library sends `POST https://github.com/login/device/code` with the app's `client_id`.
3. GitHub returns a `device_code`, an eight-character `user_code` and an interval. Both codes expire after 900 seconds by default.
4. The person opens `https://github.com/login/device` on any device and types the `user_code`.
5. The library polls `POST https://github.com/login/oauth/access_token` no faster than the interval, 5 seconds by default, until the person finishes.

The device flow request carries no client secret [1]. A refresh needs the client secret "unless the user access token was generated using the device flow" [2]. So an open-source library can hold the client id alone and still sign in and refresh.

The token starts with `ghu_` and expires after 8 hours by default. The refresh token starts with `ghr_`, lasts 6 months, and works once, because each refresh returns a new pair and kills the old one [1] [2]. The token reaches only what both the user and the app can reach [1]. With it the service calls `GET /user`, which returns the account's `login` and numeric `id` [1] [35].

My read: the library should trade the GitHub token for a Vouch token straight away and never store the GitHub one. The service needs GitHub's answer to "who is this" once. After that, a Vouch token that can do one thing, upload attestations, is a smaller thing to lose than a token that speaks to GitHub's API.

### Setup effort

On a laptop, one command and one code typed into a browser. The person repeats it when the Vouch token expires, on whatever schedule Vouch picks.

In a sandbox the device flow fails as soon as nobody is watching, because step 4 needs a person inside 15 minutes [1]. It does work in an attended session where the agent prints the code and the person types it on a phone. For unattended runs, somebody creates a Vouch token in the dashboard and pastes it into the sandbox's secret setting. The section on sandboxes below shows where that setting is for each vendor.

### What a stolen token allows

A token is a bearer credential. Whoever holds a copy can upload attestations under that identity until the token expires or the owner revokes it. How much damage that is depends on choices Vouch makes when it issues the token: one repository or many, a short life or a long one, upload only or more.

GitHub revokes its own `ghu_` and `ghr_` tokens when one shows up in a public repository or gist, or when somebody reports it through the credential revocation API [3]. That covers GitHub's tokens only. A Vouch token needs Vouch's own revoke button.

### Can an agent mint an attestation without running the tests?

Yes. The agent can read the token from the environment or from the library's config file and call the service's API with any body it likes. Two vendors can keep the token outside the sandbox and attach it to outgoing requests [25] [28]. That stops theft. It does not stop a made-up pass, because the proxy attaches the token to whatever the agent sends to the Vouch host.

## Option 2: a key pair per machine, registered against the GitHub account

There are two ways to do this.

### A key the library generates

The library creates a key pair on first use. The person signs in once, as in option 1, and the library registers the public key with the service under that GitHub account. Every attestation carries a signature from the private key.

Setup effort on a laptop is the same single sign-in as option 1. After it, the laptop holds no token that expires.

The gain over a token is on the service's side. The service stores public keys only, so a leak of its database gives an attacker nothing to sign with. The service also cannot write an attestation in a user's name, and anyone holding the public key can verify one without asking the service. This bears on a point the map lists as not yet specified, how the service defends its own attestation store.

### The signing key the developer already has on GitHub

GitHub verifies commit signatures made with GPG, SSH or S/MIME keys [7]. Two REST endpoints list a user's keys, `GET /users/{username}/ssh_signing_keys` and `GET /users/{username}/gpg_keys`, and the docs say of each that it "is accessible by anyone" [4] [5]. OpenSSH can sign any data with an SSH key through `ssh-keygen -Y sign`, and the required `-n` namespace keeps a signature made for one purpose from passing as another [9].

So the library can sign the attestation with the developer's commit signing key, and the service can verify it against GitHub's public list. Nobody registers anything with Vouch. A developer who signs commits with SSH today has nothing to set up. One who does not has to create a key, add it to GitHub as a signing key and have Git 2.34 or later [8].

Three limits apply.

- GitHub's key list changes. A user can delete a key, and GitHub does not go back and re-verify old commits when a key is revoked or expires. It keeps a verification record from the time of the push [7]. Vouch would have to do the same and record its own result when the attestation arrives.
- A GitHub App can add an SSH signing key for a user if it holds the "SSH signing keys" user permission with write access [6]. My read: Vouch should not ask for it. That permission lets the app add a key that makes commits show as Verified on the user's account, which is far more than Vouch needs.
- The key belongs to a person. It does not belong in a shared sandbox.

### What a stolen key allows

A copied private key signs attestations under that identity until somebody removes the public key. A key has no expiry unless Vouch adds one. If the key is the developer's commit signing key, the thief can also sign commits that GitHub marks Verified [7], so the loss is larger than Vouch.

A FIDO-backed key works only while the hardware authenticator is attached, and the authenticator generally wants a touch for every signature [9]. That protects a laptop. It also means a person has to touch the key for every run, which defeats the point for an agent.

### Can an agent mint an attestation without running the tests?

Yes, on any machine where the agent's process can use the key. That covers a key file with no passphrase and a key loaded in `ssh-agent`, since `ssh-keygen` signs with a key whose private half is in the agent [9]. A touch-required hardware key puts a person in the path, but the person approves a signature without seeing what the tests did.

### Keys in a sandbox

A sandbox proxy can attach a bearer token to a request after it leaves the machine [25] [28]. It cannot sign a payload. So a private key in a sandbox has to be an environment variable or a file that the agent can read. Claude Code keeps "git credentials and signing keys" outside the sandbox [24], so the commit signing key there is out of the library's reach.

My read: in a sandbox a key is weaker than a token held by the vendor's proxy, and no stronger than a token in an environment variable.

## Option 3: Sigstore keyless signing

### How it works

The client creates a key pair in memory and gets an OIDC identity token. Fulcio, Sigstore's certificate authority, issues a certificate valid for 10 minutes that binds the public key to the identity in the token [12] [14]. The client signs, the signing event goes into Rekor, a transparency log, and the client throws the private key away [12].

### Which identities the public instance accepts

Fulcio's public configuration lists these issuers [10] [11]:

| Kind | Issuers | What the certificate carries |
| --- | --- | --- |
| Email | Sigstore's own login service at `oauth2.sigstore.dev`, which offers GitHub, Google and Microsoft sign-in. Also Google accounts and a few others. | The email address |
| CI | GitHub Actions, GitLab, Buildkite, Codefresh, CircleCI, Buddy | A URI for the workflow. For GitHub Actions it is `https://github.com/{job_workflow_ref}`. |
| Kubernetes | Clusters on AKS, GKE and EKS | A URI for the service account |
| Other | Chainguard | Chainguard's own identity |

Two things in the table matter to Vouch.

A person who signs in with GitHub gets a certificate with an email address in it. The Sigstore docs say so directly: "this is the email of the user, not the GitHub username" [10]. The token must carry `email_verified: true` [10]. Vouch would have to map the email back to a GitHub account. A GitHub App can read a user's addresses and their verified flags from `GET /user/emails` with the "Email addresses" user permission [6] [36].

No issuer in the list belongs to Anthropic, OpenAI or any agent sandbox, and none represents a developer's laptop [11].

### Does it work without a browser?

Not for a person. The normal flow opens the issuer's login page. With no browser on the machine, cosign falls back to the device flow, prints a link, and "this link must be opened in a browser to complete the flow" [12]. Signing with no person present works only when the machine already holds a token from an accepted issuer, passed with `--identity-token` or `SIGSTORE_ID_TOKEN` [12]. The JavaScript client has no interactive flow at all. It takes a token from the caller or from GitHub Actions or Buildkite [18].

Of the three sandboxes in this ticket, only one can hold such a token. Copilot, when its session runs on GitHub Actions, can get a GitHub Actions OIDC token in its setup steps [34], and Fulcio accepts that issuer [11]. The certificate would name a workflow, not a person [10].

On a laptop the certificate's 10 minutes [14] rule out signing in once a day. My read: a developer would pass the browser step for every run or small batch of runs. Unconfirmed: whether one identity token can cover several signings inside its own lifetime.

### What gets published

Rekor is append-only and "entries are never mutated or removed" [15]. Cosign's own notice says the email address "will be stored in public transparency logs and cannot be removed later" [16]. Each Vouch attestation would publish the developer's email address next to a record tied to a commit of what may be a private repository. GitHub made the same call for its own product. Its artifact attestations use the public instance for public repositories and a private instance with no transparency log for private ones [19].

Vouch could run its own Fulcio and Rekor [15], or apply to add itself as an issuer on the public one. The second needs proof of "a gap that will be filled" or "significant community interest" [17]. My read: either path rebuilds option 1 or option 2 with more moving parts and no gain for a service that already knows its users through GitHub sign-in.

### What a stolen credential allows

Nothing lasting sits on disk. The signing key lives in memory and Sigstore's services never see it [13]. What a thief can take is the login behind the certificate, meaning the person's GitHub or Google session, or a live identity token. If an identity is compromised, Fulcio "might issue unauthorized certificates", and users "are responsible for monitoring the log" to notice [13].

### Can an agent mint an attestation without running the tests?

Yes. Once the person has signed in, anything running as that user can sign anything while the token and certificate last. In CI the token is ambient, so any step can.

## Option 4: GitHub artifact attestations

### What they are

A workflow creates one with the `actions/attest` action. The job needs `id-token: write` and `attestations: write` [20] [22]. The action mints the workflow's OIDC token, gets a short-lived Sigstore certificate from it, and signs [22]. The result carries a link to the workflow, the repository, the commit SHA and the triggering event [19].

For a public repository the action uses Sigstore's public instance. For a private or internal one it uses GitHub's own instance, which "does not have a transparency log and only federates with GitHub Actions" [19] [22]. Private and internal repositories also need a GitHub Enterprise Cloud plan [22].

### Can anything outside GitHub Actions produce one?

Not one that carries a GitHub-backed identity. I found no documented path.

- For private repositories GitHub's signing service accepts only GitHub Actions tokens [19]. A laptop cannot get a certificate from it.
- A REST endpoint, `POST /repos/{owner}/{repo}/attestations`, stores a Sigstore bundle against a repository. It needs write access and `attestations: write`, and a GitHub App can call it with a user or an installation token [6] [21]. The same page says "Artifact attestations are meant to be created using the attest action" [21]. Unconfirmed: whether the endpoint rejects a bundle signed outside GitHub Actions.
- Even if it stores one, the identity inside that bundle comes from whoever signed it, which is option 3 again. GitHub's verifier, `gh attestation verify`, expects the certificate's issuer to be `https://token.actions.githubusercontent.com` by default and checks the source repository and signer workflow from the certificate [23].
- These attestations describe a build artifact by its digest [19] [21]. A test run has no artifact.

Copilot on GitHub Actions is the one sandbox that runs inside a workflow job [33] [37]. Its setup steps run before the agent starts work, so a setup step cannot attest tests the agent runs later.

GitHub's own caveat fits this whole file. Artifact attestations are "not a guarantee that an artifact is secure" [19]. They say where something was built.

## How cloud agent sandboxes receive credentials

### Claude Code cloud sessions

Each session runs in its own virtual machine that Anthropic manages [24].

| Channel | How it works | Who can read the value |
| --- | --- | --- |
| GitHub access | The person authorizes the Claude GitHub App, or sends their local `gh` token with `/web-setup`. The credential stays on Anthropic's servers. A proxy swaps a scoped credential from the machine for the real token [24] [25] [26]. | Nobody in the session. `GH_TOKEN` reads as the placeholder `proxy-injected` [25]. |
| Environment variables | `KEY=value` lines saved on the cloud environment [25]. | Any command the agent runs. "Anyone who uses the environment can read the values" [25]. |
| Network secrets | A key saved on the environment with a list of hosts. Anthropic's proxy adds it to requests for those hosts after each request leaves the machine [25]. | Nobody. The value cannot be viewed again after saving and never appears in the machine's variables or files [25]. |

Details that affect Vouch:

- A network secret reaches its hosts even when the environment's network level would block them. It "applies in every session that runs in the environment, whoever started it", and the proxy does not attach it to requests the setup script makes [25].
- A new environment starts with Limited network access and an allowlist. The owner can add domains [25].
- The setup script runs before the session sets the environment's variables [25]. A SessionStart hook from the repository's `.claude/settings.json` runs after Claude Code starts, in cloud and local sessions alike [25].
- The session can read `CLAUDE_CODE_REMOTE`, set to `true`, and its own id in `CLAUDE_CODE_REMOTE_SESSION_ID`. Commits made in a session carry a `Claude-Session: <url>` trailer [25]. These are plain values that any process can copy or invent.
- The GitHub proxy serves only the repositories attached to the session, rejects GraphQL, and rejects pushes of anything that is not a branch [25]. Replies to review comments "are posted using your GitHub account" [24]. So GitHub sees the person's account, not a bot.

Session identity signed by the vendor exists in one setup only. In a self-hosted environment, a public beta on Team and Enterprise plans, every session gets a JWT in `CLAUDE_CODE_SESSION_ACCESS_TOKEN`. Anthropic signs it with ES256 and publishes the keys at `https://api.anthropic.com/v1/code/.well-known/jwks.json` [27]. The claims name the session, the Anthropic organization, the environment, and the creator in `act.sub` as `user:<id>` or `agent:<id>`. The token lasts four hours by default and Anthropic publishes no revocation feed [27]. The docs spell out its limit: it "doesn't prove" which process presents it, because any code the agent runs can read it [27].

Three cautions before Vouch accepts that token. Its audience is the customer's environment id plus `anthropic-api`, not a value Vouch chooses, so a customer would have to register its environment id with Vouch [27]. The creator is an Anthropic user id, and the email claim is optional, so it does not name a GitHub account [27]. And the docs describe it for "services on your network" [27]. Unconfirmed: what a token with the audience `anthropic-api` lets an outside holder do.

Sessions on Anthropic's own infrastructure get a token with the prefix `sk-ant-si-`, "signed by a different key set", and the docs tell verifiers to reject it [27]. I found no documented way for a third party to verify an Anthropic-hosted session.

### Codex cloud

OpenAI's docs moved to `learn.chatgpt.com` and split in two. The page titled "Codex Cloud (Legacy)" now covers environments for code review and the Linear and GitHub integrations, and "Cloud environments" covers the current product [28] [29].

| Channel | How it works | Who can read the value |
| --- | --- | --- |
| Environment variables | "Passed directly to programs in the environment" [28]. | Any program in the task. |
| Network secrets | "Programs receive a placeholder; the proxy substitutes the real value for allowed destinations". It works for HTTPS on port 443, during setup and during tasks [28]. | Nobody in the task. |
| Personal vault | A shared environment can ask for values that each person supplies from their own account [28]. | Depends on whether the value is a variable or a network secret. |
| Legacy secrets | "Only available to setup scripts" and "removed before the agent phase starts" [29]. | The setup script only. |
| OIDC | "OpenID Connect (OIDC) lets a task obtain short-lived credentials for cloud resources". The customer configures trust with the provider from an Issuer, an Audience and a Subject that the settings page displays [28]. | Not stated. |

Details that affect Vouch:

- "By default, Codex blocks internet access during the agent phase" [30]. The owner can turn it on with a domain allowlist and a list of allowed HTTP methods, and the recommended list is `GET`, `HEAD` and `OPTIONS` [30]. The current environments page describes the same choice as full access or an allowlist of package managers and extra domains [28]. An upload to Vouch is a `POST`, so the environment has to allow the Vouch host and that method.
- The OIDC feature lists AWS, Google Cloud and Azure as supported providers and says "only supported connections can be attached" [28]. Unconfirmed: whether a service like Vouch can act as the relying party, what the issuer URL and claims are, and whether the token names the person who started the task.
- Unconfirmed: which GitHub identity pushes a task's branch or opens its pull request. The pages I read do not say [28] [31]. Review comments come from a bot account, `chatgpt-codex-connector` [31].

### Copilot cloud agent

GitHub's docs now call the Copilot coding agent "Copilot cloud agent". A session runs in one of two places. A cloud sandbox is a Linux environment that GitHub hosts, and it is the default on most surfaces. The other is a GitHub Actions job on a runner [33] [37].

| Channel | How it works | Who can read the value |
| --- | --- | --- |
| Agents secrets and variables | Set under Settings, Secrets and variables, Agents, for a repository by its admins or for an organization by its owners. Copilot gets them as environment variables. A cloud sandbox gets secrets only [38]. | Any command the agent runs. Session logs mask secret values [38]. |
| Other GitHub secrets | Copilot "does not have access to GitHub Actions, Codespaces, or Dependabot secrets and variables" [38]. | Not available. |
| GitHub Actions OIDC | In a session on GitHub Actions, the `copilot-setup-steps` job can set `permissions`. GitHub's own Azure example sets `id-token: write` there and signs in to Azure with OIDC [33] [34]. It "doesn't apply to sessions that run in a cloud sandbox" [34]. | The setup steps. |

Details that affect Vouch:

- A firewall limits the agent's internet access by default. Repository admins and organization owners add hosts to a custom allowlist. The firewall covers processes the agent starts through its Bash tool and does not cover the setup steps [39].
- Copilot pushes to one branch, either the pull request it was asked to work on or a new `copilot/` branch. It cannot run `git push` itself [32].
- "Commits are authored by Copilot", the developer who assigned the work is credited as co-author, the commits are signed and show as Verified, and each commit message links to the session logs [32].
- By default, workflows do not run on Copilot's pull requests until a user with write access approves them [32]. On those repositories CI already waits for a person.

The OIDC path is the interesting one. T-768 found that a job with `id-token: write` gets a token signed by GitHub that names the repository, the workflow and the run [40]. A setup step could trade that token for a short-lived Vouch token bound to the repository and the run, with no stored secret. Unconfirmed: the value of the `actor` claim in such a session, and whether the agent's own processes, started after the setup steps, can still request a token.

## What identity a sandbox attestation can honestly carry

The service can know four different things, and they are not equally solid.

1. Who delegated the credential. When a person creates a Vouch token in the dashboard, the service knows which GitHub account did it. That is a fact the service saw first-hand. It says nothing about who or what used the token later. In a shared Claude Code environment "anyone who uses the environment can read the values" and a network secret applies "whoever started" the session [25]. Copilot's Agents secrets belong to a repository or an organization, never to a person [38]. So for a shared sandbox the honest subject is the repository or the environment, plus the account that set it up.
2. That the credential is an unattended one. Vouch decides the token's kind when it issues it, so "sandbox token" is also first-hand.
3. A statement the vendor signed, where one exists. Today that is Copilot on GitHub Actions through GitHub's OIDC token [34] [40], and Claude Code in a self-hosted environment through the session token [27]. Codex may be a third, unconfirmed [28]. Each names a repository, a run or a session. None names a GitHub user as the one at the keyboard, and the Claude token names an Anthropic account [27].
4. Labels the run reports about itself: a session id, a vendor name, a session URL. They help a person trace a result back to a transcript. They prove nothing, because the agent writes them.

So an honest sandbox attestation reads like this: "uploaded with a sandbox token that account A created for repository R, from a session that reports itself as S". It should never read "A ran the tests". The dashboard and the audit sampling should treat the first two parts as verified and the session label as a claim.

A laptop attestation after a device flow sign-in is stronger on the person and no stronger on the tests. The service knows that somebody who could sign in as A, on some device, approved a code that this machine asked for [1].

## Comparison

| Option | Setup on a laptop | Setup for a sandbox | What a stolen credential allows | Can an agent mint an attestation without running the tests? |
| --- | --- | --- | --- | --- |
| Token from the service after GitHub sign-in | One command, one code typed in a browser [1] | A person creates a token in the dashboard and stores it in the vendor's secret setting. Also the Vouch host on the network allowlist [25] [30] [39]. | Uploads under that identity until expiry or revocation. Vouch sets the scope and the lifetime. | Yes |
| The same token held by the vendor's proxy as a network secret | Not applicable | As above, on Claude Code and Codex only [25] [28] | Nothing to steal from inside the sandbox | Yes. The proxy signs nothing and attaches the token to any request for the Vouch host. |
| Key pair the library generates | One sign-in to register the public key | The private key goes into a variable or a file | Signatures under that identity until the key is removed. The service holds nothing an attacker can sign with. | Yes, wherever the agent can read or use the key |
| The developer's SSH or GPG signing key from GitHub | Nothing, for developers who already sign commits [4] [5]. Otherwise create a key and add it to GitHub [8]. | Not suitable. The key belongs to a person. | Vouch signatures and Verified commits on GitHub [7] | Yes with a key file or `ssh-agent` [9]. A touch-required hardware key puts a person in the path. |
| Sigstore keyless, public instance | A browser sign-in for each run or small batch [12] [14] | Only Copilot on GitHub Actions holds an accepted token [11] [34] | The login session behind the certificate. The signer's email is public for good [15] [16]. | Yes, while the sign-in lasts |
| GitHub artifact attestation | Not available outside GitHub Actions [19] [23] | Not available outside GitHub Actions | Not applicable | Not applicable |
| Token exchanged for a vendor-signed session token | Not applicable | A setup step and no stored secret, on Copilot with GitHub Actions [34]. A registered environment id on Claude Code self-hosted [27]. | A token that lasts minutes to hours and names one repository or session | Yes. Any process in the session can present the token [27] [40]. |

Every row says yes in the last column. The vendors say the same thing about their own tokens. Anthropic writes that its session token does not prove which process presents it [27]. T-768 recorded that GitHub's OIDC token is a bearer token any step in the job can request [40]. GitHub writes that an artifact attestation is no guarantee about the artifact [19].

## My read

Use a Vouch token for both places, and sign in with the device flow on laptops. It is the only option that works the same way on a laptop and in all three sandboxes, and it costs a developer one code.

For sandboxes, make the token narrow. One repository, upload only, shown in the dashboard with the account that created it and a revoke button. Tell users to store it as a network secret on Claude Code and Codex, where the agent can use it and cannot read it, and as an Agents secret on Copilot.

Treat the key pair as a second step with a real payoff. Client-side signatures mean the service cannot forge an attestation and a database leak cannot either. That belongs in the trust model ticket, because it answers part of the open point about the service's own store. Reusing GitHub's public signing keys is the cheapest version for developers who already sign commits.

Leave Sigstore's public instance and GitHub artifact attestations out. The first needs a browser and publishes emails. The second only speaks for GitHub Actions.

Do not expect any of this to block a faked pass. Identity makes a pass attributable. What a run records, and how often CI re-runs a sampled commit, decide whether a faked one gets caught.

## Unconfirmed, needs a live test or a vendor answer

1. Whether `POST /repos/{owner}/{repo}/attestations` accepts a Sigstore bundle that was not signed through GitHub Actions.
2. In a Copilot session on GitHub Actions, the value of the OIDC token's `actor` claim, and whether processes the agent starts after the setup steps can request a token.
3. For Codex, the OIDC issuer URL, the claims, whether a custom relying party is allowed, and whether the token names the person who started the task.
4. Whether any third party can verify the `sk-ant-si-` token of an Anthropic-hosted Claude Code session.
5. What a Claude Code self-hosted session token, whose audience includes `anthropic-api`, lets an outside service do if it receives one.
6. Whether Claude Code's proxy attaches a network secret to a request made by a SessionStart hook. The docs exclude setup script requests only [25].
7. The git author name and email on commits from a Claude Code cloud session and from a Codex cloud task.
8. Whether one Sigstore identity token can cover several signings inside its lifetime.

The ticket was reading only. I created no keys, tokens, apps or accounts and ran none of these.

## Sources

All read on 2026-11-14.

1. Generating a user access token for a GitHub App. https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app
2. Refreshing user access tokens. https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens
3. Token expiration and revocation. https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/token-expiration-and-revocation
4. REST API endpoints for SSH signing keys. https://docs.github.com/en/rest/users/ssh-signing-keys
5. REST API endpoints for GPG keys. https://docs.github.com/en/rest/users/gpg-keys
6. Permissions required for GitHub Apps. https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps
7. About commit signature verification. https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification
8. Telling Git about your signing key. https://docs.github.com/en/authentication/managing-commit-signature-verification/telling-git-about-your-signing-key
9. OpenBSD manual, `ssh-keygen`. https://man.openbsd.org/ssh-keygen
10. Sigstore, OIDC usage in Fulcio. https://docs.sigstore.dev/certificate_authority/oidc-in-fulcio/
11. sigstore/fulcio, identity configuration of the public instance. https://github.com/sigstore/fulcio/blob/main/config/identity/config.yaml
12. Sigstore, signing overview. https://docs.sigstore.dev/cosign/signing/overview/
13. Sigstore, security model. https://docs.sigstore.dev/about/security/
14. Sigstore, Fulcio overview. https://docs.sigstore.dev/certificate_authority/overview/
15. Sigstore, Rekor overview. https://docs.sigstore.dev/logging/overview/
16. sigstore/cosign, the privacy statement cosign prints before signing. https://github.com/sigstore/cosign/blob/main/cmd/cosign/cli/sign/privacy/privacy.go
17. sigstore/fulcio, requirements for a new identity provider. https://github.com/sigstore/fulcio/blob/main/docs/new-idp-requirements.md
18. sigstore/sigstore-js, client README. https://github.com/sigstore/sigstore-js/blob/main/packages/client/README.md
19. GitHub, artifact attestations. https://docs.github.com/en/actions/concepts/security/artifact-attestations
20. GitHub, using artifact attestations to establish provenance for builds. https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations
21. REST API endpoints for artifact attestations. https://docs.github.com/en/rest/repos/attestations
22. actions/attest, README. https://github.com/actions/attest
23. GitHub CLI manual, `gh attestation verify`. https://cli.github.com/manual/gh_attestation_verify
24. Claude Code, use Claude Code in the cloud. https://code.claude.com/docs/en/claude-code-on-the-web
25. Claude Code, configure cloud environments. https://code.claude.com/docs/en/cloud-environments
26. Claude Code, get started with Claude Code in the cloud. https://code.claude.com/docs/en/web-quickstart
27. Claude Code, verify session identity in self-hosted environments. https://code.claude.com/docs/en/self-hosted-environments-identity
28. OpenAI, Codex cloud environments. https://learn.chatgpt.com/docs/environments/cloud-environments
29. OpenAI, Codex Cloud (Legacy). https://learn.chatgpt.com/docs/environments/cloud-environment
30. OpenAI, Codex agent internet access. https://learn.chatgpt.com/docs/cloud/internet-access
31. OpenAI, Codex GitHub integration. https://learn.chatgpt.com/docs/third-party/github
32. GitHub, risks and mitigations for Copilot cloud agent. https://docs.github.com/en/copilot/concepts/agents/cloud-agent/risks-and-mitigations
33. GitHub, configure the development environment for agents on GitHub Actions. https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/customize-the-agent-environment
34. GitHub, configure MCP servers for your repository. https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/configure-mcp-servers
35. REST API endpoints for users. https://docs.github.com/en/rest/users/users
36. REST API endpoints for emails. https://docs.github.com/en/rest/users/emails
37. GitHub, about cloud sandboxes for GitHub Copilot. https://docs.github.com/en/copilot/concepts/security-governance-and-network-settings/about-cloud-sandboxes
38. GitHub, configure secrets and variables for Copilot cloud agent. https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/configure-secrets-and-variables
39. GitHub, customize the agent firewall. https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/customize-the-agent-firewall
40. Vouch research, how a GitHub workflow can skip its test job safely, T-768. https://github.com/Daniel88dev/vouch/blob/research/ci-skip-mechanics/docs/research/ci-skip-mechanics.md

[1]: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app
[2]: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens
[3]: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/token-expiration-and-revocation
[4]: https://docs.github.com/en/rest/users/ssh-signing-keys
[5]: https://docs.github.com/en/rest/users/gpg-keys
[6]: https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps
[7]: https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification
[8]: https://docs.github.com/en/authentication/managing-commit-signature-verification/telling-git-about-your-signing-key
[9]: https://man.openbsd.org/ssh-keygen
[10]: https://docs.sigstore.dev/certificate_authority/oidc-in-fulcio/
[11]: https://github.com/sigstore/fulcio/blob/main/config/identity/config.yaml
[12]: https://docs.sigstore.dev/cosign/signing/overview/
[13]: https://docs.sigstore.dev/about/security/
[14]: https://docs.sigstore.dev/certificate_authority/overview/
[15]: https://docs.sigstore.dev/logging/overview/
[16]: https://github.com/sigstore/cosign/blob/main/cmd/cosign/cli/sign/privacy/privacy.go
[17]: https://github.com/sigstore/fulcio/blob/main/docs/new-idp-requirements.md
[18]: https://github.com/sigstore/sigstore-js/blob/main/packages/client/README.md
[19]: https://docs.github.com/en/actions/concepts/security/artifact-attestations
[20]: https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations
[21]: https://docs.github.com/en/rest/repos/attestations
[22]: https://github.com/actions/attest
[23]: https://cli.github.com/manual/gh_attestation_verify
[24]: https://code.claude.com/docs/en/claude-code-on-the-web
[25]: https://code.claude.com/docs/en/cloud-environments
[26]: https://code.claude.com/docs/en/web-quickstart
[27]: https://code.claude.com/docs/en/self-hosted-environments-identity
[28]: https://learn.chatgpt.com/docs/environments/cloud-environments
[29]: https://learn.chatgpt.com/docs/environments/cloud-environment
[30]: https://learn.chatgpt.com/docs/cloud/internet-access
[31]: https://learn.chatgpt.com/docs/third-party/github
[32]: https://docs.github.com/en/copilot/concepts/agents/cloud-agent/risks-and-mitigations
[33]: https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/customize-the-agent-environment
[34]: https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/configure-mcp-servers
[35]: https://docs.github.com/en/rest/users/users
[36]: https://docs.github.com/en/rest/users/emails
[37]: https://docs.github.com/en/copilot/concepts/security-governance-and-network-settings/about-cloud-sandboxes
[38]: https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/configure-secrets-and-variables
[39]: https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/customize-the-agent-firewall
[40]: https://github.com/Daniel88dev/vouch/blob/research/ci-skip-mechanics/docs/research/ci-skip-mechanics.md
