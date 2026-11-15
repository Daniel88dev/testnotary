import Link from "next/link";
import type { ReactNode } from "react";
import { DELETED_ACCOUNT, accountName, type CiEnvironment, type RunEnvironment } from "@testnotary/protocol";
import type { Attester, RunShown, TokenShown, VerificationShown } from "../../../src/server/history.ts";
import { dur, rel } from "../_lib/format.ts";
import { repoHref } from "../_lib/sections.ts";
import { RESULT_LABELS, reasonLabel } from "../_lib/words.ts";

// The parts the Verifications and Runs lists, the run page and the commit page share (prototype
// ui.js `resultChip`, `outcomeChip`, `tokenLine`, `detail`, `verTable`, `gates`, `envCompare`).

export const short = (sha: string) => sha.slice(0, 7);

/** A panel with a heading, exposed as a region named after it. */
export function Panel({ title, side, children, id }: { title: ReactNode; side?: ReactNode; children: ReactNode; id: string }) {
  return (
    <section className="panel" aria-labelledby={id}>
      <div className="panel-h">
        <h2 id={id}>{title}</h2>
        {side ? <span className="side">{side}</span> : null}
      </div>
      {children}
    </section>
  );
}

/** A verification's result; a mismatch is solid amber, shadow results outlined, in their own words. */
export function ResultChip({ verification }: { verification: Pick<VerificationShown, "result" | "mismatch"> }) {
  if (verification.mismatch) return <span className="chip mm">Mismatch</span>;
  const label = RESULT_LABELS[verification.result];
  switch (verification.result) {
    case "skip":
      return <span className="chip skip">{label}</span>;
    case "would_skip":
      return <span className="chip ghost skip">{label}</span>;
    case "would_fall_back":
      return <span className="chip ghost run">{label}</span>;
    default:
      return <span className="chip run">{label}</span>;
  }
}

export function OutcomeChip({ run }: { run: Pick<RunShown, "outcome" | "exitCode"> }) {
  if (run.outcome === "passed") return <span className="chip skip">Passed</span>;
  if (run.outcome === "failed") return <span className="chip">Failed · exit {run.exitCode ?? "?"}</span>;
  return <span className="chip ghost">Refused</span>;
}

export function FlakyChip() {
  return (
    <span className="chip ghost run" title="Failed, then passed on the same tree">
      Flaky suite
    </span>
  );
}

const isDeleted = (account: { id: number }) => account.id === DELETED_ACCOUNT.id;

/**
 * Who uploaded a run or made an attestation: a laptop token names its owner, a sandbox token its
 * creator (never an agent). A deleted account's token is not named either.
 */
export function TokenLine({ account, token, long = false }: { account: Attester["account"]; token: TokenShown; long?: boolean }) {
  const who = accountName(account);
  if (isDeleted(account)) return <span className="muted">{who}, {token.kind} token</span>;
  if (token.kind === "sandbox") {
    return (
      <span>
        <span className="mono">{token.name}</span> <span className="muted">sandbox token, created by {who}</span>
      </span>
    );
  }
  return (
    <span>
      {who} <span className="muted">{long ? `laptop token "${token.name}"` : "laptop"}</span>
    </span>
  );
}

/** Labels the run read from an agent's environment: self-reported, so always marked unverified. */
export function SessionLine({ session }: { session: { vendor: string; id: string | null; url: string | null } | null }) {
  if (!session) return <span className="faint">None</span>;
  return (
    <span>
      {session.vendor}
      {session.id ? (
        <>
          {" "}
          <span className="mono">{session.id}</span>
        </>
      ) : null}
      {session.url ? (
        <>
          {" "}
          <span className="mono muted">{session.url}</span>
        </>
      ) : null}{" "}
      <span className="chip ghost">unverified</span>
    </span>
  );
}

/** The "Why" of a verification row (prototype `detail`). */
export function Why({ verification }: { verification: VerificationShown }) {
  const attester = verification.attestation?.attester;
  const by = attester ? <TokenLine account={attester.account} token={attester.token} /> : null;
  if (verification.mismatch) {
    return (
      <span>
        <span className="c-run">CI failed; attested as passed by</span> {by}
      </span>
    );
  }
  if (verification.result === "skip" || verification.result === "would_skip") {
    return (
      <span>
        <span className="muted">on</span> {by}
      </span>
    );
  }
  if (verification.result === "audit") {
    const outcome = verification.jobReport?.outcome;
    return (
      <span>
        <span className="muted">Audit of</span> {by} <span className="muted">· {outcome === "passed" ? "agreed" : outcome ? `CI ${outcome}` : "outcome unknown"}</span>
      </span>
    );
  }
  if (!verification.reason) return <span className="faint">—</span>;
  return (
    <span title={verification.reason}>
      {reasonLabel(verification.reason)}
      {verification.detail ? (
        <>
          {" "}
          <span className="mono">{verification.detail}</span>
        </>
      ) : null}
    </span>
  );
}

