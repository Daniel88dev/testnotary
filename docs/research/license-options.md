# License options for an open-source product with a hosted service

Research for Fenro task T-797. I read every source on 2026-11-15. Licenses change: Cal.com went closed this April and Elastic went back to an OSI license in 2024, so check a project's LICENSE file before quoting it. Numbers in square brackets point to the source list at the end. A claim marked "unconfirmed" has no primary source behind it yet. A sentence that starts with "My read" is my conclusion from the sources, not a quote of them. None of this is legal advice.

## The question

Which licenses fit Testnotary's library, action, hosted service and web app, all open source in one public monorepo (ADR 0001), with the maintainer running the only hosted instance?

## Short answer

1. Only OSI-approved licenses meet the map's "the whole product is open source" decision. MIT, Apache-2.0 and AGPL-3.0 are on the OSI list. FSL and BUSL are not [2] [3]. Both forbid a competing use, which in my read fails criterion 6 of the Open Source Definition [1]. Choosing FSL or BUSL for the service means reopening that decision, not just picking a license.
2. The comparable products split into three camps. Permissive everywhere: Supabase, Turborepo, Nx, Changesets, Cal.diy. Copyleft server with permissive clients: Plausible, Formbricks, Grafana. Fair Source server with permissive clients: Sentry and Codecov under FSL. Every one of them, whatever the server license, ships its client libraries, SDKs and actions under MIT or Apache-2.0 [10] [15] [16] [17] [19] [23] [27]. The one exception is Renovate, which is AGPL all the way down, npm package included [26].
3. One repo can carry two licenses. The usual layout is a root `LICENSE` naming the main license and listing the directories that differ, with a `LICENSE` file in each of those directories and a matching `license` field in each `package.json` [19] [22] [23]. REUSE is a stricter, tool-checked way to do the same [35].
4. Testnotary has two constraints that the comparables do not. `action.yml` and the action bundle sit at the repo root, so the root `LICENSE` is the action's license. And `packages/core` and `packages/protocol` go into the library, the action and the web app, so they must carry the client license, or the library and the action inherit the server's.
5. npm, npm provenance and the Marketplace require no particular license [30] [31] [32]. npm always packs a `LICENSE` file from the package's own directory, so in a monorepo `packages/testnotary` needs its own copy [30].
6. Every planned dependency that ships to users is MIT. Drizzle ORM is Apache-2.0 and runs only on the server [28]. The action bundle is a copy of `@actions/core` and the rest, so it must carry their MIT notices. GitHub's own actions do this with a committed license cache [36] [37], and ncc can write a licenses file on build [38]. One surprise: `@sentry/nextjs` pulls in `@sentry/cli`, which is FSL-1.1-MIT, at build time [28].
7. Contributions arrive under the repo's license by GitHub's terms, and under Apache-2.0's section 5 as well, with no CLA [6] [34]. A CLA matters only if the maintainer wants to relicense contributed code later, which is hard under AGPL and easy under MIT. A DCO adds a per-commit statement that the contributor may submit the code, and costs a `-s` flag [40] [41].

My read: the permissive-client part is settled by every comparable and by the shared packages. The real choice is the service and the web app, between a permissive license and AGPL-3.0. FSL is the third option only if the user drops "open source" for the service.

## What the license families allow

### OSI status

The Open Source Definition has ten criteria. Criterion 6 says the license "must not restrict anyone from making use of the program in a specific field of endeavor" [1]. My read: a clause that forbids "competing use" restricts a field of endeavor, so a non-compete license cannot meet it.

| License | SPDX id | OSI approved | Source |
|---|---|---|---|
| MIT | `MIT` | yes | [2] [3] |
| Apache 2.0 | `Apache-2.0` | yes | [2] [3] |
| GNU AGPL v3 | `AGPL-3.0-only` or `AGPL-3.0-or-later` | yes | [2] [3] |
| Functional Source License 1.1 | `FSL-1.1-MIT` or `FSL-1.1-ALv2` | no | [3] |
| Business Source License 1.1 | `BUSL-1.1` | no | [3] [13] |

