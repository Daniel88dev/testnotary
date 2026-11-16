import { ACTION_REF, ATTESTATION_MAX_AGE_MS, INITIAL_REPO_SETTINGS, PACKAGE_MANAGERS, workflowSnippet } from "@testnotary/core";
import { ATTESTATION_FORMAT_V1 } from "@testnotary/protocol";
import type { Metadata } from "next";
import Link from "next/link";
import { appInstallUrl } from "../../src/server/config.ts";
import { AttestationExplainer, AuditStream, EventLog, SetupSteps, SixGates, type Gate, type PayloadField } from "./_components/landing-client.tsx";
import "./landing.css";

// The landing page (prototype landing variant C, "Pipeline"). The trust sentence is the spec's,
// word for word. Never "proof", "verified pass" or "can't fake".

export const metadata: Metadata = {
  title: "Testnotary: pass once, skip in CI",
  description: "Testnotary records a passing test run on the machine that wrote the code, and CI skips the test job when the git tree matches.",
};

// The install link comes from the deployment's settings (the App's slug, GitHub's URL).
export const dynamic = "force-dynamic";

const GITHUB_REPO_URL = `https://github.com/${ACTION_REF.split("@")[0]}`;
const MAX_AGE_HOURS = ATTESTATION_MAX_AGE_MS / 3_600_000;
const { auditOneIn, sandboxAuditOneIn } = INITIAL_REPO_SETTINGS;

const str = (value: string) => <span className="str">&quot;{value}&quot;</span>;
const num = (value: number) => <span className="num">{value}</span>;

/** A sample attestation, with the canonical payload's own keys in its own order. */
const FIELDS: PayloadField[] = [
  {
    key: "format",
    value: str(ATTESTATION_FORMAT_V1),
    title: "A versioned record",
    text: "The service keeps these exact bytes and serves them back. A new field means a new format, never a change to this one.",
  },
  {
    key: "repository",
    value: num(734019482),
    title: "One repo, by its GitHub id",
    text: "A pass in one repo never skips a test job in another.",
  },
  {
    key: "suite",
    value: str("unit"),
    title: "A named suite",
    text: "Suites live in testnotary.json. CI asks for the suite its job runs, so a pass of one suite never skips another.",
  },
  {
    key: "command",
    value: (
      <>
        [{str("pnpm")}, {str("run")}, {str("test")}]
      </>
    ),
    title: "The exact command",
    text: "Written as argv, as the config on the base branch declares it. When the config's command changes, CI runs the tests.",
  },
  {
    key: "tree",
    value: str("a91f3c2e0d4b…"),
    title: "The git tree, not the commit",
    text: "A rebase or a squash makes a new commit with the same tree. Matching the tree keeps the run valid after the history changes.",
  },
  {
    key: "commit",
    value: str("5e1c07b9a4f2…"),
    title: "The commit it ran on",
    text: "Named for the record. Only the tree decides whether CI skips.",
  },
  {
    key: "outcome",
    value: str("passed"),
    title: "Only passes skip",
    text: "Failed and refused runs are recorded too, without an attestation, and CI runs the tests for that tree as usual.",
  },
  {
    key: "attester",
    value: (
      <>
        {"{ "}
        <span className="key">&quot;account&quot;</span>: {num(4719022)}, <span className="key">&quot;token&quot;</span>: {str("3f6c2a1e…")},{" "}
        <span className="key">&quot;tokenKind&quot;</span>: {str("laptop")}
        {" }"}
      </>
    ),
    title: "Who answers for it",
    text: `Every skip names a GitHub account and the token it used. For a sandbox token, the account is the person who made the token. Sandbox passes are audited 1 in ${sandboxAuditOneIn} instead of 1 in ${auditOneIn}.`,
  },
  {
    key: "endedAt",
    value: str("2026-11-15T09:12:04.000Z"),
    title: `Good for ${MAX_AGE_HOURS} hours`,
    text: "Counted from the end of the run. After that, CI runs the tests again even if the tree hasn't changed.",
  },
];

