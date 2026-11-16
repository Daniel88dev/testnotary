import { and, asc, eq, gte, sql } from "drizzle-orm";
import type { RepoMode } from "@testnotary/core";
import { repoStates, runs, tokens, verifications } from "../db/schema.ts";
import { retainedSince } from "./history.ts";
import type { Executor, RepoView } from "./installations.ts";
import { guardedFilesOf } from "./settings.ts";

// What the Overview reads. There are no aggregate tables: every number is computed from the rows
// retention still holds, so every window here is bounded by the 90 days (`retainedSince`).

/** Where a repo with no verification yet stands on the setup guide's steps, as far as the service can see. */
export interface SetupState {
  /** When the App was last installed on the repo. */
  installedAt: Date | undefined;
  /** `testnotary.json` on the default branch: found, absent, invalid, or GitHub could not be asked. */
  config: "config" | "no_config" | "invalid" | "unavailable";
  /** A run uploaded with a laptop token reached this repo (in the retained window). */
  laptopRun: boolean;
  /** Sandbox tokens created for this repo. */
  sandboxTokens: number;
  mode: RepoMode;
}

/** The repo has at least one retained verification: the Overview shows its numbers, not the setup checklist. */
export async function hasVerifications(db: Executor, repoId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: verifications.id })
    .from(verifications)
    .where(and(eq(verifications.repoId, repoId), gte(verifications.createdAt, retainedSince())))
    .limit(1);
  return row !== undefined;
}

export async function setupState(db: Executor, repo: RepoView): Promise<SetupState> {
  const [states, [laptop], [sandbox], guarded] = await Promise.all([
    db.select({ installed: repoStates.installed, at: repoStates.at }).from(repoStates).where(eq(repoStates.repoId, repo.id)).orderBy(asc(repoStates.id)),
    db
      .select({ id: runs.id })
      .from(runs)
      .innerJoin(tokens, eq(tokens.id, runs.tokenId))
      .where(and(eq(runs.repoId, repo.id), eq(tokens.kind, "laptop"), gte(runs.receivedAt, retainedSince())))
      .limit(1),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(tokens)
      .where(and(eq(tokens.kind, "sandbox"), eq(tokens.repoId, repo.id))),
    guardedFilesOf(repo),
  ]);
  // The install that counts: the first installed row after the last time the repo left.
  let installedAt: Date | undefined;
  for (const state of states) {
    if (!state.installed) installedAt = undefined;
    else installedAt ??= state.at;
  }
  return { installedAt, config: guarded.source, laptopRun: laptop !== undefined, sandboxTokens: sandbox?.n ?? 0, mode: repo.mode };
}

/** The periods the Overview offers, in days ending today (UTC). The longest is what retention keeps. */
export const PERIODS = [7, 14, 30, 90] as const;
export type Period = (typeof PERIODS)[number];
export const DEFAULT_PERIOD: Period = 14;

const DAY_MS = 86_400_000;

/** The results a verification can have, in the order the jobs chart stacks them. */
export const JOB_RESULTS = ["skip", "audit", "fallback", "would_skip", "would_fall_back"] as const;
export type JobResult = (typeof JOB_RESULTS)[number];
type ByResult = Record<JobResult, number>;

const noJobs = (): ByResult => ({ skip: 0, audit: 0, fallback: 0, would_skip: 0, would_fall_back: 0 });

/** One UTC day of the period. */
export interface OverviewDay {
  /** Midnight UTC. */
  day: Date;
  jobs: ByResult;
  /** Estimated test time saved by that day's skips, in ms. */
  savedMs: number;
  /** Audits and shadow comparisons whose CI test job passed (agreed) or failed (mismatch). */
  agreed: number;
  mismatched: number;
}

export interface SuiteNumbers {
  suite: string;
  jobs: number;
  skipped: number;
  audited: number;
  /** The suite's median CI test-job duration (ms) the savings use, or null when no job report says. */
  medianMs: number | null;
  /** Whether `medianMs` is the repo's median, because the suite has no job report of its own. */
  repoMedian: boolean;
  savedMs: number;
  localMs: number;
  localRuns: number;
}

export interface Overview {
  /** The period's first moment: its first day's midnight, or the retention bound when later. */
  since: Date;
  days: OverviewDay[];
  jobs: ByResult & { total: number };
  saved: {
    ms: number;
    /** Skipped jobs whose suite has no CI test time to go by, so they add nothing. */
    unpriced: number;
  };
  local: { ms: number; runs: number };
  comparisons: { audits: number; shadow: number; agreed: number; mismatches: number; unknown: number };
  suites: SuiteNumbers[];
  /** Fallback reasons (the audit draw included) by count, top reason first. */
  reasons: { code: string; count: number }[];
  /** Mismatches the service recorded in the period, for the chart's annotation. */
  mismatches: { at: Date; commit: string }[];
}

/** The period as dates: the days it shows (UTC midnights, oldest first) and where it starts. */
export function periodWindow(period: Period, at: Date): { days: Date[]; since: Date } {
  const today = Math.floor(at.getTime() / DAY_MS) * DAY_MS;
  const days = Array.from({ length: period }, (_, index) => new Date(today - (period - 1 - index) * DAY_MS));
  const bound = retainedSince(at);
  return { days, since: days[0]! < bound ? bound : days[0]! };
}

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/**
 * Everything the Overview counts for one period, from the retained rows only. Savings: each
 * skipped job is priced at its suite's median CI test-job duration, taken from the latest job
 * report of every retained verification whose tests ran (passed or failed; a refused job ran no
 * tests); a suite without one is priced at the repo's median. "Audits agreed" counts audits and
 * shadow comparisons whose CI job reported: agreed when it passed, a mismatch when it failed.
 */