The BUSL text says it outright: the Business Source License "is not an Open Source license" [13]. Sentry stopped calling FSL code "Open Source" after the Codecov launch drew the comment "Just don't call it Open Source", and adopted the term Fair Source instead [12].

One detail: Sentry's own npm package declares `FSL-1.1-Apache-2.0`, but the SPDX list spells that license `FSL-1.1-ALv2` [3] [28]. Anyone who picks FSL should use the SPDX spelling.

### MIT

The only condition is that "the above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software" [5]. No patent clause, no NOTICE file, nothing about network use. A minified bundle is a copy, so the notice has to travel with it.

### Apache-2.0

Apache-2.0 adds three things over MIT [6].

- A patent license. Section 3 has each contributor grant a "perpetual, worldwide, non-exclusive, no-charge, royalty-free, irrevocable" patent license for their contribution, which ends for anyone who sues claiming the work infringes a patent.
- Redistribution rules. Section 4 asks for a copy of the license, a notice on each modified file, kept copyright notices, and the contents of a `NOTICE` file when the project has one.
- Inbound contributions. Section 5 says a contribution submitted for inclusion is under the same license "without any additional terms or conditions" unless the contributor says otherwise.

The FSF recommends Apache-2.0 over other permissive licenses for substantial programs because its patent termination clause guards against patent treachery [8]. Apache-2.0 code can go into a GPLv3 or AGPLv3 program, but not into a GPLv2 one [8].

### AGPL-3.0

AGPL is GPLv3 plus section 13. If you modify the program, "your modified version must prominently offer all users interacting with it remotely" a way to get its source [7]. Section 13 applies only to a modified version. My read: the copyright holder is not bound by their own license, but code that others contribute under AGPL binds the maintainer like anyone else. The FSF recommends it "for any software which will commonly be run over a network" [8].

AGPL has a cost outside its text. Google's internal policy says AGPL code "MUST NOT be used at Google" in any product, because "the risks heavily outweigh the benefits" [29]. My read: other large companies have similar policies, so an AGPL library or action would be blocked in some organizations before anyone reads the license (unconfirmed beyond Google).

### FSL-1.1

FSL lets anyone use, modify and redistribute the code for any purpose except a "Competing Use", which it defines as offering the software in a commercial product or service that substitutes for it or offers "the same or substantially similar functionality" [10]. Internal use, non-commercial education and research, and professional services for a licensee are named as allowed. Each version becomes Apache-2.0 or MIT two years after release [9] [10]. The text fixes every parameter, so one FSL project reads the same as the next [11].

### BUSL-1.1

BUSL has parameters each project fills in: an Additional Use Grant, a Change Date at most four years after a version's release, and a Change License that must be GPL-compatible [13]. Sentry moved from BUSL to FSL in November 2023 because the four-year default was too long and the Additional Use Grant made every BUSL project different, which slowed compliance reviews [11]. HashiCorp moved its products from MPL 2.0 to BUSL in August 2023 and kept "APIs, SDKs, and almost all other libraries" on MPL 2.0 [14].

## What comparable products chose

Licenses as GitHub's API and the npm registry reported them on 2026-11-15 [27] [28], checked against each repo's LICENSE file where the API said `NOASSERTION`.

