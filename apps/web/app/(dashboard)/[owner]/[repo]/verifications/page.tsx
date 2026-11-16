import Link from "next/link";
import { FALLBACK_REASONS, type FallbackReason } from "@testnotary/core";
import { database } from "../../../../../src/db/client.ts";
import { now } from "../../../../../src/server/config.ts";
import { listVerifications, RESULT_FILTERS, RETAINED_DAYS, type ResultFilter } from "../../../../../src/server/history.ts";
import { NavSelect } from "../../../_components/client.tsx";
import { PAGE_SIZE, VerificationTable, one, pageNumber, query } from "../../../_components/history.tsx";
import { EmptyLine, Section } from "../../../_components/section.tsx";
import { repoHref } from "../../../_lib/sections.ts";
import { requireRepoAccess } from "../../../_lib/viewer.ts";
import { REASON_LABELS } from "../../../_lib/words.ts";

// Verifications (prototype `P.verifications`): every decision a CI job asked for in the last 90
// days, newest first. The filters are the URL: `?result=` (skip, audit, ran, shadow), `?reason=`
// (any fallback reason code; Overview links `?reason=<code>`), `?suite=`, and `?page=` for 50 more.
// Shadow rows read *would have skipped* / *would have fallen back*. Rows open the commit page.

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const SEGMENTS: [ResultFilter | "", string][] = [
  ["", "All"],
  ["skip", "Skipped"],
  ["audit", "Audited"],
  ["ran", "Ran"],
  ["shadow", "Shadow"],
];

export default async function VerificationsPage({ params, searchParams }: { params: Promise<{ owner: string; repo: string }>; searchParams: SearchParams }) {
  const { repo } = await requireRepoAccess(params);
  const search = await searchParams;
  const result = (RESULT_FILTERS as readonly string[]).includes(one(search.result) ?? "") ? (one(search.result) as ResultFilter) : undefined;
  const reason = (FALLBACK_REASONS as readonly string[]).includes(one(search.reason) ?? "") ? (one(search.reason) as FallbackReason) : undefined;
  const suite = one(search.suite) || undefined;
  const page = pageNumber(search.page);
  const limit = PAGE_SIZE * page;
  const { rows, total, segments, suites } = await listVerifications(database(), repo.id, { result, reason, suite }, limit);
  const href = (values: { result?: string; reason?: string; suite?: string; page?: string }) =>
    `${repoHref(repo.fullName, "verifications")}${query({ result, reason, suite, ...values })}`;
  const sub = `One row per CI test job that asked Testnotary, in the last ${RETAINED_DAYS} days. ${
    repo.mode === "enforce" ? "The repo is enforcing, so attested jobs skip." : "The repo is in shadow mode, so rows read “would have”."
  }`;
  const nothingYet = segments.all === 0 && !reason && !suite;
  return (
    <Section title="Verifications" sub={sub}>
      {nothingYet ? (
        <EmptyLine>No verifications yet.</EmptyLine>
      ) : (
        <div className="panel">
          <div className="filters">
            <div className="seg" role="group" aria-label="Result">
              {SEGMENTS.map(([key, label]) => (
                <Link key={label} href={href({ result: key })} aria-current={(result ?? "") === key ? "true" : "false"}>
                  {label} <span className="n">{key ? segments[key] : segments.all}</span>
                </Link>
              ))}
            </div>
            <NavSelect
              label="Fallback reason"
              value={href({ reason: reason ?? "" })}
              options={[
                { href: href({ reason: "" }), label: "Any reason" },
                ...FALLBACK_REASONS.map((code) => ({ href: href({ reason: code }), label: REASON_LABELS[code] })),
              ]}
            />
            {suites.length > 1 || suite ? (
              <NavSelect
                label="Suite"
                value={href({ suite: suite ?? "" })}
                options={[{ href: href({ suite: "" }), label: "Every suite" }, ...suites.map((name) => ({ href: href({ suite: name }), label: name }))]}
              />
            ) : null}
            <span className="muted num" style={{ marginLeft: "auto", fontSize: 13 }}>
              {total} verifications
            </span>
          </div>
          {rows.length === 0 ? (
            <div className="panel-b">
              <p className="empty-line">No verification matches these filters.</p>
            </div>
          ) : (
            <VerificationTable fullName={repo.fullName} rows={rows} now={now()} label="Verifications" />
          )}
          <div className="tbl-foot">
            <span className="num">
              {rows.length === 0 ? 0 : 1}–{rows.length} of {total}
            </span>
            {total > limit ? (
              <Link className="btn" href={href({ page: String(page + 1) })}>
                Show 50 more
              </Link>
            ) : null}
          </div>
        </div>
      )}
    </Section>
  );
}
