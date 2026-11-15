# GitHub Enterprise Cloud OIDC issuers

Research for Fenro task T-799. I read every source and fetched every live document on 2026-11-15. Numbers in square brackets point to the source list at the end. A claim marked "unconfirmed" has no primary source behind it yet. A sentence that starts with "My read" is my conclusion from the sources, not a quote of them.

## The question

Which issuer URLs can a GitHub Actions OIDC token carry for a GitHub Enterprise Cloud customer, and what would the service need to accept each?

The action contract (T-782) has the action prove itself with the Actions OIDC token only, and the service checks `iss` among other claims. The live test (T-787) used `https://token.actions.githubusercontent.com`.

## Short answer

A token from GitHub Actions carries one of three issuer forms.

| Where the repo lives | `iss` | Signing keys |
| --- | --- | --- |
| github.com, the default | `https://token.actions.githubusercontent.com` | `https://token.actions.githubusercontent.com/.well-known/jwks` |
| github.com, enterprise with the custom issuer on | `https://token.actions.githubusercontent.com/<enterprise-slug>` | the same JWKS as the default, checked live |
| GHE.com (data residency) | `https://token.actions.<subdomain>.ghe.com`, or `.../<subdomain>` with the custom issuer on | on the tenant's own host, location unconfirmed |

1. **The enterprise issuer costs little to accept.** An enterprise admin turns it on through one REST call [1] [2]. After that, every token from the enterprise's repos carries the new `iss` [1]. I found no way for a workflow to ask for the default issuer instead. The docs name no other claim that changes, and the live discovery document for a slug points at the same JWKS as the default [4]. A service that accepts only the exact default issuer rejects every token from such an enterprise.
2. **Accepting a pattern is safe if two rules hold.** The match is anchored and allows one path segment after the default host. The keys come from the one fixed JWKS URL, never from discovery on the token's own `iss`. GitHub's host answers discovery for any slug, real or not [4], so the slug proves nothing by itself. What ties a token to a customer is still `repository_id` belonging to an installation. Fulcio accepts the same pattern and shipped a CVE when its pattern was unanchored [25] [26] [27].
3. **GHE.com is a separate GitHub.** Accounts there are Enterprise Managed Users only, the API sits at `api.<subdomain>.ghe.com`, there are no public repos and no Marketplace [5] [6]. A tenant's `GITHUB_TOKEN` cannot reach github.com [5]. Supporting a tenant means a GitHub App registered on that tenant, the device flow on that host, keys from that tenant's issuer, and every account and repo ID stored with its host. SonarQube Cloud has each customer register an App on their own tenant [12]. I could not fetch a real tenant's discovery document, because I know no tenant name that resolves.
4. **Enterprise Managed Users on github.com change no issuer and no permission rule.** Two enterprise settings can still break the service. A GitHub IP allow list blocks installation tokens and user tokens from addresses it does not list, unless the App publishes its addresses and the enterprise opts in [16] [17]. An Entra conditional access policy checks the App server's address on user-token calls, such as `GET /user` at sign-in, but lets installation-token calls through [15].
5. **Every cloud provider pins one exact issuer per trust.** AWS, Azure, GCP and Vault each take the issuer the customer types in, so an enterprise with the custom issuer types the slug form [18] [21] [22] [23]. None of them accepts a pattern. Sigstore's Fulcio and Teleport do support the slug form, Fulcio by pattern and Teleport by a configured slug [25] [28]. npm's trusted publishing docs say nothing about enterprise issuers or GHE.com [24].

## The enterprise-specific issuer on github.com

### Who turns it on

GitHub's OIDC reference says enterprise administrators "can configure their enterprise to receive tokens from a unique URL at `https://token.actions.githubusercontent.com/<enterpriseSlug>`" [1]. The admin calls `PUT /enterprises/{enterprise}/actions/oidc/customization/issuer` with `{"include_enterprise_slug": true}` [1] [2]. The endpoint needs an OAuth app token or a classic personal access token with `admin:enterprise`, and the fine-grained "Enterprise administration" permission does not work for it [2].