| Product | Server or app | Clients, SDK, CLI, action | Hosted by the vendor |
|---|---|---|---|
| Sentry | FSL-1.1, Apache-2.0 future [10] | MIT SDKs [15] | yes |
| Codecov | FSL-1.1, Apache-2.0 future [16] | MIT action, Apache-2.0 CLI [17] [27] | yes |
| Plausible | AGPL-3.0 [19] | MIT tracker, in `tracker/` of the same repo [19] | yes |
| Formbricks | AGPL-3.0, plus a commercial `ee` directory [23] | MIT SDK packages in the same repo [23] [28] | yes |
| Grafana | AGPL-3.0 since April 2021, was Apache-2.0 [24] | plugins, agents and some libraries stayed Apache-2.0 [24] | yes |
| Renovate | AGPL-3.0-only [26] | the npm package is AGPL-3.0-only too [28] | yes, by Mend |
| PostHog | MIT, plus a commercial `ee/` directory [22] | `posthog-js` is Apache-2.0 AND MIT [28] | yes |
| Supabase | Apache-2.0 [27] | MIT `supabase-js` [27] | yes |
| Cal.com | hosted code closed since April 2026; the public fork Cal.diy is MIT [20] [21] | n/a | yes |
| Turborepo | MIT [27] | MIT; no public source found for the Vercel remote cache (unconfirmed) | yes |
| Nx | MIT [27] | MIT; no public source found for Nx Cloud (unconfirmed) | yes |
| Chromatic | no public source found (unconfirmed) | MIT CLI and action [27] | yes |
| Trunk | no public source found (unconfirmed) | MIT uploader and action [27] | yes |
| Changesets | MIT [27] | MIT action [27] | no |

Why they chose what they chose, from their own posts:

- Plausible went from MIT to AGPL in October 2020 after a company took parts of its code, "made it closed source and started selling it as a direct competitor" [18].
- Grafana moved from Apache-2.0 to AGPL in April 2021 to balance what the community gets with what the company captures, and updated its CLA to one based on the Apache CLA at the same time [24].
- Sentry chose FSL to stop free-riding by competitors while every version still becomes open source after two years [11].
- Elastic added AGPL as a third option in August 2024, alongside SSPL and ELv2, so that "questions about whether Elasticsearch is open source" go away [25].
- Cal.com took its hosted code closed in April 2026, citing AI tools that scan public code for vulnerabilities, and released the rest as Cal.diy under MIT, switching from AGPL [20] [21]. Its earlier LICENSE was AGPL-3.0 with commercial `ee` directories [21]. How Cal.com got the rights to relicense outside contributions from AGPL to MIT is unconfirmed.

Two patterns stand out. No vendor that sells a hosted service put its client library under AGPL, except Renovate. And the products that went from permissive to something stricter did it after a competitor appeared, not at launch.

## Testnotary's own constraints

The map fixes some facts that the comparables do not share.

- **The action is the repo root.** ADR 0001 puts `action.yml` at the root and builds the bundle onto a tagged commit of the whole repo. GitHub's license detection reads the root `LICENSE` with Licensee and may show nothing useful when the file describes several licenses [33]. Sentry and PostHog both show `NOASSERTION` in GitHub's API for that reason [27]. Whether the Marketplace listing shows the root license is unconfirmed. My read: the root `LICENSE` should be the action's license and should parse as one license, with the exceptions listed in the README or in per-directory files.
- **Shared packages go both ways.** `packages/core` and `packages/protocol` are bundled into the library and the action and imported by the web app (T-780). Permissive code can go into an AGPL program [8], but AGPL code inside the library would make the library AGPL. So these two packages carry the client license whatever the server gets.
- **No billing in v1.** The free-riding problem FSL and AGPL answer is a revenue problem. The beta has no revenue to protect yet.
- **A clone needs more than the code.** The library and the action have `testnotary.dev` built in, and a rival service needs its own GitHub App, its own audit HMAC key and users who set an undocumented `TESTNOTARY_URL` (T-780). My read: a competing hosted Testnotary would be a fork with a new name, which AGPL lets anyone run as long as they publish their changes, and which FSL forbids for two years.
- **Relicensing later.** The maintainer owns the code written so far. MIT contributions can go into a later version under any license, as long as the notices stay. AGPL contributions cannot be relicensed without each contributor's consent or a CLA that grants it (unconfirmed as a legal matter; Grafana and Renovate both run a CLA alongside AGPL [24] [26]).

## Options for Testnotary

Each option names the root license first, because the root is the action.

