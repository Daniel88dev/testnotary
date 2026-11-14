# Candidate project names and their availability

Research for Fenro task T-773, part of the Vouch map T-766. I ran every check on 2026-11-14. Availability changes daily, so run the checks again on the day the name is picked, and register the GitHub organization, the npm scope and the domain in one sitting. Numbers in square brackets point to the source list at the end.

I registered nothing and created no accounts. Every check was a read.

## The question

Which names fit a product that lets a local test run vouch for a commit, and which of them are free where the product has to exist: the npm package and scope, the GitHub organization, the GitHub App, the Marketplace action name and the `.dev`, `.com`, `.io` and `.sh` domains?

## Short answer

"Vouch" fails every check that matters. The npm package, the npm scope, the GitHub organization and all four domains belong to others, and three developer tools already use the name for trust on GitHub: `mitchellh/vouch`, `vouch.sh` and the VouchCI app. Details are under "How Vouch did".

Plain trust words are gone too. Attest, witness, notary, avow, assay, hallmark, signet, warrant and proctor are all taken on npm and on GitHub. Out of about 170 names screened, the ones that are free are compounds and foreign words.

Five names pass and differ in style:

| Name | Style | What is taken |
| --- | --- | --- |
| Earnedpass | Plain claim | Nothing |
| Testnotary | Says what it is | Nothing |
| Safeskip | Names the benefit | `.com` |
| Razitko | Czech word, "stamp" | `.com` |
| Sameasci | States the bar | Nothing |

My pick of the five is Earnedpass. It says the thing the product promises, a pass that was earned and not claimed, and nobody holds any of the ten places I checked. None of the five is as good a word as "vouch". That is the cost of arriving in 2026.

## How I checked

| Check | Method | Confidence |
| --- | --- | --- |
| npm package | `npm view <name> name version`, and a `GET` on `registry.npmjs.org/<name>` [1] | Confirmed that no package has the name. npm can still refuse a name at publish time if it judges it a typosquat [2], so I also checked the hyphenated form of each compound, such as `earned-pass` |
| npm scope | `GET registry.npmjs.org/-/org/<name>/package` [1]. It answers 404 "Scope not found" for a free name and 200 for a name that an organization or a user holds. I calibrated it on a nonsense name, two organizations and three user accounts | Confirmed against the registry. The page `npmjs.com/org/<name>` refuses scripted requests with a 403, so I could not read it |
| `@name/cli` | `npm view @<name>/cli name` [1] | Confirmed |
| GitHub user or organization | `gh api users/<name>`, 404 means free [3] | Confirmed. GitHub can still reserve a name, which only shows when someone tries to create it |
| GitHub App | `https://github.com/apps/<name>` and `gh api apps/<name>` [4] | Best guess. Both show public apps only, and a private app holds its name without showing up |
| Marketplace action | `https://github.com/marketplace/actions/<name>` for the exact name, and the Marketplace search for close ones [5] | Confirmed for the exact name, best guess for close names |
| Domains | RDAP at the registry: Verisign for `.com`, Google Registry for `.dev`, Identity Digital for `.io` and `.sh` [6]. A 404 means no registration. Cross-checked with `whois` for `.com`, `.io` and `.sh`, and with `dig NS` for all four. All three methods agreed on every name | Confirmed that the name is unregistered. A registry can price a free name as premium, which RDAP does not show |
| Existing products | Web search for the name with "CI", "testing", "developer tool" and "GitHub Action", plus `gh search repos` by name | Best guess. A search cannot prove that nothing exists |

Two rules from closed research bind a name [7]:

- A Marketplace action `name` must be unique on the Marketplace and must match no GitHub user or organization, unless that owner publishes the action.
- An npm trusted publisher binds to a GitHub owner and repository, so the product needs its own GitHub organization name as much as it needs the npm name.

GitHub adds a third. A GitHub App name must be unique across GitHub and cannot match an existing account unless it is your own [8]. So a name whose GitHub account is taken loses the organization, the App name and the Marketplace action name at once. I treated a taken GitHub name as a fail.