The REST reference lists only `PUT` for this setting. There is no `GET` [2]. The endpoint is absent from the github.com (Free, Pro, Team) REST reference, so only GitHub Enterprise Cloud has it [3].

My read: Testnotary cannot ask GitHub whether an enterprise turned the setting on. It learns from the first token that arrives with a slug.

### What changes in the token

"After this setting is applied, the JWT will contain the updated `iss` value" [1]. GitHub's example token shows `iss` as `https://token.actions.githubusercontent.com/octocat-inc` next to `enterprise: octocat-inc` and `enterprise_id: 123` [1]. The docs name no other claim that changes. `enterprise` and `enterprise_id` are ordinary claims that any repo in an enterprise carries, with or without the setting [1].

Whether the slug in `iss` always equals the `enterprise` claim is unconfirmed. The docs describe `enterprise` as "the name of the enterprise" [1], and the only example has both equal.

The live discovery document lists a claim `issuer_scope` [4]. No GitHub doc I found describes it, so its meaning is unconfirmed.

### Whether the default issuer still works

The docs say the enterprise "will receive the OIDC token from a unique URL", so that a cloud provider can "only accept tokens from that URL" [1]. The setting sits on the enterprise, with no per-organization or per-workflow form in the REST reference [2]. The toolkit call that fetches a token takes only an audience [1].

My read: once the setting is on, no workflow in that enterprise can get a token with the default `iss`. That is the point of the feature, since a cloud role that trusts the slug issuer would be worthless if another workflow could still use the shared one. I found no source that says so in as many words, so treat it as unconfirmed until a live test with an enterprise account.

### Where its keys live

I fetched the discovery documents on 2026-11-15 [4]:

- `https://token.actions.githubusercontent.com/.well-known/openid-configuration` returns `issuer: https://token.actions.githubusercontent.com` and `jwks_uri: https://token.actions.githubusercontent.com/.well-known/jwks`.
- `https://token.actions.githubusercontent.com/github/.well-known/openid-configuration` and `.../octo-inc/...` return the slug as `issuer` and the same root `jwks_uri`.
- A made-up slug, `.../thisslugdoesnotexist-zz9q/.well-known/openid-configuration`, also returns 200, with that slug as `issuer` and the same `jwks_uri`.
- `https://token.actions.githubusercontent.com/octo-inc/.well-known/jwks` returns 404.

So every slug issuer shares the default issuer's keys. A library that runs OIDC discovery on the slug issuer finds them. A library that appends `/.well-known/jwks` to the slug issuer gets a 404.

## GitHub Enterprise Cloud with data residency (GHE.com)

### Issuer and keys

On GHE.com, "your provider's expected claim must substitute `githubusercontent.com` with `SUBDOMAIN.ghe.com`" [1]. For a subdomain `octocorp`:

- discovery is at `https://token.actions.octocorp.ghe.com/.well-known/openid-configuration`,
- `iss` is `https://token.actions.octocorp.ghe.com`,
- with the custom issuer on, tokens come from `https://token.actions.octocorp.ghe.com/octocorp`, and the REST path is `/enterprises/octocorp/actions/oidc/customization/issuer` [1].

The feature overview lists the same issuer host in its table of URL differences [5]. The network details page lists `*.actions.SUBDOMAIN.ghe.com` among the hosts a client must reach [7].

Unconfirmed: what `jwks_uri` a GHE.com discovery document names, and whether a tenant's keys differ from github.com's and from other tenants'. `octocorp` does not resolve, and I know no real tenant to fetch. Commit signing keys do differ by deployment and by GHE.com region [31], which hints that Actions keys may too.

### Accounts, API and Apps

