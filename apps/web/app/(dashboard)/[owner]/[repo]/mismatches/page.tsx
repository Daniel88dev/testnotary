import Link from "next/link";
import { accountName } from "@testnotary/protocol";
import { database } from "../../../../../src/db/client.ts";
import { isAdmin } from "../../../../../src/server/access.ts";
import { now } from "../../../../../src/server/config.ts";
import { repoMismatches, type MismatchShown } from "../../../../../src/server/settings.ts";
import { EnvCompare, Panel, SessionLine, TokenLine, short } from "../../../_components/history.tsx";
import { Section } from "../../../_components/section.tsx";
import { ExplainMismatch } from "../../../_components/settings-controls.tsx";
import { day, dur, rel } from "../../../_lib/format.ts";
import { repoHref } from "../../../_lib/sections.ts";
import { getViewer, requireRepoAccess } from "../../../_lib/viewer.ts";
import { CAUSE_LABELS } from "../../../_lib/words.ts";

// Mismatches: every one the repo has (kept while it is installed), open ones first. Each shows
// what it was recorded against, both environments, and every commit CI skipped on the same
// account's attestations since its last agreeing audit, so an admin can re-run those by hand. An
// admin explains an open one; an explanation never switches enforce back on (Settings does).
// Readable by everyone who can read the repo, signed out on a public repo included, without controls.

export default async function MismatchesPage({ params }: { params: Promise<{ owner: string; repo: string }> }) {
  const access = await requireRepoAccess(params);
  const viewer = await getViewer();
  const admin = viewer !== undefined && isAdmin(access);
  const { repo } = access;
  const all = await repoMismatches(database(), repo.id);
  const open = all.filter((shown) => !shown.explanation);
  const explained = all.filter((shown) => shown.explanation);
  const at = now();
  return (
    <Section
      title="Mismatches"
      sub="Where CI's tests failed on a tree an attestation said passed, on an audit or a shadow comparison. Each is recorded against the account and the token; nothing is revoked, and it sends the repo back to shadow mode."
    >
      <Panel
        id="open-mismatches"
        title={
          <>
            Open{" "}
            {open.length > 0 ? (
              <span className="count mm" style={{ marginLeft: 6 }}>
                {open.length}
              </span>
            ) : null}
          </>
        }
        side={open.length > 0 ? "Enforce stays off until each is explained" : undefined}
      >
        <div className="panel-b">
          {open.length === 0 ? <p className="empty-line">No open mismatch on {repo.fullName}.</p> : null}
          <div className="stack" style={{ gap: 28 }}>
            {open.map((shown) => (
              <MismatchArticle key={shown.mismatch.id} shown={shown} fullName={repo.fullName} admin={admin} now={at} />
            ))}
          </div>
        </div>
      </Panel>
      <Panel id="explained-mismatches" title="Explained">
        <div className="panel-b">
          {explained.length === 0 ? <p className="empty-line">No explained mismatch on {repo.fullName}.</p> : null}
          <div className="stack" style={{ gap: 28 }}>
            {explained.map((shown) => (
              <MismatchArticle key={shown.mismatch.id} shown={shown} fullName={repo.fullName} admin={false} now={at} />
            ))}
          </div>
        </div>
      </Panel>
    </Section>
  );
}

