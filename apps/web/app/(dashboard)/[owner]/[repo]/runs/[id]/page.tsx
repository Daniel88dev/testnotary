import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { database } from "../../../../../../src/db/client.ts";
import { now } from "../../../../../../src/server/config.ts";
import { runDetail } from "../../../../../../src/server/history.ts";
import { AttestationPanel } from "../../../../_components/attestation-panel.tsx";
import { FlakyChip, OutcomeChip, Panel, SessionLine, TokenLine, VerificationTable, short } from "../../../../_components/history.tsx";
import { dur, rel } from "../../../../_lib/format.ts";
import { repoHref } from "../../../../_lib/sections.ts";
import { requireRepoAccess } from "../../../../_lib/viewer.ts";
import { refusalLabel } from "../../../../_lib/words.ts";

// The run page at `/<owner>/<repo>/runs/<id>` (protocol `runPagePath`), which the PR line and the
// library's `url=` link: outcome, reason, command, hashes, duration, environment, token,
// unverified labels, the verifications that used its attestation, warnings, the not-pinned flags
// and any `env.set` overrides. Read-only for everyone.

export const metadata: Metadata = { title: "Run · Testnotary" };

const NOT_PINNED: Record<string, string> = { runtime: "runtime not pinned", package_manager: "package manager not pinned" };

function iso(at: Date | null): string {
  return at ? `${at.toISOString().slice(0, 19).replace("T", " ")} UTC` : "—";
}

function List({ items, empty = "None" }: { items: string[]; empty?: string }) {
  if (items.length === 0) return <span className="faint">{empty}</span>;
  return (
    <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
      {items.map((item) => (
        <span key={item} className="mono">
          {item}
        </span>
      ))}
    </span>
  );
}

export default async function RunPage({ params }: { params: Promise<{ owner: string; repo: string; id: string }> }) {
  const { repo } = await requireRepoAccess(params);
  const { id } = await params;
  const run = await runDetail(database(), repo.id, decodeURIComponent(id));
  if (!run) notFound();
  const at = now();
  const fullName = repo.fullName;
  return (
    <div className="stack" style={{ gap: 20 }}>
      <Link className="muted ink-link" href={repoHref(fullName, "runs")} style={{ fontSize: 13 }}>
        ← Runs
      </Link>
      <div className="title-row">
        <div>
          <h1 style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <span className="mono" style={{ fontSize: 22 }}>
              {short(run.id)}
            </span>
            <OutcomeChip run={run} />
            {run.flaky ? <FlakyChip /> : null}
          </h1>
          <p className="sub">
            {run.suite ? <span className="mono">{run.suite}</span> : <span className="faint">no suite</span>} · {rel(run.receivedAt, at)} ·{" "}
            <TokenLine account={run.account} token={run.token} />
          </p>
        </div>
      </div>

      <div className="row-even">
        <Panel id="run" title="Run">
          <div className="panel-b">
            <dl className="kv">
              <dt>Outcome</dt>
              <dd>{run.outcome}</dd>
              <dt>Reason</dt>
              <dd>
                {run.outcome === "refused" && run.refusal ? (
                  <>
                    <span className="mono">{run.refusal}</span> <span className="muted">{refusalLabel(run.refusal)}</span>
                  </>
                ) : run.outcome === "failed" ? (
                  <span>The tests exited with code {run.exitCode ?? "?"}</span>
                ) : (
                  <span>The tests exited with code 0</span>
                )}
              </dd>
              <dt>Command</dt>
              <dd className="mono">{run.command ? run.command.join(" ") : <span className="faint">Refused before the command started</span>}</dd>
              <dt>Tree</dt>
              <dd className="mono">{run.tree ?? "—"}</dd>
              <dt>Commit</dt>
              <dd className="mono">{run.commit ?? "—"}</dd>
              {run.attestation ? (
                <>
                  <dt>Payload SHA-256</dt>
                  <dd className="mono">{run.attestation.sha256}</dd>
                </>
              ) : null}
              <dt>Started</dt>
              <dd className="num">{iso(run.startedAt)}</dd>
              <dt>Duration</dt>
              <dd className="num">{run.durationMs !== null ? dur(run.durationMs / 1000) : "Refused before the tests started"}</dd>
              <dt>Warnings</dt>
              <dd>
                <List items={run.warnings} />
              </dd>
              <dt>Not pinned</dt>
              <dd>
                {run.notPinned.length === 0 ? (
                  <span className="faint">None</span>
                ) : (
                  <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
                    {run.notPinned.map((flag) => (
                      <span key={flag} className="chip ghost run">
                        {NOT_PINNED[flag] ?? flag}
                      </span>
                    ))}
                  </span>
                )}
              </dd>
              <dt>env.set overrides</dt>
              <dd>
                <List items={run.baselineOverrides} />
              </dd>
              <dt>env.pass names</dt>
              <dd>
                <List items={run.passedEnv} />
              </dd>
              <dt>Guarded globs matched</dt>
              <dd>
                <List items={run.guardedMatched} />
              </dd>
            </dl>
          </div>
        </Panel>
        <Panel id="who" title="Who and where">
          <div className="panel-b">
            <dl className="kv">
              <dt>Token</dt>
              <dd>
                <TokenLine account={run.account} token={run.token} long />
              </dd>
              <dt>Session</dt>
              <dd>
                <SessionLine session={run.session} />
              </dd>
              {run.environment ? (
                <>
                  <dt>OS</dt>
                  <dd>
                    {run.environment.os} {run.environment.osVersion}
                  </dd>
                  <dt>Architecture</dt>
                  <dd className="mono">{run.environment.arch}</dd>
                  <dt>Node</dt>
                  <dd className="mono">{run.environment.node}</dd>
                  <dt>Package manager</dt>
                  <dd className="mono">
                    {run.environment.packageManager ? `${run.environment.packageManager.name} ${run.environment.packageManager.version}` : "—"}
                  </dd>
                  <dt>TZ and locale</dt>
                  <dd className="mono">
                    {run.environment.tz} · {run.environment.locale}
                  </dd>
                </>
              ) : (
                <>
                  <dt>Environment</dt>
                  <dd className="faint">Not recorded for a refused run</dd>
                </>
              )}
            </dl>
          </div>
        </Panel>
      </div>

      <Panel id="used" title="Verifications that used this attestation" side={run.verifications.length}>
        {run.verifications.length > 0 ? (
          <VerificationTable fullName={fullName} rows={run.verifications} now={at} label="Verifications that used this attestation" />
        ) : (
          <div className="panel-b">
            <p className="empty-line">{run.attestation ? "No CI job has asked about this tree yet." : "Only a passed run yields an attestation."}</p>
          </div>
        )}
      </Panel>

      {run.attestation ? <AttestationPanel id="attestation" payload={run.attestation.payload} /> : null}
    </div>
  );
}