I ran no trademark search. See "Not checked".

## The candidates

"Free" and "taken" follow the methods above. The GitHub App column reads "free" for all fifteen, as a best guess, so the table leaves it out.

| Name | npm package | npm scope | `@name/cli` | GitHub name | Marketplace action | `.dev` | `.com` | `.io` | `.sh` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| vouch | taken | taken | free | taken, organization | free | taken | taken | taken | taken |
| attest | taken | taken | free | taken, organization | free | taken | taken | taken | taken |
| hallpass | taken | taken | taken | taken, organization | free | taken | taken | taken | taken |
| chopmark | free | free | free | free | free | taken | taken | free | free |
| prepass | free | free | free | free | free | free | taken | free | free |
| wavethrough | free | free | free | free | free | free | taken | free | free |
| earnedpass | free | free | free | free | free | free | free | free | free |
| testnotary | free | free | free | free | free | free | free | free | free |
| safeskip | free | free | free | free | free | free | taken | free | free |
| skipwise | free | free | free | free | free | free | taken | free | free |
| knownsha | free | free | free | free | free | free | free | free | free |
| sameasci | free | free | free | free | free | free | free | free | free |
| ranonce | free | free | free | free | free | free | free | free | free |
| razitko | free | free | free | free | free | free | taken | free | free |
| rucim | free | free | free | free | free | free | taken | free | free |

Where a scope is taken, a free `@name/cli` is no use, because only the scope's owner can publish under it.

### Same or close products, and how each name reads

The CLI and action lines are examples. T-781 and T-782 own the real contracts. The action reference assumes the layout T-771 leans to, one public repository with `action.yml` at its root.

| Name | Style | Same or close product | As a command and an action |
| --- | --- | --- | --- |
| vouch | Trust verb, the working name | Three developer tools in the same field. See "How Vouch did" | `vouch run -- pnpm test`, `uses: vouch/vouch@v1`. The best read of the fifteen |
| attest | Glossary word | GitHub's own `actions/attest-build-provenance` and `gh attestation` own the word on GitHub [9]. npm `attest` is an accessibility testing library | Reads well, and every reader would take it for GitHub's feature |
| hallpass | School metaphor | `@hallpass/cli` 0.5.1 is a CLI for "key generation, attestations, delegations, message signing" [10]. Same vocabulary, same registry | Reads well. Not usable |
| chopmark | Stamp. Merchants punched a chop mark into a silver coin they had tested | A repository created on 2026-10-29 holds the privacy page of an app named Chopmark. `chopmark.dev` is registered with no name servers | `chopmark run`, `uses: chopmark/chopmark@v1`. Reads well. Few readers know the word |
| prepass | Bypass. PrePass lets screened trucks skip weigh stations and still inspects some at random | PrePass is a long-standing brand in trucking and owns `prepass.com` [11]. `react-ssr-prepass` and `preact-ssr-prepass` are known npm packages [11] | `prepass run`, `uses: prepass/prepass@v1`. Short. The closest match to how the product works, sampling included |
| wavethrough | CI waves the commit through | None found | `wavethrough run`. Eleven letters. To wave something through also means to let it pass unchecked, the opposite of the promise |
| earnedpass | Plain claim | None found | `earnedpass run -- pnpm test`, `uses: earnedpass/earnedpass@v1`. Clear on first read. Ten letters, and the "dp" in the middle is a small stumble |
| testnotary | Says what it is | None found. Notary is also a CNCF project for signing container images, a different field | `testnotary run`, `uses: testnotary/testnotary@v1`. Nobody has to ask what it does |
| safeskip | Names the benefit | Four repositories named SafeSkip with no stars. Many unrelated actions for skipping CI, such as `skip-duplicate-actions` | `safeskip run`, `uses: safeskip/safeskip@v1`. Short and easy to say |
| skipwise | Brand-like | Someone started a "Skipwise" video summarizer on GitHub in October 2026 and still pushes to it [12]. `skipwise.com` has been registered since 2005 | `skipwise run`. Reads like a company name |
| knownsha | Engineer's term, after "known good" | None found | `knownsha run`. T-769 found that a run may have to attest to a tree and not to a SHA, which would make the name wrong |
| sameasci | States the bar | None found. `ci-parity` on npm is a close idea under another name | `sameasci run`, `uses: sameasci/sameasci@v1`. Lower case hides the three words. It needs the capitals of "SameAsCI" to read |
| ranonce | Says the test ran once | `tuist/once` has the tagline "Run once. Reuse everywhere." [13] | `ranonce run` clashes on tense. The eye also finds "nonce" in it, a cryptography term that means something else |
| razitko | Czech for the stamp an official puts on a document | No product found. Czech search results for the word are stamp shops | `razitko run`, `uses: razitko/razitko@v1`. Seven letters, easy to say in English |
| rucim | Czech "ručím", I vouch | None found. `rucim.com` sits on a for-sale name server | `rucim run`. Five letters. An English reader cannot tell how to say it |

