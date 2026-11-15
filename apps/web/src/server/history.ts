import { createHash } from "node:crypto";
import { and, count, desc, eq, gte, inArray, sql, type SQL } from "drizzle-orm";
import type { FallbackReason, VerificationResult } from "@testnotary/core";
import type { CiEnvironment, RunEnvironment, SessionLabels } from "@testnotary/protocol";
import { attestations, jobReports, mismatches, runs, tokens, verifications } from "../db/schema.ts";
import { accountsAsOf, type ShownAccount } from "./accounts.ts";
import { now } from "./config.ts";
import type { Executor } from "./installations.ts";
import { behindBy, commitAuthor, installationToken, type CommitAuthor } from "./github.ts";
import { currentNames } from "./tokens.ts";

// What the dashboard reads about a repo's runs and verifications: the Verifications and Runs
// lists, the run page and the commit page, and the per-suite last results. Runs, attestations,
// verifications and job reports are hard-deleted at 90 days, so every list here looks back 90 days
// at most and nothing is aggregated beyond that. Every account is named through `accountsAsOf`, as
// of the record's own time, so a deleted account's records read *deleted account*.
//
// Overview (T-826), People (T-827) and Settings (T-828) read from here too: `verificationRows`
// and `runRows` take any filter, `retainedSince()` is the window's start.

/** How far back every dashboard list looks: what retention keeps. */
export const RETAINED_DAYS = 90;

/** The start of the retained window, on the service clock. */
export function retainedSince(at: Date = now()): Date {
  return new Date(at.getTime() - RETAINED_DAYS * 86_400_000);
}

export type TokenKind = "laptop" | "sandbox";

/** A token as the dashboard names it: its kind and its current name (after renames). */
export interface TokenShown {
  id: string;
  kind: TokenKind;
  name: string;
}

/** Who a record names: the account (or *deleted account*) and the token it used. */
export interface Attester {
  account: ShownAccount;
  token: TokenShown;
}

/** A CI job's latest report on a verification. */
export interface JobReportShown {
  outcome: "passed" | "failed" | "refused";
  durationMs: number;
  environment: CiEnvironment;
  createdAt: Date;
}

/** The attestation a verification matched, with the run it came from. */
export interface MatchedAttestation {
  id: string;
  runId: string;
  commit: string;
  tree: string;
  endedAt: Date;
  createdAt: Date;
  format: string;
  /** The canonical payload exactly as stored. */
  payload: string;
  attester: Attester;
  /** The run's environment, labels and flags, while the run is retained. */
  run: { environment: RunEnvironment | null; session: SessionLabels | null; notPinned: string[]; durationMs: number | null } | null;
}

/** One verification as the dashboard shows it. */
export interface VerificationShown {
  id: string;
  createdAt: Date;
  commit: string;
  tree: string;
  suite: string | null;
  event: string;
  mode: "shadow" | "enforce";
  result: VerificationResult;
  reason: FallbackReason | null;
  detail: string | null;
  environment: CiEnvironment;
  /** The Actions run and job, from the job's OIDC token: the CI log link. */
  ci: { runId: number; attempt: number | null; jobId: number | null } | null;
  attestation: MatchedAttestation | null;
  jobReport: JobReportShown | null;
  /** A mismatch was recorded on it. */
  mismatch: { id: string } | null;
}

/** The Verifications list's result filter (prototype segments): `ran` is a fallback, `shadow` either *would* result. */
export const RESULT_FILTERS = ["skip", "audit", "ran", "shadow"] as const;
export type ResultFilter = (typeof RESULT_FILTERS)[number];

function resultCondition(filter: ResultFilter): SQL {
  switch (filter) {
    case "skip":
      return eq(verifications.result, "skip");
    case "audit":
      return eq(verifications.result, "audit");
    case "ran":
      return eq(verifications.result, "fallback");
    case "shadow":
      return inArray(verifications.result, ["would_skip", "would_fall_back"]);
  }
}