function MismatchArticle({ shown, fullName, admin, now }: { shown: MismatchShown; fullName: string; admin: boolean; now: Date }) {
  const { mismatch, explanation } = shown;
  const heading = `mismatch-${mismatch.id}-title`;
  const commitHref = repoHref(fullName, `commit/${mismatch.commit}`);
  const who = accountName(mismatch.account);
  return (
    <article id={`mismatch-${mismatch.id}`} aria-labelledby={heading} className="stack" style={{ gap: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h3 id={heading} style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <span className="chip mm">Mismatch</span>
          <span className="mono">{short(mismatch.commit)}</span>
          {mismatch.suite ? <span className="mono muted">{mismatch.suite}</span> : null}
        </h3>
        <span className="muted num">{rel(new Date(mismatch.createdAt), now)}</span>
      </div>
      <div className="row-even" style={{ alignItems: "start" }}>
        <dl className="kv">
          <dt>Commit</dt>
          <dd>
            <Link className="mono link" href={commitHref}>
              {short(mismatch.commit)}
            </Link>{" "}
            <span className="muted">{mismatch.event}</span>
          </dd>
          <dt>Suite</dt>
          <dd className="mono">{mismatch.suite ?? "—"}</dd>
          <dt>Compared on</dt>
          <dd>{mismatch.result === "audit" ? "An audit, in enforce mode" : "A shadow comparison: CI would have skipped"}</dd>
          <dt>Attested by</dt>
          <dd>
            <TokenLine account={mismatch.account} token={mismatch.token} long />
          </dd>
          <dt>Session</dt>
          <dd>
            <SessionLine session={mismatch.session} />
          </dd>
          <dt>Attested run</dt>
          <dd>
            <Link className="mono link" href={repoHref(fullName, `runs/${mismatch.attestation.runId}`)}>
              {mismatch.attestation.runId.slice(0, 8)}
            </Link>{" "}
            <span className="muted">
              passed on commit <span className="mono">{short(mismatch.attestation.commit)}</span>
            </span>
          </dd>
          <dt>CI test job</dt>
          <dd>
            <span className="c-run">Failed</span> in {dur(mismatch.tests.durationMs / 1000)}
          </dd>
        </dl>
        <div className="stack" style={{ gap: 12 }}>
          {explanation ? (
            <div className="stack" style={{ gap: 6 }} aria-label="Explanation">
              <p>
                <b style={{ fontWeight: 600 }}>{CAUSE_LABELS[explanation.cause]}</b>
                <span className="muted">
                  , explained by {accountName(explanation.by)} on {day(explanation.at)}
                </span>
              </p>
              {explanation.note ? <p className="muted">{explanation.note}</p> : null}
            </div>
          ) : (
            <p className="muted">
              The repo went back to shadow mode when this was recorded. Enforce stays off until an admin explains it; switching enforce back on is then a
              separate step in Settings.
            </p>
          )}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {admin && !explanation ? <ExplainMismatch repository={fullName} mismatch={mismatch.id} commit={short(mismatch.commit)} /> : null}
            <Link className="btn" href={commitHref}>
              Open commit
            </Link>
          </div>
        </div>
      </div>
      <div className="stack" style={{ gap: 8 }}>
        <h4>Both environments</h4>
        <EnvCompare run={mismatch.environments.run} ci={mismatch.environments.ci} />
      </div>
      <div className="stack" style={{ gap: 8 }}>
        <h4>Skipped on {who}&apos;s attestations since the last agreeing audit</h4>
        {mismatch.skippedCommits.length === 0 ? (
          <p className="empty-line">CI skipped no other commit on this account&apos;s attestations since its last agreeing audit.</p>
        ) : (
          <>
            <p className="muted">CI never ran these tests. Re-run them by hand to be sure.</p>
            <table className="tbl" aria-label="Skipped commits">
              <thead>
                <tr>
                  <th>Commit</th>
                  <th>Suite</th>
                  <th>Event</th>
                  <th className="num">Skipped</th>
                </tr>
              </thead>
              <tbody>
                {mismatch.skippedCommits.map((skipped) => (
                  <tr key={`${skipped.commit} ${skipped.suite ?? ""}`}>
                    <td>
                      <Link className="mono link" href={repoHref(fullName, `commit/${skipped.commit}`)}>
                        {short(skipped.commit)}
                      </Link>
                    </td>
                    <td className="mono">{skipped.suite ?? "—"}</td>
                    <td className="muted">{skipped.event}</td>
                    <td className="num muted">{rel(new Date(skipped.at), now)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </article>
  );
}