## Shortlist

All five are free on npm as a package and a scope, on GitHub as an organization, as a GitHub App name by best guess, as a Marketplace action name, and on `.dev`, `.io` and `.sh`.

**Earnedpass.** The map's own words for the cheat it blocks are "a pass never earned", and this name is the opposite claim. Nothing is taken, `.com` included, and no product uses the name. It costs ten letters and it is a compound nobody will call beautiful.

**Testnotary.** A notary records that something happened and puts a name to it, which is what an attestation does. A visitor understands the product from the name alone, and every place is free. It reads as a description more than a brand, and "notary" promises more than T-770 found the signature can prove. A signature says who claimed the pass, not that the pass is true.

**Safeskip.** It names what the buyer gets, a test job skipped without risk. It is the shortest and easiest to say of the five. It costs `.com`, which someone registered in 2016, and it puts the word "skip" first for a product whose promise is trust. A reader could file it with the `[skip ci]` helpers.

**Razitko.** A short, distinct word with a picture built in, the stamp, which gives the logo and the dashboard's "attested" mark for free. It means something to the founder and nothing yet to the market, so it carries no baggage. It costs `.com`, registered since 2002, and an English reader learns the meaning only from the landing page. Translated, it is "rubber stamp", which in English means approval without a look. The landing page should say "official stamp". Rucim, "I vouch", is the alternative in this style, shorter and harder to pronounce.

**Sameasci.** The only name that states the bar: a local pass counts when CI would have passed too. Nothing is taken. It is the hardest of the five to read in lower case, and a package name and a domain are always lower case.

## How Vouch did

It fails, and not narrowly.

- **npm.** `vouch` 0.2.0 is a JSON schema validator, last touched in 2022 [14]. The `@vouch` scope exists with no public packages.
- **GitHub.** `vouch` is an organization, created in 2018, home of `vouch-proxy` with 3,289 stars [15]. So the organization, the App name and a Marketplace action named "Vouch" are all out.
- **Domains.** All four are registered. `vouch.com` dates from 1996 and `vouch.io` from 2017. `vouch.dev` sits on a for-sale name server. `vouch.sh` was registered on 2026-01-22.
- **`mitchellh/vouch`.** A trust system for open-source projects that ships as GitHub Actions, built against low-quality AI pull requests. It has 5,176 stars and started on 2026-02-05 [16]. Same platform, same audience, same word for the same idea of trust.
- **`vouch.sh`.** An open-source CLI named `vouch` that issues short-lived developer credentials, GitHub tokens among them [17]. `vouch login` is already its command.
- **VouchCI.** A public GitHub App, created on 2026-06-13, that reviews pull requests with AI and posts a verdict [18].
- **`vouch` on Hex.** A test runner for Gleam [19].

