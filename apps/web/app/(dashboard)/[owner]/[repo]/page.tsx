import Link from "next/link";
import type { ReactNode } from "react";
import type { FallbackReason } from "@testnotary/core";
import { database } from "../../../../src/db/client.ts";
import { isAdmin } from "../../../../src/server/access.ts";
import { now } from "../../../../src/server/config.ts";
import { DEFAULT_PERIOD, PERIODS, hasVerifications, liveLog, overviewOf, setupState, type Overview, type Period } from "../../../../src/server/overview.ts";
import { settingsOf } from "../../../../src/server/settings.ts";
import { NavSelect } from "../../_components/client.tsx";
import { LiveLog } from "../../_components/live-log.tsx";
import { one, Panel, query } from "../../_components/history.tsx";
import { CHART_TITLES, METRICS, OverviewChart, type Metric } from "../../_components/overview-chart.tsx";
import { Section } from "../../_components/section.tsx";
import { SetupChecklist } from "../../_components/setup-checklist.tsx";
import { dur, rel } from "../../_lib/format.ts";
import { repoHref } from "../../_lib/sections.ts";
import { requireRepoAccess } from "../../_lib/viewer.ts";
import { REASON_LABELS } from "../../_lib/words.ts";

// Overview (prototype `overviewB`): a repo admin judges at a glance whether Testnotary pays off and
// what to fix. KPI cells (test time saved, share of test jobs skipped, audits agreed) each switch
// the daily chart through the URL (`?metric=saved|jobs|audits`); `?period=7|14|30|90` days. Every
// number is computed from the retained rows (src/server/overview.ts). A repo with no verification
// yet shows the setup checklist instead.

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const DEFAULT_METRIC: Metric = "jobs";
const REASONS_SHOWN = 6;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const percent = (part: number, whole: number) => (whole === 0 ? 0 : Math.round((100 * part) / whole));

export default async function OverviewPage({ params, searchParams }: { params: Promise<{ owner: string; repo: string }>; searchParams: SearchParams }) {
  const access = await requireRepoAccess(params);
  const { repo } = access;
  const db = database();
  if (!(await hasVerifications(db, repo.id))) {
    return (
      <Section title="Overview" sub={`No verification has reached Testnotary for ${repo.fullName} yet. These are the steps left.`}>
        <SetupChecklist setup={await setupState(db, repo)} fullName={repo.fullName} />
      </Section>
    );
  }
  const search = await searchParams;
  const metric = (METRICS as readonly string[]).includes(one(search.metric) ?? "") ? (one(search.metric) as Metric) : DEFAULT_METRIC;
  const period = (PERIODS as readonly number[]).includes(Number(one(search.period))) ? (Number(one(search.period)) as Period) : DEFAULT_PERIOD;
  const at = now();
  const [overview, settings, log] = await Promise.all([overviewOf(db, repo.id, period, at), settingsOf(db, repo.id), liveLog(db, repo.id)]);
  const base = repoHref(repo.fullName, "");
  const href = (values: { metric?: Metric; period?: Period }) => {
    const next = { metric, period, ...values };
    return `${base}${query({ metric: next.metric === DEFAULT_METRIC ? undefined : next.metric, period: next.period === DEFAULT_PERIOD ? undefined : String(next.period) })}`;
  };

  const modeSince = settings.lastChange ? ` since ${rel(settings.lastChange.at, at)}` : "";
  const sub = (
    <>
      {settings.mode === "enforce" ? `Enforcing${modeSince}.` : <span className="c-run">Shadow mode{modeSince}.</span>}{" "}
      {settings.openMismatches > 0 ? (
        <Link className="link c-run" href={repoHref(repo.fullName, "mismatches")}>
          {plural(settings.openMismatches, "open mismatch", "open mismatches")}
        </Link>
      ) : null}
    </>
  );

  return (
    <div className="overview">
      <div className="stack" style={{ gap: 20 }}>
        <div className="title-row">
          <div>
            <h1>Overview</h1>
            <p className="sub">{sub}</p>
          </div>
          <div className="acts">
            {settings.openMismatches > 0 && isAdmin(access) ? (
              <Link className="btn amber" href={repoHref(repo.fullName, "mismatches")}>
                Explain mismatch
              </Link>
            ) : null}
            <NavSelect
              label="Period"
              value={href({ period })}
              options={PERIODS.map((days) => ({ href: href({ period: days }), label: `Last ${days} days` }))}
            />
          </div>
        </div>

        <section className="panel" aria-labelledby="chart-title">
          <Kpis overview={overview} metric={metric} href={href} />
          <div style={{ borderTop: "1px solid var(--border)" }}>
            <div className="panel-h">
              <h2 id="chart-title">{CHART_TITLES[metric]}</h2>
            </div>
            <div className="panel-b">
              <OverviewChart overview={overview} metric={metric} />
            </div>
          </div>
        </section>

        <Suites overview={overview} />
        <Reasons overview={overview} fullName={repo.fullName} period={period} />
      </div>
      <LiveLog fullName={repo.fullName} initial={log} />
    </div>
  );
}