/** The six gates, in the order the action and the service decide. */
const GATES: Gate[] = [
  {
    title: "Service answered in time",
    detail: "the action fails open",
    toggle: "Testnotary timed out",
    verdict: "Runs the tests",
    why: "Testnotary did not answer in time. The action fails open, so CI runs as usual.",
  },
  {
    title: "Guarded files untouched",
    detail: "workflows, actions, testnotary.json, .testnotary/allowed_signers, lockfiles, package.json, .nvmrc, .node-version, .tool-versions",
    toggle: "A guarded file changed",
    verdict: "Runs the tests",
    why: "pnpm-lock.yaml is a guarded file. A change there can change what the tests do.",
  },
  {
    title: `Attestation under ${MAX_AGE_HOURS} hours`,
    detail: "same tree, suite and command",
    toggle: "The attestation is 26 hours old",
    verdict: "Runs the tests",
    why: `The attestation for tree a91f3c2 is 26 hours old. The limit is ${MAX_AGE_HOURS}.`,
  },
  {
    title: "Attester can write to the repo",
    detail: "checked live; read access never counts",
    toggle: "The attester lost write access",
    verdict: "Runs the tests",
    why: "@maria-k can only read the repo now. Only write or admin access counts.",
  },
  {
    title: "Not drawn for an audit",
    detail: `1 in ${auditOneIn}, or 1 in ${sandboxAuditOneIn} for sandbox tokens`,
    toggle: "Drawn for an audit",
    verdict: "Runs and compares",
    why: "Tree a91f3c2 was drawn at random. CI runs the suite and compares the outcome with the attestation.",
  },
  {
    title: "Repo is enforcing",
    detail: "shadow mode only reports",
    toggle: "The repo is in shadow mode",
    verdict: "Runs the tests",
    why: "Shadow mode: CI runs everything, and the check says it would have skipped.",
  },
];

const SETUP = Object.values(PACKAGE_MANAGERS).map((pm) => ({
  name: pm.name,
  add: pm.add,
  exec: pm.exec,
  workflow: workflowSnippet({ packageManager: pm.name, suite: "unit" }),
}));

function Wordmark() {
  return (
    <>
      <span className="mark" aria-hidden="true">
        <i />
        <i />
      </span>
      testnotary
    </>
  );
}