Enterprises on GHE.com use Enterprise Managed Users only, and public repositories do not exist there [6]. Integrators "must send requests to your enterprise's dedicated URL", such as `https://api.octocorp.ghe.com` [6]. A `GITHUB_TOKEN` in a GHE.com run "does not grant access to resources on GitHub.com" [5]. GitHub Marketplace is unavailable [5] [9]. GitHub Enterprise Importer does not move GitHub Apps or their installations between products [31].

The docs on GitHub Apps say "On GitHub.com you can install public apps from any developer" [9]. No GitHub page I found says in plain words that an App registered on github.com cannot be installed on a GHE.com tenant, so that exact claim is unconfirmed. Everything around it points one way. The tenant has its own accounts, its own API host and its own App settings pages. SonarQube Cloud, which runs a github.com App for github.com customers, asks a GHE.com customer to create a GitHub App inside their GHE.com organization and hand over its App ID, private key, installation ID and webhook secret [12].

The device flow docs say their examples use `github.com` and that "you might access GitHub at a different domain, such as `octocorp.ghe.com`" [11] [32]. My read: the device flow runs at `https://<subdomain>.ghe.com/login/device` with the client ID of an App registered on that tenant, and a token from it reaches only that tenant.

Actions from github.com do run on GHE.com. GitHub Actions "searches your enterprise on GHE.com for each action before falling back to GitHub.com", and retires the action's namespace in the enterprise after first use [8]. So `uses: Daniel88dev/testnotary@v1` resolves from a GHE.com workflow, subject to the enterprise's own allowed-actions policy. GitHub also warns that actions which call `api.github.com` "don't currently work" on GHE.com [5]. The Testnotary action calls only the Testnotary service, so that warning does not bite.

### What the service would need per tenant

My read, from the sources above:

1. A GitHub App registered on the tenant. Either Testnotary registers one per tenant, or the customer does and hands over its credentials, as with SonarQube Cloud [12]. Apps owned by an enterprise are "internal" and install only on that enterprise [10].
2. The device flow pointed at the tenant's host with that App's client ID, so the library needs to know which host to sign in to.
3. The tenant's issuer added to an allowlist, with keys from that tenant's discovery document.
4. API calls (collaborator permission, compare, contents) sent to `api.<subdomain>.ghe.com` with that App's installation token.
5. Every account ID and repository ID stored with its host. Whether GHE.com IDs can collide with github.com IDs is unconfirmed. Keying by host makes the question moot.

## Telling a genuine issuer from a fake one

On github.com the threat is a token whose `iss` merely looks like GitHub's. Three known failure modes:

- **An unanchored or loose pattern.** Fulcio's `metaRegex()` once compiled every meta-issuer pattern without `^` and `$`, its GitHub slug pattern among them. In the advisory's example, an `iss` of `https://attacker.com/x/https://oidc.eks.foo.amazonaws.com/id/bar` matched the EKS pattern, and Fulcio then fetched discovery from the attacker's URL [27]. The fix, CVE-2026-22772 in Fulcio 1.8.5, anchors the pattern and keeps `*` to `[-_a-zA-Z0-9]+`, one path segment [26] [27].
- **Keys fetched from the token's own issuer.** Fulcio runs `oidc.NewProvider` on the matched issuer URL [26], which is what turned the regex bug into a server-side request forgery [27]. A service that takes its keys from one fixed JWKS URL cannot be pointed elsewhere by a token.
- **Trusting the slug as proof of an enterprise.** GitHub's discovery answers for a slug that does not exist [4]. A slug in `iss` says only that GitHub signed the token. It does not prove that the enterprise turned the setting on, or that the enterprise owns the repo Testnotary serves.

My read on a safe rule for github.com: accept `iss` equal to `https://token.actions.githubusercontent.com`, or to that string plus `/` and one segment of `[A-Za-z0-9_-]+`, anchored at both ends. Verify the signature with keys from `https://token.actions.githubusercontent.com/.well-known/jwks`, and only those keys. Then authorize exactly as today, by `repository_id` and its installation. The slug adds nothing to authorize on. AWS calls the default issuer a "shared" provider, whose tenancy travels "through claims in JWT" [19]. Testnotary already reads tenancy from `repository_id`.