export async function overviewOf(db: Executor, repoId: number, period: Period, at: Date): Promise<Overview> {
  const { days, since } = periodWindow(period, at);
  const retained = retainedSince(at);
  const latestReport = sql`left join lateral (
      select r.outcome, r.duration_ms from job_reports r where r.verification_id = v.id order by r.seq desc limit 1
    ) report on true`;
  const [grouped, durations, local, recorded] = await Promise.all([
    db.execute<{ day: string; suite: string | null; result: string; reason: string | null; outcome: string | null; n: number }>(sql`
      select to_char(v.created_at at time zone 'UTC', 'YYYY-MM-DD') as day, v.suite, v.result, v.reason, report.outcome, count(*)::int as n
      from verifications v ${latestReport}
      where v.repo_id = ${repoId} and v.created_at >= ${since.toISOString()} and v.created_at <= ${at.toISOString()}
      group by 1, 2, 3, 4, 5`),
    db.execute<{ suite: string | null; ms: number }>(sql`
      select v.suite, report.duration_ms as ms
      from verifications v ${latestReport}
      where v.repo_id = ${repoId} and v.created_at >= ${retained.toISOString()} and report.outcome in ('passed', 'failed')`),
    db.execute<{ suite: string | null; ms: number; runs: number }>(sql`
      select suite, coalesce(sum(duration_ms), 0)::float8 as ms, count(duration_ms)::int as runs
      from ${runs}
      where repo_id = ${repoId} and received_at >= ${since.toISOString()} and received_at <= ${at.toISOString()}
      group by suite`),
    db.execute<{ at: string; commit: string }>(sql`
      select created_at as at, commit from mismatches
      where repo_id = ${repoId} and created_at >= ${since.toISOString()} and created_at <= ${at.toISOString()}
      order by created_at`),
  ]);

  // Each suite's median CI test-job duration, and the repo's for suites without a report.
  const bySuite = new Map<string, number[]>();
  for (const row of durations) {
    const key = row.suite ?? "";
    bySuite.set(key, [...(bySuite.get(key) ?? []), Number(row.ms)]);
  }
  const repoMedian = median([...durations].map((row) => Number(row.ms)));
  const priceOf = (suite: string): { ms: number | null; repo: boolean } => {
    const own = median(bySuite.get(suite) ?? []);
    return own !== null ? { ms: own, repo: false } : { ms: repoMedian, repo: repoMedian !== null };
  };

  const dayIndex = new Map(days.map((day, index) => [day.toISOString().slice(0, 10), index]));
  const perDay: OverviewDay[] = days.map((day) => ({ day, jobs: noJobs(), savedMs: 0, agreed: 0, mismatched: 0 }));
  const jobs = noJobs();
  const suites = new Map<string, SuiteNumbers>();
  const suiteOf = (name: string): SuiteNumbers => {
    let entry = suites.get(name);
    if (!entry) {
      const price = priceOf(name);
      entry = { suite: name, jobs: 0, skipped: 0, audited: 0, medianMs: price.ms, repoMedian: price.repo, savedMs: 0, localMs: 0, localRuns: 0 };
      suites.set(name, entry);
    }
    return entry;
  };
  const comparisons = { audits: 0, shadow: 0, agreed: 0, mismatches: 0, unknown: 0 };
  const reasons = new Map<string, number>();
  let unpriced = 0;
  for (const row of grouped) {
    const result = row.result as JobResult;
    if (!(JOB_RESULTS as readonly string[]).includes(result)) continue;
    const n = Number(row.n);
    const day = perDay[dayIndex.get(row.day) ?? -1];
    const suite = suiteOf(row.suite ?? "");
    jobs[result] += n;
    suite.jobs += n;
    if (day) day.jobs[result] += n;
    if (result === "skip") {
      suite.skipped += n;
      if (suite.medianMs === null) unpriced += n;
      else {
        suite.savedMs += n * suite.medianMs;
        if (day) day.savedMs += n * suite.medianMs;
      }
    }
    if (result === "audit") suite.audited += n;
    if (result === "audit" || result === "would_skip") {
      if (result === "audit") comparisons.audits += n;
      else if (row.outcome === "passed" || row.outcome === "failed") comparisons.shadow += n;
      if (row.outcome === "passed") {
        comparisons.agreed += n;
        if (day) day.agreed += n;
      } else if (row.outcome === "failed") {
        comparisons.mismatches += n;
        if (day) day.mismatched += n;
      } else if (result === "audit") comparisons.unknown += n;
    }
    if (row.reason) reasons.set(row.reason, (reasons.get(row.reason) ?? 0) + n);
  }
  let localMs = 0;
  let localRuns = 0;
  for (const row of local) {
    localMs += Number(row.ms);
    localRuns += Number(row.runs);
    if (row.suite && Number(row.runs) > 0) {
      const suite = suiteOf(row.suite);
      suite.localMs += Number(row.ms);
      suite.localRuns += Number(row.runs);
    }
  }
  const total = JOB_RESULTS.reduce((sum, result) => sum + jobs[result], 0);
  return {
    since,
    days: perDay,
    jobs: { ...jobs, total },
    saved: { ms: [...suites.values()].reduce((sum, suite) => sum + suite.savedMs, 0), unpriced },
    local: { ms: localMs, runs: localRuns },
    comparisons,
    suites: [...suites.values()].sort((a, b) => b.jobs - a.jobs || a.suite.localeCompare(b.suite)),
    reasons: [...reasons.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
    mismatches: [...recorded].map((row) => ({ at: new Date(row.at), commit: row.commit })),
  };
}