A variant does not rescue it. Of twelve I screened, `testvouch` is free everywhere and `vouchhq` is free on GitHub and npm. `vouchci` is the VouchCI app. `vouched`, `vouchd`, `vouchfor`, `vouchkit`, `vouchdev`, `vouchrun`, `ivouch`, `getvouch` and `vouchpass` are taken on GitHub. Any variant still sits beside three tools named Vouch in search results.

## Names that passed and stayed off the shortlist

- **Prepass.** The best metaphor of the lot, and free everywhere but `.com`. PrePass is an established trucking brand, and I ran no trademark search. Worth a second look if a trademark check comes back clean, see "Not checked".
- **Ranonce.** Free everywhere, `.com` included. It describes caching more than trust, it sits close to `tuist/once`, and it reads oddly.
- **Knownsha.** Free everywhere. If T-776 settles on attesting to a tree, the name is wrong.
- **Rucim.** Free except `.com`. Kept as the alternative to Razitko.
- **Skipwise.** Free except `.com`. An active project already uses the name.
- **Wavethrough.** Free except `.com`. The phrase means to let pass unchecked.
- **Chopmark.** `.dev` and `.com` are taken, and a new app uses the name.

## Screened out early

I screened about 170 names on npm, GitHub and the four domains before building the table. A name with a taken GitHub account stopped there.

Taken on GitHub, and most on npm too:

- Trust words: witness, notary, avow, warrant, testimony, surety, sworn, alibi, chit, sayso, goodword, avouch, vouchsafe, bonafide, bonafides, underwrite, attestant, attesta, attesto, atesto, cosigned, trustfall, pinkyswear, scoutshonor, forsooth, provably.
- Stamps and seals: assay, hallmark, signet, imprimatur, countersign, proofmark, passmark, touchmark, countermark, testmark, tallymark, hashmark, waymark, trailmark, waxseal, runseal, counterfoil, chirograph, jurat.
- Passes and gates: greenlight, greenlit, preclear, gatepass, carnet, greenstamp, greenslip, hallmonitor, allclear, spotcheck, passmuster, cleanbill, pratique, quittance, cleanpass, truepass, passproof.
- Stand-ins and roles: proctor, deputy, standin, locum, twokey.
- Already-done words: ditto, idem, stet, dejarun, nottwice, testonce, knowngood, goodsha, greensha, sametree, cleantree, goodtree, passlocal, localgreen, localproof, worksonmine, earnit.
- Green checks: greencheck, greenproof, cleangreen, truegreen, greenwax.
- Latin and other languages: testor, vidimus, constat, inspeximus, spondeo, probavi, proslo, zaruka, pecet, slib, collaudo, temoin, shonin, kakunin, gokaku, takuu, pruvo, testato, inkan.
- Others: proofrun, runproof.

Free on GitHub but taken on npm: tallystick, which also has a GitHub App, precleared, apostille, hanko, ciproof, validpass, goodcommit, onmymachine.

`proofmark` deserves a line. `prooft` on PyPI, released 2026-11-10, describes itself as "proof marks" stamped into commit trailers so that CI skips proven work [20]. The name is taken twice over.

Free on GitHub and npm in the quick screen, and not carried into the table. I did not check their npm scope or search for products, except where the list says so:

- All four domains free: rucitel, kensazumi, cigrade, earnedskip, oktoskip, qedpass, shaseal, passedsha, greenearned, passkept, keptpass, ranlocal with the scope checked and free.
- `.com` taken, the rest free: priorpass, skipproof and oncegreen with the scope checked and free, honestgreen, earnedgreen, provenpass, provengreen, fairgreen, trustskip, treeseal, sealwax, overeno, collaudato, bonatirer, todiste, localvouch, selfattest.
- More domains taken: passonce, safeconduct, geprueft, passnote, probatum.

Earnedgreen and Provengreen are the nearest spares to Earnedpass. Overeno, Czech for "verified", and Rucitel, "guarantor", are the nearest spares to Razitko.