Two optional checks the grilling ticket can weigh:

- Require the slug to equal the `enterprise` claim. This costs nothing if they always match, which is unconfirmed.
- Remember the issuer an installation used last, and flag a change. That catches nothing a forger could do, since a forger cannot sign, but it explains a burst of fallbacks after an admin flips the setting.

For GHE.com the threat differs. Any company can buy a tenant and so control `token.actions.<their-subdomain>.ghe.com` tokens for their own repos. A wildcard on `*.ghe.com` with keys from each token's own host would accept tokens from tenants Testnotary has no App on. My read: accept a GHE.com issuer only from an explicit list of tenants where Testnotary's App is registered, take keys from each listed tenant's discovery once, and key every lookup by host.

## Enterprise Managed Users on github.com

Managed user accounts on github.com run Actions and receive the same tokens. Nothing in the docs ties EMU to the issuer [1].

**Device-flow sign-in.** Managed users "cannot install GitHub Apps on their user accounts, unless the app is a privileged app" [13]. The restriction is on installing. Signing in to a public App is authorizing, and I found no rule against it for managed users. That they can authorize Testnotary's App is still unconfirmed until someone tries.

A conditional access policy matters more. For an EMU enterprise using OIDC with Entra ID, "when GitHub Apps and OAuth apps sign a user in and make requests on that user's behalf, GitHub will send the IP address of the app's server to your IdP for validation" [15]. The Testnotary service calls `GET /user` with the user's token once after the device flow. That call fails unless the IdP allows the service's addresses or the enterprise ticks "Skip IdP check for applications" [15] [16]. Calls an App makes "as an installation" are "always allowed through" [15].

**The collaborator-permission check.** It runs on the installation token, so conditional access does not touch it [15]. A GitHub IP allow list does. It restricts "GitHub App user-to-server or installation tokens" [16]. A third-party App is denied unless its creator lists the addresses it runs from and the owner enables "IP allow list configuration for installed GitHub Apps" [16] [17]. This applies to any enterprise or organization with an allow list, managed users or not. Under EMU with OIDC the inherited App list works only with GitHub's own allow list, not the IdP's [16].

My read: an enterprise with an IP allow list needs Testnotary's service to have fixed outbound addresses. On App Runner that takes a VPC connector and a NAT gateway, since a connected service otherwise "can't access the public internet" [29].

**Usernames.** On github.com, GitHub adds "an underscore and your enterprise's shortcode" to every managed username [14]. The permission call takes the login and works the same. Testnotary already keys accounts by numeric ID.

**Repo visibility.** Managed users contribute only to private and internal repos [13]. The `admin`-or-`write` rule from T-793 still holds. An internal repo gives every enterprise member read, which the rule already rejects.

## How other relying parties handle these issuers

| Relying party | Issuer setting | Enterprise slug | GHE.com |
| --- | --- | --- | --- |
| AWS IAM | One OIDC provider per exact URL. Condition keys are prefixed with the provider URL, path included, as in `studio.datachain.ai/api:sub` [18] [19] | Not mentioned. The customer creates a provider for the slug URL. GitHub's AWS guide shows only the default [20] | GitHub's guide says to substitute the GHE.com values [20] |
| AWS shared-provider rule | The default GitHub issuer is "shared", so IAM refuses a trust policy without a `sub` or `job_workflow_ref` condition [19] | A slug issuer is not in AWS's list, so the rule does not apply to it (my read) | Not in the list |
| Microsoft Entra | `issuer` "must match the `issuer` claim", no wildcards, keys fetched by discovery from the issuer URL [21] | Not mentioned. The "Other issuer" form takes any URL [21] | Not mentioned |
| Google Cloud | One `--issuer-uri` per provider. Because GitHub "use[s] a single issuer URL across all organizations", an attribute condition on the owner is required [22] | Not mentioned | Not mentioned |
| HashiCorp Vault | `bound_issuer` and `oidc_discovery_url`, both exact. With a unique enterprise issuer "the values ... must match that unique URL" [23] | Documented by GitHub [23] | Substitute values [23] |
| npm trusted publishing | Not documented. Only GitHub-hosted runners on github.com are listed [24] | Not mentioned | Not mentioned |
| Sigstore Fulcio | Exact default plus meta-issuer `https://token.actions.githubusercontent.com/*` [25] | Accepted by anchored pattern [26] | Not in the config [25] |
| Teleport | Builds the issuer from a configured `enterprise_slug`, or from a GitHub Enterprise Server host [28] | Per join token | Not handled in that code [28] |