/** Verifications matching `where`, newest first, as the dashboard shows them. */
export async function verificationRows(db: Executor, where: SQL | undefined, page: { limit?: number; offset?: number } = {}): Promise<VerificationShown[]> {
  let query = db
    .select({ verification: verifications, attestation: attestations, run: runs, token: tokens })
    .from(verifications)
    .leftJoin(attestations, eq(attestations.id, verifications.attestationId))
    .leftJoin(runs, eq(runs.id, attestations.runId))
    .leftJoin(tokens, eq(tokens.id, attestations.tokenId))
    .where(where)
    .orderBy(desc(verifications.createdAt), desc(verifications.id))
    .$dynamic();
  if (page.limit !== undefined) query = query.limit(page.limit);
  if (page.offset) query = query.offset(page.offset);
  const rows = await query;
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.verification.id);
  const [reports, recorded, names, accounts] = await Promise.all([
    db
      .selectDistinctOn([jobReports.verificationId])
      .from(jobReports)
      .where(inArray(jobReports.verificationId, ids))
      .orderBy(jobReports.verificationId, desc(jobReports.seq)),
    db.select({ id: mismatches.id, verificationId: mismatches.verificationId }).from(mismatches).where(inArray(mismatches.verificationId, ids)),
    currentNames(
      db,
      rows.flatMap((row) => (row.token ? [row.token] : [])),
    ),
    accountsAsOf(
      db,
      rows.flatMap((row) => (row.attestation ? [{ accountId: row.attestation.accountId, at: row.attestation.createdAt }] : [])),
    ),
  ]);
  const reportOf = new Map(reports.map((report) => [report.verificationId, report]));
  const mismatchOf = new Map(recorded.map((row) => [row.verificationId, row.id]));
  let named = 0;
  return rows.map(({ verification, attestation, run, token }) => {
    const report = reportOf.get(verification.id);
    const mismatchId = mismatchOf.get(verification.id);
    return {
      id: verification.id,
      createdAt: verification.createdAt,
      commit: verification.commit,
      tree: verification.tree,
      suite: verification.suite,
      event: verification.event,
      mode: verification.mode === "enforce" ? "enforce" : "shadow",
      result: verification.result as VerificationResult,
      reason: verification.reason as FallbackReason | null,
      detail: verification.detail,
      environment: verification.environment,
      ci: verification.ciRunId ? { runId: verification.ciRunId, attempt: verification.ciRunAttempt, jobId: verification.ciJobId } : null,
      attestation: attestation
        ? {
            id: attestation.id,
            runId: attestation.runId,
            commit: attestation.commit,
            tree: attestation.tree,
            endedAt: attestation.endedAt,
            createdAt: attestation.createdAt,
            format: attestation.format,
            payload: attestation.payload.toString("utf8"),
            attester: {
              account: accounts[named++]!,
              token: { id: attestation.tokenId, kind: token?.kind === "sandbox" ? "sandbox" : "laptop", name: (token && names.get(token.id)) ?? "" },
            },
            run: run ? { environment: run.environment, session: run.session, notPinned: run.notPinned, durationMs: run.durationMs } : null,
          }
        : null,
      jobReport: report
        ? { outcome: report.outcome as JobReportShown["outcome"], durationMs: report.durationMs, environment: report.environment, createdAt: report.createdAt }
        : null,
      mismatch: mismatchId ? { id: mismatchId } : null,
    };
  });
}

export interface VerificationFilter {
  result?: ResultFilter;
  reason?: FallbackReason;
  suite?: string;
}

/**
 * The Verifications list: the repo's retained verifications matching the filter, newest first,
 * the first `limit`, with the total and how many each result segment would show under the same
 * reason and suite.
 */
export async function listVerifications(
  db: Executor,
  repoId: number,
  filter: VerificationFilter,
  limit: number,
): Promise<{ rows: VerificationShown[]; total: number; segments: Record<ResultFilter | "all", number>; suites: string[] }> {
  const base = [eq(verifications.repoId, repoId), gte(verifications.createdAt, retainedSince())];
  const narrowed = [...base, ...(filter.reason ? [eq(verifications.reason, filter.reason)] : []), ...(filter.suite ? [eq(verifications.suite, filter.suite)] : [])];
  const where = and(...narrowed, ...(filter.result ? [resultCondition(filter.result)] : []));
  const [rows, byResult, suites] = await Promise.all([
    verificationRows(db, where, { limit }),
    db
      .select({ result: verifications.result, n: count() })
      .from(verifications)
      .where(and(...narrowed))
      .groupBy(verifications.result),
    db
      .selectDistinct({ suite: verifications.suite })
      .from(verifications)
      .where(and(...base))
      .orderBy(verifications.suite),
  ]);
  const of = (results: string[]) => byResult.filter((row) => results.includes(row.result)).reduce((sum, row) => sum + row.n, 0);
  const segments = {
    all: of(byResult.map((row) => row.result)),
    skip: of(["skip"]),
    audit: of(["audit"]),
    ran: of(["fallback"]),
    shadow: of(["would_skip", "would_fall_back"]),
  };
  return { rows, total: filter.result ? segments[filter.result] : segments.all, segments, suites: suites.flatMap((row) => (row.suite ? [row.suite] : [])) };
}