function Kpis({ overview, metric, href }: { overview: Overview; metric: Metric; href: (values: { metric: Metric }) => string }) {
  const { jobs, saved, local, comparisons } = overview;
  const compared = comparisons.agreed + comparisons.mismatches;
  const priced = overview.suites.some((suite) => suite.medianMs !== null);
  const kpi = (key: Metric, children: ReactNode) => (
    <Link className="kpi" href={href({ metric: key })} aria-current={metric === key ? "true" : "false"}>
      {children}
    </Link>
  );
  return (
    <div className="kpis" role="group" aria-label="Key numbers">
      {kpi(
        "saved",
        <>
          <div className="l">Test time saved, estimate</div>
          <div className="v">{priced ? dur(saved.ms / 1000) : "—"}</div>
          <div className="s">
            {priced ? `${plural(jobs.skip, "skipped job")} × median CI test time` : "No CI test time reported yet"}
            {saved.unpriced > 0 ? `, ${saved.unpriced} without one` : ""}
          </div>
          <div className="s">
            Local run time {dur(local.ms / 1000)} across {plural(local.runs, "run")}
          </div>
        </>,
      )}
      {kpi(
        "jobs",
        <>
          <div className="l">Test jobs skipped</div>
          <div className="v">
            {percent(jobs.skip, jobs.total)}
            <small>%</small>
          </div>
          <div className="s">
            {jobs.skip} of {plural(jobs.total, "test job")}
            {jobs.would_skip > 0 ? ` · ${jobs.would_skip} would have skipped` : ""}
          </div>
        </>,
      )}
      {kpi(
        "audits",
        <>
          <div className="l">Audits agreed</div>
          <div className="v">
            {comparisons.agreed} <small>/ {compared}</small>
          </div>
          <div className="s">
            {comparisons.mismatches === 0 ? "No mismatch" : plural(comparisons.mismatches, "mismatch", "mismatches")}
            {comparisons.shadow > 0 ? ` · ${plural(comparisons.shadow, "shadow comparison")} included` : ""}
            {comparisons.unknown > 0 ? ` · ${comparisons.unknown} outcome unknown` : ""}
          </div>
        </>,
      )}
    </div>
  );
}

function Suites({ overview }: { overview: Overview }) {
  return (
    <Panel id="suites-title" title="By suite" side={`Local run time ${dur(overview.local.ms / 1000)} across ${plural(overview.local.runs, "run")}`}>
      <div className="tbl-wrap">
        <table className="tbl ov-suites" aria-label="By suite">
          <thead>
            <tr>
              <th>Suite</th>
              <th className="num">Jobs</th>
              <th className="num">Skipped</th>
              <th className="num">Audited</th>
              <th className="num hide-s">Median CI time</th>
              <th className="num">Saved</th>
              <th className="num hide-s">Local run time</th>
            </tr>
          </thead>
          <tbody>
            {overview.suites.map((suite) => (
              <tr key={suite.suite}>
                <td className="mono">{suite.suite || <span className="faint">no suite</span>}</td>
                <td className="num">{suite.jobs}</td>
                <td className="num">
                  {suite.skipped}
                  <span className="bar" aria-hidden="true">
                    <i style={{ width: `${percent(suite.skipped, suite.jobs)}%` }} />
                  </span>
                </td>
                <td className="num">{suite.audited}</td>
                <td className="num hide-s">
                  {suite.medianMs === null ? (
                    <span className="faint">—</span>
                  ) : (
                    <span title={suite.repoMedian ? "No job report for this suite yet: the repo's median" : undefined}>
                      {dur(suite.medianMs / 1000)}
                      {suite.repoMedian ? <span className="faint"> repo</span> : null}
                    </span>
                  )}
                </td>
                <td className="num">{suite.medianMs === null ? <span className="faint">—</span> : dur(suite.savedMs / 1000)}</td>
                <td className="num hide-s">
                  {suite.localRuns === 0 ? (
                    <span className="faint">—</span>
                  ) : (
                    <>
                      {dur(suite.localMs / 1000)} <span className="faint">· {plural(suite.localRuns, "run")}</span>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function Reasons({ overview, fullName, period }: { overview: Overview; fullName: string; period: Period }) {
  const total = overview.reasons.reduce((sum, reason) => sum + reason.count, 0);
  const top = overview.reasons[0]?.count ?? 1;
  const shown = overview.reasons.slice(0, REASONS_SHOWN);
  const rest = overview.reasons.slice(REASONS_SHOWN);
  return (
    <Panel
      id="reasons-title"
      title="Why jobs ran"
      side={
        <Link className="link" href={`${repoHref(fullName, "verifications")}?result=ran`}>
          View all
        </Link>
      }
    >
      <div className="panel-b">
        {shown.length === 0 ? (
          <p className="empty-line">No job ran its tests in the last {period} days: every one skipped or would have.</p>
        ) : (
          <ul className="bars" aria-label="Why jobs ran">
            {shown.map((reason) => (
              <li key={reason.code}>
                <Link href={`${repoHref(fullName, "verifications")}${query({ reason: reason.code })}`} title={reason.code}>
                  <span className="lbl">{REASON_LABELS[reason.code as FallbackReason] ?? reason.code}</span>
                  <span className="val">
                    {reason.count} <span className="faint">{percent(reason.count, total)}%</span>
                  </span>
                  <span className="track" aria-hidden="true">
                    <i style={{ width: `${((88 * reason.count) / top).toFixed(1)}%` }} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {rest.length > 0 ? (
          <p className="muted" style={{ marginTop: 8, fontSize: 13 }}>
            {plural(rest.length, "more reason")}, {plural(rest.reduce((sum, reason) => sum + reason.count, 0), "job")}
          </p>
        ) : null}
      </div>
    </Panel>
  );
}