| Option | Root, action, library, core, protocol | `apps/web` and `infra/` | OSI open source | Example |
|---|---|---|---|---|
| A | MIT | MIT | yes | Cal.diy, Turborepo, Nx |
| B | Apache-2.0 | Apache-2.0 | yes | Supabase |
| C | MIT or Apache-2.0 | AGPL-3.0 | yes | Plausible, Formbricks, Grafana |
| D | MIT or Apache-2.0 | FSL-1.1 | no, for the service | Sentry, Codecov |
| E | AGPL-3.0 | AGPL-3.0 | yes | Renovate |

- **A or B** is one license, one root file, nothing to explain, and GitHub detects it. Anyone may run a closed hosted copy. B adds the patent grant and the NOTICE and changed-file rules.
- **C** makes a hosted fork publish its changes. It needs a per-directory `LICENSE` in `apps/web`, a README line, and care that nothing AGPL leaks into `packages/`. Contributors to `apps/web` license under AGPL, so a later relicense of the service needs their consent or a CLA.
- **D** stops a commercial clone for two years per version. It contradicts the map's "open source" decision for the service. FSL names the licensor only as "the party offering the Software" [10], so a personal account can use it.
- **E** is the strongest copyleft. Google-style AGPL bans would block the library and the action in some companies [29], and `uses: Daniel88dev/testnotary@v1` would put AGPL code in every customer's workflow.

## How a two-license monorepo is laid out

Three projects in the comparison do this, each a little differently.

- **Plausible.** The root `LICENSE` is the AGPL text alone, so GitHub detects AGPL-3.0. `tracker/LICENSE.md` is MIT, and `tracker/package.json` says `"license": "MIT"` [19].
- **Formbricks.** The root `LICENSE` opens with a list: one directory under a commercial license, six named `packages/` directories under MIT "as declared in the `package.json` files of these packages", and everything else under AGPL, followed by the AGPL text [23]. The published `@formbricks/js`, `@formbricks/surveys` and `@formbricks/api` all say MIT on npm [28].
- **PostHog.** The root `LICENSE` says everything under `ee/` follows `ee/LICENSE` and the rest is MIT, followed by the MIT text [22].

For Testnotary under option C or D, the Plausible pattern inverted fits: root `LICENSE` is the plain MIT or Apache-2.0 text, `apps/web/LICENSE` holds the server license, and the README and `apps/web/package.json` say so. The Formbricks pattern, a preamble in the root file, stops GitHub from detecting the license [33].

REUSE is the stricter option [35]. It puts every license text in `LICENSES/<SPDX-id>.txt`, gives each file an `SPDX-License-Identifier` and `SPDX-FileCopyrightText` header or a matching `REUSE.toml` entry, and a linter checks the whole tree. A `REUSE.toml` can map `apps/web/**` to one license and the rest to another without touching each file. SPDX expressions such as `MIT AND AGPL-3.0-only` describe a file under both at once, and `MIT OR Apache-2.0` offers a choice [4].

## npm, provenance and the Marketplace

- **npm `license` field.** An SPDX id, an SPDX expression such as `(ISC OR GPL-3.0)`, `SEE LICENSE IN <filename>` for a custom license, or `UNLICENSED` for none. The object form is deprecated [30]. `UNLICENSED` grants no rights, so it is wrong for an open-source package, private or not.
- **The LICENSE file.** npm always packs `LICENSE` or `LICENCE` from the package root, in any case and with any extension [30]. In this monorepo the package root is `packages/testnotary`, so the repo's root `LICENSE` is not in the tarball unless the package has its own copy.
- **Provenance.** It needs npm 9.5.0 or later, GitHub Actions or GitLab on a cloud runner, `id-token: write` and a public `repository` that matches the source. It sets no license rule [31].
- **Marketplace.** An action needs a public repo, one `action.yml` at the root, a unique name, 2FA and the Marketplace Developer Agreement. The page names no license rule [32].
- **No license at all.** Without one, "the default copyright laws apply", and other users still get to view and fork under GitHub's terms [33]. The repo has no `LICENSE` today, so this is its current state.