## Not checked

- **Trademarks.** I searched no trademark register. A free domain and a free npm name say nothing about a registered mark. The picked name needs a search at EUIPO and USPTO in the software classes before anything is printed. PrePass is the one candidate where I expect a hit.
- **Private GitHub Apps.** A private app holds its name and shows nowhere I can read.
- **Reserved and premium names.** GitHub and the domain registries can hold back a name that looks free. Only a real attempt to register shows it.
- **npm's typosquat filter.** npm says it blocks typosquats [2] and does not publish the rule. Only a real publish shows whether a name passes.
- **Social handles and other registries.** PyPI, crates.io, Docker Hub, X and Bluesky are outside the ticket.

## Found on the way

Two products turned up in the name searches that T-767's prior-art file may not have. Both are for the map, not for this ticket.

- **Chainguard Checks**, announced 2026-10-14, runs a repository's CI suite from a CLI for developers and agents, signs a verdict for each run, and says teams "will also be able to configure merge gates to verify these passing verdicts" so repositories can skip redundant CI runs [21]. The runs happen in Chainguard's own microVMs, not on the developer's machine. It is a hosted product aimed at the same saving.
- **prooft**, on PyPI since November 2026, stamps local lint and test passes into commit trailers, with no server and no signing keys [20].

## Sources

1. npm registry. Package metadata at `https://registry.npmjs.org/<name>`, scope lookup at `https://registry.npmjs.org/-/org/<name>/package`, read with `npm view` and `curl` on 2026-11-14.
2. npm Docs, Threats and mitigations. https://docs.npmjs.com/threats-and-mitigations
3. GitHub REST API, Get a user. https://docs.github.com/en/rest/users/users#get-a-user
4. GitHub REST API, Get an app. https://docs.github.com/en/rest/apps/apps#get-an-app
5. GitHub Marketplace, action pages at `https://github.com/marketplace/actions/<name>` and search at `https://github.com/marketplace?type=actions&query=<name>`.
6. RDAP services of the registries. Verisign, `https://rdap.verisign.com/com/v1/domain/<name>.com`. Google Registry, `https://pubapi.registry.google/rdap/domain/<name>.dev`. Identity Digital, `https://rdap.identitydigital.services/rdap/domain/<name>.io` and `.sh`.
7. Where a published action and an npm package must live, T-771. `docs/research/publishing-layout.md` on the branch `research/publishing-layout`. It cites GitHub Docs, Publishing actions in GitHub Marketplace, https://docs.github.com/en/actions/how-tos/create-and-publish-actions/publish-in-github-marketplace, and npm Docs, Trusted publishing, https://docs.npmjs.com/trusted-publishers
8. GitHub Docs, Registering a GitHub App. https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app
9. actions/attest-build-provenance. https://github.com/actions/attest-build-provenance
10. npm, `@hallpass/cli`. https://www.npmjs.com/package/@hallpass/cli
11. PrePass, weigh station bypass. https://prepass.com/bypass/. FormidableLabs/react-ssr-prepass. https://github.com/FormidableLabs/react-ssr-prepass
12. kzkz22/skipwise-runner. https://github.com/kzkz22/skipwise-runner
13. tuist/once. https://github.com/tuist/once
14. npm, `vouch`. https://www.npmjs.com/package/vouch
15. vouch/vouch-proxy. https://github.com/vouch/vouch-proxy
16. mitchellh/vouch. https://github.com/mitchellh/vouch
17. Vouch, hardware-backed developer credentials. https://vouch.sh
18. VouchCI. App page, https://github.com/apps/vouchci. Site, https://vouchci-dashboard.vercel.app
19. Hex, `vouch`. https://hex.pm/packages/vouch
20. PyPI, `prooft`. https://pypi.org/project/prooft/
21. Chainguard, Introducing Chainguard Checks, 2026-10-14. https://www.chainguard.dev/unchained/introducing-chainguard-checks