/** Every verification of one commit CI built, newest first. */
export async function commitVerifications(db: Executor, repoId: number, commit: string): Promise<VerificationShown[]> {
  return verificationRows(db, and(eq(verifications.repoId, repoId), eq(verifications.commit, commit)));
}

/** What the commit page asks GitHub: who wrote the commit, and for audits and mismatches whether the base moved. */
export interface CommitFacts {
  /** The commit's author; for GitHub's test merge commit on a pull request, the pull request head's. Undefined when GitHub could not be asked. */
  author: (CommitAuthor & { ofHead: boolean }) | undefined;
  /** By verification id, for audits and mismatches: CI's base had commits the attested commit lacked. Undefined when GitHub could not be asked. */
  baseMoved: Map<string, boolean | undefined>;
}

/**
 * The commit page's GitHub facts, asked live with the installation token (Contents read). GitHub
 * trouble never breaks the page: what can't be asked reads as unknown.
 */
export async function commitFacts(repo: { installationId: number; fullName: string }, commit: string, shown: VerificationShown[]): Promise<CommitFacts> {
  const facts: CommitFacts = { author: undefined, baseMoved: new Map() };
  let token: string;
  let built: CommitAuthor | undefined;
  try {
    token = await installationToken(repo.installationId);
    built = await commitAuthor(token, repo.fullName, commit);
  } catch {
    return facts;
  }
  if (!built) return facts;
  try {
    const head = built.parents.length === 2 && shown.some((verification) => verification.event === "pull_request") ? built.parents[1] : undefined;
    const author = head ? await commitAuthor(token, repo.fullName, head) : built;
    facts.author = author ? { ...author, ofHead: head !== undefined } : undefined;
  } catch {
    facts.author = undefined;
  }
  const base = built.parents[0];
  for (const verification of shown) {
    if (!(verification.result === "audit" || verification.mismatch) || !verification.attestation) continue;
    if (!base) {
      facts.baseMoved.set(verification.id, false);
      continue;
    }
    try {
      facts.baseMoved.set(verification.id, (await behindBy(token, repo.fullName, base, verification.attestation.commit)) > 0);
    } catch {
      facts.baseMoved.set(verification.id, undefined);
    }
  }
  return facts;
}

/** Each suite's latest verification in the window, by suite name: the repo column's Suites. */
export async function suitesLastResult(db: Executor, repoId: number): Promise<{ suite: string; result: VerificationResult; at: Date }[]> {
  const rows = await db
    .selectDistinctOn([verifications.suite], { suite: verifications.suite, result: verifications.result, at: verifications.createdAt })
    .from(verifications)
    .where(and(eq(verifications.repoId, repoId), gte(verifications.createdAt, retainedSince())))
    .orderBy(verifications.suite, desc(verifications.createdAt));
  return rows.flatMap((row) => (row.suite ? [{ suite: row.suite, result: row.result as VerificationResult, at: row.at }] : []));
}

/** Each repo's latest verification in the window: home's "Last verification". */
export async function lastVerifications(db: Executor, repoIds: number[]): Promise<Map<number, Date>> {
  if (repoIds.length === 0) return new Map();
  const rows = await db
    .select({ repoId: verifications.repoId, at: sql<Date>`max(${verifications.createdAt})`.mapWith(verifications.createdAt) })
    .from(verifications)
    .where(and(inArray(verifications.repoId, repoIds), gte(verifications.createdAt, retainedSince())))
    .groupBy(verifications.repoId);
  return new Map(rows.map((row) => [row.repoId, row.at]));
}

/** One run as the dashboard lists it. */
export interface RunShown {
  id: string;
  receivedAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
  outcome: "passed" | "failed" | "refused";
  refusal: string | null;
  suite: string | null;
  tree: string | null;
  commit: string | null;
  exitCode: number | null;
  durationMs: number | null;
  /** The token's account (for a sandbox token, its creator), as of the upload. */
  account: ShownAccount;
  token: TokenShown;
  session: SessionLabels | null;
  /** The suite failed and then passed on the same tree. */
  flaky: boolean;
}

export const RUN_OUTCOMES = ["passed", "failed", "refused"] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

type RunRow = typeof runs.$inferSelect;

/**
 * The (suite, tree) pairs of the repo's retained runs where the suite failed and later passed on
 * the same tree: the flaky-suite flag. Keys are `suite tree`.
 */
async function flakyPairs(db: Executor, repoId: number): Promise<Set<string>> {
  const rows = await db.execute<{ suite: string; tree: string }>(sql`
    select distinct f.suite, f.tree
    from ${runs} f
    join ${runs} p on p.repo_id = f.repo_id and p.suite = f.suite and p.tree = f.tree
    where f.repo_id = ${repoId} and f.outcome = 'failed' and p.outcome = 'passed'
      and p.ended_at > f.ended_at and f.received_at >= ${retainedSince().toISOString()}`);
  return new Set([...rows].map((row) => `${row.suite} ${row.tree}`));
}

