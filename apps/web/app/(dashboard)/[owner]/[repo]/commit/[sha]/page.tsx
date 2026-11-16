import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { database } from "../../../../../../src/db/client.ts";
import { isAdmin } from "../../../../../../src/server/access.ts";
import { now, serviceConfig } from "../../../../../../src/server/config.ts";
import { commitFacts, commitVerifications, type CommitFacts, type VerificationShown } from "../../../../../../src/server/history.ts";
import { AttestationPanel } from "../../../../_components/attestation-panel.tsx";
import { EnvCompare, Gates, ResultChip, SessionLine, TokenLine, short } from "../../../../_components/history.tsx";
import { dur, rel } from "../../../../_lib/format.ts";
import { repoHref } from "../../../../_lib/sections.ts";
import { requireRepoAccess } from "../../../../_lib/viewer.ts";

// The commit page at `/<owner>/<repo>/commit/<sha>`, keyed by the commit CI built: every
// verification and audit of it, the gates each passed or stopped at, the matched attestation (which
// may come from another commit, matched by tree) with the attester beside the commit author. For
// an audit or a mismatch: both environments side by side (the only place environments are compared),
// a base-moved flag, *runtime not pinned*, the CI log link and the *explain* slot, an admin-only link
// to the Mismatches page, where T-828 adds the explanation itself.

export const metadata: Metadata = { title: "Commit · Testnotary" };

function ciLogUrl(fullName: string, ci: NonNullable<VerificationShown["ci"]>): string {
  const run = `${serviceConfig().githubWebUrl}/${fullName}/actions/runs/${ci.runId}`;
  if (ci.jobId) return `${run}/job/${ci.jobId}`;
  return ci.attempt ? `${run}/attempts/${ci.attempt}` : run;
}

/** `9 min`, `3 h 05 m`: how old the attestation was when CI asked. */
function age(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} m`;
}

function Author({ facts }: { facts: CommitFacts }) {
  if (!facts.author) return <span className="faint">Unknown (GitHub could not be asked)</span>;
  const { account, name, ofHead } = facts.author;
  return (
    <span>
      {account ? `@${account.login}` : name || "Unknown"}
      {ofHead ? <span className="faint"> (pull request head)</span> : null}
    </span>
  );
}

function VerificationBlock({
  verification,
  fullName,
  facts,
  admin,
  at,
}: {
  verification: VerificationShown;
  fullName: string;
  facts: CommitFacts;
  admin: boolean;
  at: Date;
}) {
  const attestation = verification.attestation;
  const compared = verification.result === "audit" || verification.mismatch !== null;
  const baseMoved = facts.baseMoved.get(verification.id);
  const headingId = `verification-${verification.id}`;
  const report = verification.jobReport;
  return (
    <section className="panel" aria-labelledby={headingId}>
      <div className="panel-h">
        <h2 id={headingId} style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <span className="mono">{verification.suite ?? "no suite"}</span>
          <ResultChip verification={verification} />
        </h2>
        <span className="side">
          {verification.event} · {rel(verification.createdAt, at)}
          {verification.mismatch && admin ? (
            <Link className="btn amber" href={`${repoHref(fullName, "mismatches")}#mismatch-${verification.mismatch.id}`}>
              Explain mismatch
            </Link>
          ) : null}
        </span>
      </div>
      <div className="panel-b">
        <div className="row-even">
          <div>
            <Gates verification={verification} />
            <dl className="kv" style={{ marginTop: 10 }}>
              <dt>CI test job</dt>
              <dd>
                {report ? (
                  <span className={report.outcome === "failed" ? "c-run" : undefined}>
                    CI test job {report.outcome} in {dur(report.durationMs / 1000)}
                  </span>
                ) : verification.result === "skip" ? (
                  <span className="muted">Skipped</span>
                ) : (
                  <span className="faint">Outcome unknown</span>
                )}
                {verification.ci ? (
                  <>
                    {" · "}
                    <a className="link" href={ciLogUrl(fullName, verification.ci)}>
                      CI log
                    </a>
                  </>
                ) : null}
              </dd>
            </dl>
          </div>
          <div>
            {attestation ? (
              <dl className="kv">
                <dt>Attested by</dt>
                <dd>
                  <TokenLine account={attestation.attester.account} token={attestation.attester.token} long />
                </dd>
                <dt>Commit author</dt>
                <dd>
                  <Author facts={facts} />
                </dd>
                {attestation.run?.session ? (
                  <>
                    <dt>Session</dt>
                    <dd>
                      <SessionLine session={attestation.run.session} />
                    </dd>
                  </>
                ) : null}
                <dt>Run</dt>
                <dd>
                  <Link className="link" href={repoHref(fullName, `runs/${attestation.runId}`)}>
                    Open the run
                  </Link>{" "}
                  {attestation.run?.durationMs != null ? <span className="muted">passed in {dur(attestation.run.durationMs / 1000)}</span> : null}
                </dd>
                <dt>Matched by tree</dt>
                <dd>
                  <span className="mono">{short(attestation.tree)}</span>{" "}
                  {attestation.commit === verification.commit ? (
                    <span className="muted">on this commit</span>
                  ) : (
                    <span className="muted">
                      from commit <span className="mono">{short(attestation.commit)}</span>, not this one
                    </span>
                  )}
                </dd>
                <dt>Age at verification</dt>
                <dd className="num">{age(verification.createdAt.getTime() - attestation.endedAt.getTime())}</dd>
                {attestation.run?.environment ? (
                  <>
                    <dt>Platform</dt>
                    <dd>
                      <span className="mono">
                        {attestation.run.environment.os}/{attestation.run.environment.arch}
                      </span>{" "}
                      <span className="muted">Node {attestation.run.environment.node.replace(/^v/, "")}</span>
                    </dd>
                  </>
                ) : null}
              </dl>
            ) : (
              <dl className="kv">
                <dt>Commit author</dt>
                <dd>
                  <Author facts={facts} />
                </dd>
                <dt>Tree CI built</dt>
                <dd className="mono">{short(verification.tree)}</dd>
                <dt>Attestation</dt>
                <dd className="muted">None matched for this tree and suite</dd>
              </dl>
            )}
          </div>
        </div>
        {compared && attestation ? (
          <div style={{ marginTop: 18 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 8, flexWrap: "wrap" }}>
              <h3>Environment, the attested run beside the CI runner</h3>
              <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
                {attestation.run?.notPinned.includes("runtime") ? <span className="chip ghost run">Runtime not pinned</span> : null}
                {baseMoved === true ? (
                  <span className="chip ghost run" title="CI's base had commits the attested commit did not">
                    Base moved
                  </span>
                ) : baseMoved === false ? (
                  <span className="chip ghost">Base unchanged</span>
                ) : (
                  <span className="chip ghost">Base: unknown</span>
                )}
              </span>
            </div>
            <EnvCompare run={attestation.run?.environment ?? null} ci={report?.environment ?? verification.environment} />
          </div>
        ) : null}
      </div>
    </section>
  );
}