/** Verifications as rows linking their commit pages (prototype `verTable`). */
export function VerificationTable({ fullName, rows, now, label }: { fullName: string; rows: VerificationShown[]; now: Date; label: string }) {
  return (
    <div className="tbl-wrap">
      <table className="tbl" aria-label={label}>
        <thead>
          <tr>
            <th className="num">When</th>
            <th>Commit</th>
            <th>Suite</th>
            <th>Result</th>
            <th className="hide-s">Why</th>
            <th className="num hide-s">CI test time</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((verification) => (
            <tr key={verification.id}>
              <td className="num muted">{rel(verification.createdAt, now)}</td>
              <td>
                <Link className="mono ink-link" href={repoHref(fullName, `commit/${verification.commit}`)}>
                  {short(verification.commit)}
                </Link>{" "}
                <span className="faint">{verification.event}</span>
              </td>
              <td className="mono">{verification.suite ?? <span className="faint">—</span>}</td>
              <td>
                <ResultChip verification={verification} />
              </td>
              <td className="wrap hide-s" style={{ minWidth: 260 }}>
                <Why verification={verification} />
              </td>
              <td className="num hide-s">{verification.jobReport ? dur(verification.jobReport.durationMs / 1000) : <span className="faint">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The decision order (spec: installation, suite, guarded files, attestation, age, write access,
 * audit draw, mode) and where this verification stopped. Each gate lists the reasons it answers.
 */
const GATES: { label: string; reasons: string[] }[] = [
  { label: "App installed on the repo", reasons: ["repo_not_installed"] },
  { label: "Suite declared in testnotary.json on the base", reasons: ["unknown_suite"] },
  { label: "No guarded file changed", reasons: ["guarded_file_changed"] },
  { label: "An attestation names this tree, with the same command", reasons: ["no_attestation", "command_changed"] },
  { label: "Attestation under 24 hours old, its token not revoked, blocked or expired", reasons: ["attestation_expired", "attestation_revoked"] },
  { label: "Attester has write access", reasons: ["attester_no_write"] },
  { label: "Not drawn for an audit", reasons: ["audit"] },
  { label: "Repo is enforcing", reasons: [] },
];

export function Gates({ verification }: { verification: VerificationShown }) {
  const shadow = verification.result === "would_skip" || verification.result === "would_fall_back";
  const reason = verification.reason;
  const stop = reason ? GATES.findIndex((gate) => gate.reasons.includes(reason)) : -1;
  // A reason the service never answers itself (decided in the action) means no gate was reached.
  const unreached = reason !== null && stop === -1;
  const last = GATES.length - 1;
  return (
    <>
      {unreached ? <p className="warn-line" style={{ marginBottom: 10 }}>{reasonLabel(reason)}. The gates were not reached.</p> : null}
      <ol className="gates" aria-label="Gates">
        {GATES.map((gate, index) => {
          let state: "pass" | "stop" | "skipped" = "pass";
          let text = "passed";
          if (unreached) [state, text] = ["skipped", "not reached"];
          else if (index === stop) [state, text] = ["stop", index === 6 ? auditState(verification) : "stopped here"];
          else if (stop >= 0 && index > stop && index !== last) [state, text] = ["skipped", "not reached"];
          if (index === last && !unreached) {
            if (shadow) [state, text] = ["stop", "shadow mode"];
            else if (stop >= 0 && stop < 6) [state, text] = ["skipped", "not reached"];
          }
          return (
            <li key={gate.label} className={state}>
              <span className="n">{index + 1}</span>
              <span>
                {gate.label}
                {index === 2 && reason === "guarded_file_changed" && verification.detail ? (
                  <>
                    {" "}
                    <span className="mono">{verification.detail}</span>
                  </>
                ) : null}
              </span>
              <span className="st">{text}</span>
            </li>
          );
        })}
      </ol>
    </>
  );
}

function auditState(verification: VerificationShown): string {
  if (verification.mismatch) return "audited · CI failed";
  const outcome = verification.jobReport?.outcome;
  return outcome === "passed" ? "audited · agreed" : outcome ? `audited · CI ${outcome}` : "audited · outcome unknown";
}

/** The attested run's environment beside the CI runner's (prototype `envCompare`); differing values amber. */
export function EnvCompare({ run, ci }: { run: RunEnvironment | null; ci: CiEnvironment }) {
  const os = (value: string) => value.toLowerCase().replace(/^darwin$/, "macos").replace(/^win32$/, "windows");
  const arch = (value: string) => value.toLowerCase().replace(/^x86_64$/, "x64").replace(/^aarch64$/, "arm64");
  const node = (value: string) => value.replace(/^v/, "").split(".")[0] ?? value;
  const rows: { field: string; run: string; ci: string; differs: boolean }[] = [
    { field: "OS", run: run ? `${run.os} ${run.osVersion}` : "—", ci: ci.os, differs: !!run && os(run.os) !== os(ci.os) },
    { field: "Architecture", run: run?.arch ?? "—", ci: ci.arch, differs: !!run && arch(run.arch) !== arch(ci.arch) },
    { field: "Node", run: run?.node ?? "—", ci: ci.node, differs: !!run && node(run.node) !== node(ci.node) },
    {
      field: "Package manager",
      run: run?.packageManager ? `${run.packageManager.name} ${run.packageManager.version}` : "—",
      ci: "—",
      differs: false,
    },
    { field: "TZ", run: run?.tz ?? "—", ci: "—", differs: false },
    { field: "Locale", run: run?.locale ?? "—", ci: "—", differs: false },
    { field: "Runner image", run: "—", ci: ci.image ? `${ci.image} ${ci.imageVersion ?? ""}`.trim() : "self-hosted", differs: false },
  ];
  return (
    <table className="tbl envcmp" aria-label="Environments side by side">
      <thead>
        <tr>
          <th>Field</th>
          <th>The attested run</th>
          <th>CI runner</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.field}>
            <td className="muted">{row.field}</td>
            <td className={`mono${row.differs ? " diff" : ""}`}>{row.run}</td>
            <td className={`mono${row.differs ? " diff" : ""}`}>{row.ci}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** `?a=b&c=d` from the given values, leaving out empty ones. */
export function query(values: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value) params.set(key, value);
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** `?page=` as a whole number of 50-row pages, at least 1. */
export function pageNumber(value: string | string[] | undefined): number {
  const n = Number(Array.isArray(value) ? value[0] : value);
  return Number.isInteger(n) && n > 1 && n <= 200 ? n : 1;
}

export const PAGE_SIZE = 50;

export function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