export default function LandingPage() {
  const installUrl = appInstallUrl();
  return (
    <div className="landing">
      <header className="nav wrap">
        <a className="logo" href="#top" aria-label="Testnotary home">
          <Wordmark />
        </a>
        <nav aria-label="Main">
          <a href="#anatomy">Attestations</a>
          <a href="#decide">Rules</a>
          <a href="#audits">Audits</a>
          <a href="#setup">Setup</a>
          <Link href="/docs">Docs</Link>
        </nav>
        <Link className="btn btn-sm btn-line" href="/dashboard">
          Dashboard
        </Link>
        <a className="btn btn-sm" href="#setup">
          Get started
        </a>
      </header>

      <main id="top">
        <section className="hero wrap">
          <div className="hero-copy">
            <h1>
              Pass once.
              <br />
              <span className="c">Skip in CI.</span>
            </h1>
            <div className="hero-side">
              <p className="lede">
                For teams whose agents open dozens of PRs a day. Testnotary records a passing run on the machine that wrote the code, and CI skips
                the test job when the git tree matches.
              </p>
              <div className="actions">
                <a className="btn" href={installUrl}>
                  Install the GitHub App
                </a>
                <a className="btn btn-line" href="#decide">
                  See the rules
                </a>
              </div>
            </div>
          </div>

          <div className="pipe" role="img" aria-label="How a run becomes a skipped test job">
            <div className="pipe-grid" aria-hidden="true">
              <div className="col sources">
                <div className="node">
                  <span className="k">source</span>
                  <b>Agent sandbox</b>
                  <span className="v">shop-agent token</span>
                </div>
                <div className="node">
                  <span className="k">source</span>
                  <b>Laptop</b>
                  <span className="v">@maria-k</span>
                </div>
              </div>
              <div className="wire">
                <i />
              </div>
              <div className="col">
                <div className="node">
                  <span className="k">run</span>
                  <b>testnotary run unit</b>
                  <span className="v">tree a91f3c2 · 412 passed</span>
                </div>
              </div>
              <div className="wire">
                <i />
              </div>
              <div className="col">
                <div className="node hi">
                  <span className="k">attestation</span>
                  <b>a91f3c2 / unit</b>
                  <span className="v">good for {MAX_AGE_HOURS} h</span>
                </div>
              </div>
              <div className="wire">
                <i />
              </div>
              <div className="col">
                <div className="node">
                  <span className="k">ci</span>
                  <b>Testnotary action</b>
                  <span className="v">PR #2318</span>
                </div>
              </div>
              <div className="wire split">
                <i />
              </div>
              <div className="col outs">
                <div className="node out skip">
                  <span className="k">match</span>
                  <b>Test job skipped</b>
                </div>
                <div className="node out run">
                  <span className="k">any doubt</span>
                  <b>Test job runs</b>
                </div>
              </div>
            </div>
          </div>
          <EventLog />
        </section>

        <section className="anatomy wrap" id="anatomy" aria-labelledby="anat-h">
          <div className="sec-head">
            <h2 id="anat-h">What an attestation holds</h2>
            <p>Point at a field. Everything here is about the run; none of it is your code.</p>
          </div>
          <AttestationExplainer fields={FIELDS} />
        </section>

        <section className="decide wrap" id="decide" aria-labelledby="dec-h">
          <div className="sec-head">
            <h2 id="dec-h">Every PR goes through six gates</h2>
            <p>Flip a condition and watch where the PR stops. The first gate it fails runs the tests.</p>
          </div>
          <SixGates gates={GATES} pass="All six gates pass. The check names @maria-k and tree a91f3c2." />
        </section>

        <section className="audits wrap" id="audits" aria-labelledby="aud-h">
          <div className="aud-copy">
            <h2 id="aud-h">Testnotary can&apos;t prove a test ran.</h2>
            <p className="big">It ties every skipped test job to a named GitHub account and re-runs a random share of them in CI.</p>
            <p>
              If an audit fails where the attestation passed, that&apos;s a mismatch: the repo drops back to shadow mode until an admin writes
              down what happened. A changed test file still skips; your reviewer reads it in the diff.
            </p>
          </div>
          <AuditStream oneIn={auditOneIn} />
        </section>

        <section className="setup wrap" id="setup" aria-labelledby="set-h">
          <div className="sec-head">
            <h2 id="set-h">Three steps, shadow mode first</h2>
            <p>
              Nothing skips until you switch a repo to enforcing. The <Link href="/docs/setup">setup guide</Link> walks through every step.
            </p>
          </div>
          <SetupSteps variants={SETUP} installUrl={installUrl} />
        </section>

        <section className="faq wrap" aria-labelledby="faq-h">
          <h2 id="faq-h">Questions</h2>
          <dl className="qs">
            <div>
              <dt>What if Testnotary is down?</dt>
              <dd>CI runs the tests. Anything the service can&apos;t answer means a normal run.</dd>
            </div>
            <div>
              <dt>How do agents attest?</dt>
              <dd>With a sandbox token made for one repo in the dashboard. Its runs name the token and you, never the agent.</dd>
            </div>
            <div>
              <dt>Do forks ever skip?</dt>
              <dd>No. A pull request from a fork gets no identity token from GitHub, so CI runs its tests.</dd>
            </div>
            <div>
              <dt>What leaves my machine?</dt>
              <dd>
                A record of the run: the fields above, the command&apos;s exit code and the environment it ran in. Never your source code, test
                output or environment values. <Link href="/docs/data">What leaves your machine</Link>
              </dd>
            </div>
            <div>
              <dt>Can a run be made up?</dt>
              <dd>Someone with write access and a modified client could. The attestation names them and audits catch it over time.</dd>
            </div>
            <div>
              <dt>Does it cost anything?</dt>
              <dd>Not during the beta. The beta ends only after 30 days&apos; notice here and in the dashboard.</dd>
            </div>
          </dl>
        </section>
      </main>

      <footer className="foot">
        <div className="wrap foot-in">
          <p className="foot-big">
            Pass once.
            <br />
            <span className="c">Skip in CI.</span>
          </p>
          <div className="foot-links">
            <a className="btn" href={installUrl}>
              Install the GitHub App
            </a>
            <nav aria-label="Footer">
              <Link href="/docs">Docs</Link>
              <Link href="/docs/limit">Trust model</Link>
              <a href={GITHUB_REPO_URL}>GitHub</a>
              <a href="/api/v1/health">Status</a>
              <Link href="/terms">Terms</Link>
              <Link href="/privacy">Privacy</Link>
            </nav>
            <p className="dim">The pipeline, the log and the stream above show sample data: acme/shop, @maria-k.</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