export default async function CommitPage({ params }: { params: Promise<{ owner: string; repo: string; sha: string }> }) {
  const access = await requireRepoAccess(params);
  const { repo } = access;
  const { sha } = await params;
  const commit = decodeURIComponent(sha).toLowerCase();
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commit)) notFound();
  const shown = await commitVerifications(database(), repo.id, commit);
  if (shown.length === 0) notFound();
  const facts = await commitFacts(repo, commit, shown);
  const at = now();
  const fullName = repo.fullName;
  const featured = shown.find((verification) => verification.mismatch && verification.attestation) ?? shown.find((verification) => verification.attestation);
  const events = [...new Set(shown.map((verification) => verification.event))].join(", ");
  return (
    <div className="stack" style={{ gap: 20 }}>
      <Link className="muted ink-link" href={repoHref(fullName, "verifications")} style={{ fontSize: 13 }}>
        ← Verifications
      </Link>
      <div className="title-row">
        <div>
          <h1>
            <span className="mono" style={{ fontSize: 22 }}>
              {short(commit)}
            </span>
          </h1>
          <p className="sub">
            {events} · by <Author facts={facts} /> · tree <span className="mono">{short(shown[0]!.tree)}</span>
          </p>
        </div>
        <div className="acts">
          <a className="btn" href={`${serviceConfig().githubWebUrl}/${fullName}/commit/${commit}`}>
            View on GitHub
          </a>
        </div>
      </div>
      {shown.map((verification) => (
        <VerificationBlock key={verification.id} verification={verification} fullName={fullName} facts={facts} admin={isAdmin(access)} at={at} />
      ))}
      {featured?.attestation ? (
        <AttestationPanel id="attestation" title={`The attestation · ${featured.suite ?? ""}`} payload={featured.attestation.payload} />
      ) : null}
    </div>
  );
}
