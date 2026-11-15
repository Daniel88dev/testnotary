import Link from "next/link";
import { database } from "../../../../../src/db/client.ts";
import { now } from "../../../../../src/server/config.ts";
import { listRuns, RUN_OUTCOMES, RETAINED_DAYS, type RunOutcome } from "../../../../../src/server/history.ts";
import { FlakyChip, OutcomeChip, PAGE_SIZE, TokenLine, one, pageNumber, query, short } from "../../../_components/history.tsx";
import { EmptyLine, Section } from "../../../_components/section.tsx";
import { dur, rel } from "../../../_lib/format.ts";
import { repoHref } from "../../../_lib/sections.ts";
import { requireRepoAccess } from "../../../_lib/viewer.ts";
import { refusalLabel } from "../../../_lib/words.ts";

// Runs (prototype `P.runs`): every run uploaded for the repo in the last 90 days, all three
// outcomes, refusal codes, and a flaky-suite flag on a suite that failed and then passed on the same
// tree. `?outcome=` filters, `?page=` shows 50 more per page. Rows link to the run pages.

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const SEGMENTS: [RunOutcome | "", string][] = [
  ["", "All"],
  ["passed", "Passed"],
  ["failed", "Failed"],
  ["refused", "Refused"],
];

export default async function RunsPage({ params, searchParams }: { params: Promise<{ owner: string; repo: string }>; searchParams: SearchParams }) {
  const { repo } = await requireRepoAccess(params);
  const search = await searchParams;
  const asked = one(search.outcome);
  const outcome = (RUN_OUTCOMES as readonly string[]).includes(asked ?? "") ? (asked as RunOutcome) : undefined;
  const page = pageNumber(search.page);
  const limit = PAGE_SIZE * page;
  const { rows, total, counts, flakySuites } = await listRuns(database(), repo.id, outcome, limit);
  const at = now();
  const href = (values: { outcome?: string; page?: string }) => `${repoHref(repo.fullName, "runs")}${query(values)}`;
  const sub =
    counts.all === 0
      ? `Every run uploaded for this repo in the last ${RETAINED_DAYS} days: passed, failed and refused.`
      : `Every run uploaded from a laptop or a sandbox in the last ${RETAINED_DAYS} days: ${counts.passed} passed, ${counts.failed} failed, ${counts.refused} refused. ${flakySuites} ${flakySuites === 1 ? "suite" : "suites"} failed and then passed on the same tree.`;
  return (
    <Section title="Runs" sub={sub}>
      {counts.all === 0 ? (
        <EmptyLine>No runs yet.</EmptyLine>
      ) : (
        <div className="panel">
          <div className="filters">
            <div className="seg" role="group" aria-label="Outcome">
              {SEGMENTS.map(([key, label]) => (
                <Link key={label} href={href({ outcome: key })} aria-current={(outcome ?? "") === key ? "true" : "false"}>
                  {label} <span className="n">{key ? counts[key] : counts.all}</span>
                </Link>
              ))}
            </div>
            <span className="muted num" style={{ marginLeft: "auto", fontSize: 13 }}>
              {total} runs
            </span>
          </div>
          {rows.length === 0 ? (
            <div className="panel-b">
              <p className="empty-line">No run has this outcome.</p>
            </div>
          ) : (
            <div className="tbl-wrap">
              <table className="tbl" aria-label="Runs">
                <thead>
                  <tr>
                    <th className="num">Uploaded</th>
                    <th>Run</th>
                    <th>Suite</th>
                    <th>Outcome</th>
                    <th className="hide-s">Tree or refusal</th>
                    <th className="hide-s">Token</th>
                    <th className="num">Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((run) => (
                    <tr key={run.id}>
                      <td className="num muted">{rel(run.receivedAt, at)}</td>
                      <td>
                        <Link className="mono ink-link" href={repoHref(repo.fullName, `runs/${run.id}`)}>
                          {short(run.id)}
                        </Link>
                      </td>
                      <td className="mono">{run.suite ?? <span className="faint">—</span>}</td>
                      <td>
                        <span style={{ display: "inline-flex", gap: 6 }}>
                          <OutcomeChip run={run} />
                          {run.flaky ? <FlakyChip /> : null}
                        </span>
                      </td>
                      <td className="hide-s">
                        {run.outcome === "refused" ? (
                          <span className="mono" title={refusalLabel(run.refusal ?? "")}>
                            {run.refusal}
                          </span>
                        ) : run.tree ? (
                          <span className="mono muted">{short(run.tree)}</span>
                        ) : (
                          <span className="faint">—</span>
                        )}
                      </td>
                      <td className="hide-s">
                        <TokenLine account={run.account} token={run.token} />
                      </td>
                      <td className="num">{run.durationMs !== null ? dur(run.durationMs / 1000) : <span className="faint">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="tbl-foot">
            <span className="num">
              {rows.length === 0 ? 0 : 1}–{rows.length} of {total}
            </span>
            {total > limit ? (
              <Link className="btn" href={href({ outcome, page: String(page + 1) })}>
                Show 50 more
              </Link>
            ) : null}
          </div>
        </div>
      )}
    </Section>
  );
}