Google Cloud also warns that name claims invite squatting: "use the numeric `*_id` fields instead" [22]. Testnotary already keys on `repository_id`.

My read: every relying party that serves one customer per trust pins one exact issuer and makes the customer type it. The ones that serve many customers through one config, Fulcio and Teleport, either accept the slug pattern or store a slug per customer. Testnotary serves many customers, so it sits with Fulcio and Teleport.

## Not part of the question, found on the way

AWS App Runner "is no longer open to new customers" [30]. Existing customers keep using it and can create new services. AWS points new customers to Amazon ECS Express Mode [30]. T-780 chose App Runner, so this matters if the AWS account that will host Testnotary has never used it.

## Sources

1. GitHub Docs, "OpenID Connect reference" (Enterprise Cloud), sections "Substituted values on GHE.com" and "Customizing the `issuer` value for an enterprise". https://docs.github.com/en/enterprise-cloud@latest/actions/reference/security/oidc
2. GitHub Docs, "REST API endpoints for GitHub Actions OIDC" (Enterprise Cloud), "Set the GitHub Actions OIDC custom issuer policy for an enterprise". https://docs.github.com/en/enterprise-cloud@latest/rest/actions/oidc
3. GitHub Docs, "REST API endpoints for GitHub Actions OIDC" (Free, Pro and Team). https://docs.github.com/en/rest/actions/oidc
4. Live documents fetched 2026-11-15: `https://token.actions.githubusercontent.com/.well-known/openid-configuration`, the same path under `/github/`, `/octo-inc/` and `/thisslugdoesnotexist-zz9q/`, `https://token.actions.githubusercontent.com/.well-known/jwks` (4 keys) and `https://token.actions.githubusercontent.com/octo-inc/.well-known/jwks` (404).
5. GitHub Docs, "Feature overview for GitHub Enterprise Cloud with data residency". https://docs.github.com/en/enterprise-cloud@latest/admin/data-residency/feature-overview-for-github-enterprise-cloud-with-data-residency
6. GitHub Docs, "About GitHub Enterprise Cloud with data residency". https://docs.github.com/en/enterprise-cloud@latest/admin/data-residency/about-github-enterprise-cloud-with-data-residency
7. GitHub Docs, "Network details for GHE.com". https://docs.github.com/en/enterprise-cloud@latest/admin/data-residency/network-details-for-ghecom
8. GitHub Docs, "Making retired namespaces available on GHE.com". https://docs.github.com/en/enterprise-cloud@latest/actions/how-tos/administer/reuse-namespaces-on-ghecom
9. GitHub Docs, "About using GitHub Apps". https://docs.github.com/en/enterprise-cloud@latest/apps/using-github-apps/about-using-github-apps
10. GitHub Docs, "Making a GitHub App public or private". https://docs.github.com/en/enterprise-cloud@latest/apps/creating-github-apps/registering-a-github-app/making-a-github-app-public-or-private
11. GitHub Docs, "Authorizing OAuth apps" (device flow). https://docs.github.com/en/enterprise-cloud@latest/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
12. SonarQube Cloud docs, "Importing a GHE.com organization". https://docs.sonarsource.com/sonarqube-cloud/administering-sonarcloud/managing-organization/creating-organization/importing-ghecom-cloud-organization
13. GitHub Docs, "Abilities and restrictions of managed user accounts". https://docs.github.com/en/enterprise-cloud@latest/admin/managing-iam/understanding-iam-for-enterprises/abilities-and-restrictions-of-managed-user-accounts
14. GitHub Docs, "Username considerations for external authentication". https://docs.github.com/en/enterprise-cloud@latest/admin/managing-iam/iam-configuration-reference/username-considerations-for-external-authentication
15. GitHub Docs, "About support for your IdP's Conditional Access Policy". https://docs.github.com/en/enterprise-cloud@latest/admin/managing-iam/configuring-authentication-for-enterprise-managed-users/about-support-for-your-idps-conditional-access-policy
16. GitHub Docs, "Restricting network traffic to your enterprise with an IP allow list". https://docs.github.com/en/enterprise-cloud@latest/admin/configuring-settings/hardening-security-for-your-enterprise/restricting-network-traffic-to-your-enterprise-with-an-ip-allow-list
17. GitHub Docs, "Managing allowed IP addresses for a GitHub App". https://docs.github.com/en/enterprise-cloud@latest/apps/maintaining-github-apps/managing-allowed-ip-addresses-for-a-github-app
18. AWS IAM User Guide, "Create a role for OpenID Connect federation (console)", section "Configuring a role for GitHub OIDC identity provider". https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_create_for-idp_oidc.html
19. AWS IAM User Guide, "Identity-provider controls for shared OIDC providers". https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_oidc_secure-by-default.html
20. GitHub Docs, "Configuring OpenID Connect in Amazon Web Services" (Enterprise Cloud). https://docs.github.com/en/enterprise-cloud@latest/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws
21. Microsoft Learn, "Create a trust relationship between an app and an external identity provider". https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-create-trust
22. Google Cloud, "Configure Workload Identity Federation with deployment pipelines". https://cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines
23. GitHub Docs, "Configuring OpenID Connect in HashiCorp Vault" (Enterprise Cloud). https://docs.github.com/en/enterprise-cloud@latest/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-hashicorp-vault
24. npm Docs, "Trusted publishing for npm packages", last edited 2026-10-06. https://docs.npmjs.com/trusted-publishers
25. Sigstore Fulcio, `config/identity/config.yaml`, lines 169 to 212. https://github.com/sigstore/fulcio/blob/054242851eaf63762fe0532f5fcd9a39fd3f4346/config/identity/config.yaml#L169-L212
26. Sigstore Fulcio, `pkg/config/config.go`, `MetaRegex` and `GetIssuer`, lines 162 to 211. https://github.com/sigstore/fulcio/blob/054242851eaf63762fe0532f5fcd9a39fd3f4346/pkg/config/config.go#L162-L211
27. GitHub Security Advisory GHSA-59jp-pj84-45mr (CVE-2026-22772), "Fulcio is vulnerable to Server-Side Request Forgery (SSRF) via MetaIssuer Regex Bypass", published 2026-01-13. https://github.com/advisories/GHSA-59jp-pj84-45mr
28. Teleport, `lib/join/githubactions/token_validator.go`, `issuerURL`, lines 60 to 78. https://github.com/gravitational/teleport/blob/1283425b60ec5f60d509ba4c791183d452923ff7/lib/join/githubactions/token_validator.go#L60-L78
29. AWS App Runner Developer Guide, "Enabling VPC access for outgoing traffic". https://docs.aws.amazon.com/apprunner/latest/dg/network-vpc.html
30. AWS App Runner Developer Guide, "AWS App Runner availability change". https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html
31. GitHub Docs, "About migrations between GitHub products". https://docs.github.com/en/enterprise-cloud@latest/migrations/using-github-enterprise-importer/migrating-between-github-products/about-migrations-between-github-products
32. GitHub Docs, "Generating a user access token for a GitHub App". https://docs.github.com/en/enterprise-cloud@latest/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app