## What the dependencies require

Every planned dependency that ends up in something a user downloads is MIT, as the npm registry reported on 2026-11-15 [28].

| Package | License | Where it runs |
|---|---|---|
| `next` | MIT | server |
| `better-auth` | MIT | server |
| `drizzle-orm` | Apache-2.0 | server |
| `drizzle-kit` | MIT | dev |
| `@changesets/cli` | MIT | dev |
| `@actions/core`, `@actions/exec`, `@actions/github`, `@actions/http-client` | MIT | action bundle |
| `@vercel/ncc`, `esbuild`, `rollup`, `rolldown` | MIT | build |
| `zod` | MIT | library, action, server |
| `fumadocs-core`, `fumadocs-ui`, `fumadocs-mdx` | MIT | server |
| `@sentry/nextjs` | MIT | server |
| `@sentry/cli`, pulled in by `@sentry/bundler-plugin-core` | FSL-1.1-MIT | build |
| `sharp` | Apache-2.0 | server, if image optimization is used |
| `@img/sharp-libvips-linux-x64` | LGPL-3.0-or-later | server, with `sharp` |

What follows from that:

- **Server-only code.** MIT, Apache-2.0 and LGPL conditions attach to distribution. A service image pushed to a private ECR repo is not distributed, so Drizzle's Apache-2.0 and libvips's LGPL ask nothing of the hosted instance. My read: that changes if a container image is ever published for self-hosting.
- **No AGPL anywhere.** No planned dependency is AGPL or GPL, so none forces a license on Testnotary. Any of the five options works with this list, because MIT and Apache-2.0 both go into AGPL-3.0 [8].
- **`@sentry/cli`.** It runs during the build to upload source maps. FSL allows internal use [10]. It is not open source by the OSI definition, so a license checker set to OSI licenses only will flag it. Both `@sentry/cli` 2.58.5 and 3.x are FSL-1.1-MIT [28]. Sentry's SDK repo carries a similar warning in its own LICENSE, about the FSL `sentry` CLI package that some of its packages depend on [15].
- **The action bundle.** ncc, esbuild or rolldown copy dependency code into one file, which is a copy under MIT's terms [5]. Two ways to carry the notices:
  - GitHub's `typescript-action` template and `actions/checkout` use the `licensed` tool. A `.licensed.yml` lists allowed licenses, `licensed cache` writes each dependency's license text into `.licenses/`, and a workflow fails on anything outside the list [36] [37].
  - ncc's `--license <file>` writes the licensing information of bundled packages next to the output [38]. esbuild only keeps comments marked `@license`, `@preserve`, `//!` or `/*!`, which it moves to the end of a bundle by default, and does not collect `LICENSE` files [39]. Rollup's own published package lists every bundled dependency with its license in `LICENSE.md` [43].

  Since the bundle is built onto a detached tagged commit (ADR 0001), the licenses file has to be built onto that commit too.
- **The library.** If `packages/testnotary` declares its dependencies in `package.json` instead of inlining them, npm installs each with its own `LICENSE`. Only `core` and `protocol` are inlined, and they are Testnotary's own code under the package's license.

## Patents, CLAs and the DCO

### What contributors grant today

GitHub's terms, section D.6, say that adding content to a repo "containing notice of a license" licenses it "under the same terms", unless a separate agreement such as a CLA says otherwise [34]. Apache-2.0 section 5 says the same for Apache-licensed work [6]. So with a `LICENSE` file in place, a contributor's PR is under that license with no extra paperwork. The repo has no `LICENSE` yet, so D.6 gives nothing until one exists.

### Apache-2.0's patent grant

The grant covers patents a contributor holds that their contribution infringes [6]. MIT says nothing about patents [5]. My read: for a solo project whose contributors are mostly individuals and their agents, the grant protects users against a corporate contributor's patents and costs little. It matters more if companies start contributing. It does not protect against patents held by people who never contributed.