async function runViews(db: Executor, rows: { run: RunRow; token: typeof tokens.$inferSelect }[], flaky: Set<string>): Promise<RunShown[]> {
  const [names, accounts] = await Promise.all([
    currentNames(
      db,
      rows.map((row) => row.token),
    ),
    accountsAsOf(
      db,
      rows.map((row) => ({ accountId: row.run.accountId, at: row.run.receivedAt })),
    ),
  ]);
  return rows.map(({ run, token }, index) => ({
    id: run.id,
    receivedAt: run.receivedAt,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    outcome: run.outcome as RunOutcome,
    refusal: run.refusal,
    suite: run.suite,
    tree: run.tree,
    commit: run.commit,
    exitCode: run.exitCode,
    durationMs: run.durationMs,
    account: accounts[index]!,
    token: { id: token.id, kind: token.kind === "sandbox" ? "sandbox" : "laptop", name: names.get(token.id) ?? token.name },
    session: run.session,
    flaky: run.suite !== null && run.tree !== null && flaky.has(`${run.suite} ${run.tree}`),
  }));
}

/** The Runs list: the repo's retained runs, newest upload first, the first `limit`, with counts per outcome and the flaky suites. */
export async function listRuns(
  db: Executor,
  repoId: number,
  outcome: RunOutcome | undefined,
  limit: number,
): Promise<{ rows: RunShown[]; total: number; counts: Record<RunOutcome | "all", number>; flakySuites: number }> {
  const base = and(eq(runs.repoId, repoId), gte(runs.receivedAt, retainedSince()));
  const [rows, byOutcome, flaky] = await Promise.all([
    db
      .select({ run: runs, token: tokens })
      .from(runs)
      .innerJoin(tokens, eq(tokens.id, runs.tokenId))
      .where(outcome ? and(base, eq(runs.outcome, outcome)) : base)
      .orderBy(desc(runs.receivedAt), desc(runs.id))
      .limit(limit),
    db.select({ outcome: runs.outcome, n: count() }).from(runs).where(base).groupBy(runs.outcome),
    flakyPairs(db, repoId),
  ]);
  const of = (name: string) => byOutcome.find((row) => row.outcome === name)?.n ?? 0;
  const counts = { all: byOutcome.reduce((sum, row) => sum + row.n, 0), passed: of("passed"), failed: of("failed"), refused: of("refused") };
  return { rows: await runViews(db, rows, flaky), total: outcome ? counts[outcome] : counts.all, counts, flakySuites: flaky.size };
}

/** Everything the run page shows. */
export interface RunDetail extends RunShown {
  command: string[] | null;
  environment: RunEnvironment | null;
  passedEnv: string[];
  guardedMatched: string[];
  warnings: string[];
  notPinned: string[];
  baselineOverrides: string[];
  attestation: { id: string; format: string; payload: string; sha256: string; endedAt: Date } | null;
  /** The verifications that matched its attestation, newest first. */
  verifications: VerificationShown[];
}

/** One of the repo's runs for its page, or undefined. */
export async function runDetail(db: Executor, repoId: number, runId: string): Promise<RunDetail | undefined> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) return undefined;
  const [row] = await db
    .select({ run: runs, token: tokens, attestation: attestations })
    .from(runs)
    .innerJoin(tokens, eq(tokens.id, runs.tokenId))
    .leftJoin(attestations, eq(attestations.runId, runs.id))
    .where(and(eq(runs.id, runId), eq(runs.repoId, repoId)));
  if (!row) return undefined;
  const { run, token, attestation } = row;
  const [[shown], used] = await Promise.all([
    runViews(db, [{ run, token }], await flakyPairs(db, repoId)),
    attestation ? verificationRows(db, and(eq(verifications.repoId, repoId), eq(verifications.attestationId, attestation.id))) : Promise.resolve([]),
  ]);
  return {
    ...shown!,
    command: run.command,
    environment: run.environment,
    passedEnv: run.passedEnv,
    guardedMatched: run.guardedMatched,
    warnings: run.warnings,
    notPinned: run.notPinned,
    baselineOverrides: run.baselineOverrides,
    attestation: attestation
      ? {
          id: attestation.id,
          format: attestation.format,
          payload: attestation.payload.toString("utf8"),
          sha256: createHash("sha256").update(attestation.payload).digest("hex"),
          endedAt: attestation.endedAt,
        }
      : null,
    verifications: used,
  };
}