### CLA

A CLA gives the maintainer rights beyond the repo license, usually the right to relicense. Renovate makes "Pull Request authors" sign one [26], and Grafana asks for one before it accepts a PR [24]. PostHog's and Plausible's contributing guides mention neither a CLA nor a DCO (I checked their CONTRIBUTING files; other files may). A CLA costs a bot, a signature step for every new contributor, and some contributors walk away.

My read: a CLA matters under options C, D and E, where the maintainer may want to relicense the server later. Under A and B, permissive inbound code already allows that.

### DCO

The Developer Certificate of Origin 1.1 is a short statement that the contributor wrote the code or has the right to submit it under the project's license, and accepts that the record is public [40]. A contributor agrees by adding a `Signed-off-by` trailer with `git commit -s` [41]. GitHub can add the sign-off to commits made in its web interface, but it does not check command-line pushes [42]. Checking every commit needs a separate app or workflow.

My read: agents write most of this repo's PRs. The DCO is a statement by a person, so a sign-off on an agent's commit is the human operator certifying the agent's work. That fits the product's own stance that an attestation names the account behind a token, not the agent.

## Questions for the license ticket

1. Does "the whole product is open source" mean OSI open source for the service and web app too? A yes rules out FSL and BUSL.
2. Which license for the root, the action, the library, `core` and `protocol`: MIT or Apache-2.0?
3. Does the service and web app get the same license as the clients, or AGPL-3.0? If AGPL, `-only` or `-or-later`?
4. Does `infra/` and the docs content under `apps/web/content/docs` follow `apps/web`, or the root?
5. CLA, DCO or neither? If DCO, how is it checked?
6. Per-directory `LICENSE` files, REUSE, or both?
7. How does the release job ship the action bundle's third-party notices: `licensed` cache, ncc `--license`, or a generated file?
8. Is the build-time `@sentry/cli` dependency acceptable, given its FSL license?
9. Who is the copyright holder in the notice: the person, or a future company?

## Sources

All read on 2026-11-15.

1. Open Source Initiative, The Open Source Definition. https://opensource.org/osd
2. Open Source Initiative, OSI-approved licenses. https://opensource.org/licenses
3. SPDX License List. https://spdx.org/licenses/
4. SPDX specification 2.3.1, Annex D, SPDX license expressions. https://spdx.github.io/spdx-spec/v2.3.1/SPDX-license-expressions/
5. The MIT License, as in Cal.diy's and the Sentry JavaScript SDK's LICENSE files. https://opensource.org/license/mit
6. Apache License, Version 2.0. https://www.apache.org/licenses/LICENSE-2.0
7. GNU Affero General Public License v3. https://www.gnu.org/licenses/agpl-3.0.html
8. Free Software Foundation, Various licenses and comments about them. https://www.gnu.org/licenses/license-list.html
9. Functional Source License. https://fsl.software/
10. Sentry, `LICENSE.md` (FSL-1.1, Apache 2.0 future license). https://github.com/getsentry/sentry/blob/master/LICENSE.md
11. Sentry blog, Introducing the Functional Source License, 2023-11-17. https://blog.sentry.io/introducing-the-functional-source-license-freedom-without-free-riding/
12. Sentry blog, Sentry is now Fair Source, 2024-08-06. https://blog.sentry.io/sentry-is-now-fair-source
13. Business Source License 1.1. https://mariadb.com/bsl11/
14. HashiCorp blog, HashiCorp adopts Business Source License, 2023-08-10. https://www.hashicorp.com/blog/hashicorp-adopts-business-source-license
15. Sentry JavaScript SDK, `LICENSE`, with its third-party dependency notice. https://github.com/getsentry/sentry-javascript/blob/develop/LICENSE
16. Codecov API, `LICENSE.md` (FSL-1.1). https://github.com/codecov/codecov-api/blob/main/LICENSE.md and Codecov self-hosted, `LICENSE.md`. https://github.com/codecov/self-hosted/blob/main/LICENSE.md
17. Codecov action, `LICENSE`. https://github.com/codecov/codecov-action/blob/main/LICENSE
18. Plausible blog, We're changing our open source license, 2020-10-12. https://plausible.io/blog/open-source-licenses
19. Plausible Analytics, root `LICENSE`, `tracker/LICENSE.md` and `tracker/package.json`. https://github.com/plausible/analytics
20. Cal.com blog, Cal.com goes closed source, 2026-04-14. https://cal.com/blog/cal-com-goes-closed-source-why
21. Cal.diy repository, commit `ab21c7f8` "refactor: Cal.diy" of 2026-04-15, and `LICENSE` at commit `06695f41`. https://github.com/calcom/cal.diy
22. PostHog, `LICENSE` and `ee/LICENSE`. https://github.com/PostHog/posthog/blob/master/LICENSE
23. Formbricks, `LICENSE`. https://github.com/formbricks/formbricks/blob/main/LICENSE
24. Grafana blog, Grafana, Loki, and Tempo will be relicensed to AGPLv3, 2021-04-20. https://grafana.com/blog/2021/04/20/grafana-loki-tempo-relicensing-to-agplv3/ and Grafana `CONTRIBUTING.md`. https://github.com/grafana/grafana/blob/main/CONTRIBUTING.md
25. Elastic blog, Elasticsearch is open source again, 2024-08-29. https://www.elastic.co/blog/elasticsearch-is-open-source-again
26. Renovate, README and `.github/contributing.md`. https://github.com/renovatebot/renovate and https://github.com/renovatebot/renovate/blob/main/.github/contributing.md
27. GitHub REST API, repository license metadata (`license.spdx_id`), queried for `supabase/supabase`, `supabase/supabase-js`, `vercel/turborepo`, `nrwl/nx`, `changesets/changesets`, `changesets/action`, `chromaui/chromatic-cli`, `chromaui/action`, `trunk-io/analytics-uploader`, `trunk-io/trunk-action`, `codecov/codecov-action`, `codecov/codecov-cli`, `getsentry/sentry`, `PostHog/posthog`. https://docs.github.com/en/rest/licenses/licenses
28. npm registry, `license` field of each named package, read with `npm view` on 2026-11-15. https://www.npmjs.com/
29. Google Open Source, AGPL policy. https://opensource.google/documentation/reference/using/agpl-policy
30. npm Docs, `package.json`, `license` and `files`. https://docs.npmjs.com/cli/v11/configuring-npm/package-json#license
31. npm Docs, Generating provenance statements. https://docs.npmjs.com/generating-provenance-statements
32. GitHub Docs, Publishing actions in GitHub Marketplace. https://docs.github.com/en/actions/how-tos/create-and-publish-actions/publish-in-github-marketplace
33. GitHub Docs, Licensing a repository. https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository
34. GitHub Terms of Service, section D.6, Contributions under repository license. https://docs.github.com/en/site-policy/github-terms/github-terms-of-service
35. REUSE Specification 3.3. https://reuse.software/spec-3.3/
36. GitHub, `actions/typescript-action` template, `.licensed.yml` and `.github/workflows/licensed.yml`. https://github.com/actions/typescript-action
37. GitHub, `actions/checkout`, `.licensed.yml` and `.licenses/`. https://github.com/actions/checkout
38. Vercel, ncc README, `--license` option. https://github.com/vercel/ncc
39. esbuild API, Legal comments. https://esbuild.github.io/api/#legal-comments
40. Developer Certificate of Origin 1.1. https://developercertificate.org/
41. Git documentation, `git commit --signoff`. https://git-scm.com/docs/git-commit
42. GitHub Docs, Managing the commit signoff policy for your repository. https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/managing-the-commit-signoff-policy-for-your-repository
43. Rollup, `LICENSE.md` with the licenses of bundled dependencies. https://github.com/rollup/rollup/blob/master/LICENSE.md
