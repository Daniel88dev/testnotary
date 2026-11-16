import { and, count, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import {
  AUDIT_RATE_DEFAULTS,
  COMPARED_RESULTS,
  CONFIG_FILE,
  GUARDED_DEFAULTS,
  INITIAL_REPO_SETTINGS,
  auditRateProblem,
  guardedGlobs,
  parseConfig,
  sandboxAuditDefault,
  type RepoMode,
  type RepoSettings,
} from "@testnotary/core";
import type { Mismatch } from "@testnotary/protocol";
import { jobReports, mismatchExplanations, mismatches, repoSettingChanges, verifications } from "../db/schema.ts";
import { accountsAsOf, type ShownAccount } from "./accounts.ts";
import { now } from "./config.ts";
import { fileAt, installationToken } from "./github.ts";
import { retainedSince } from "./history.ts";
import { latestSettingChange, type Executor, type RepoView } from "./installations.ts";
import { mismatchViews } from "./mismatches.ts";
import { shownResult } from "./shown-results.ts";

// A repo admin's settings and mismatch explanations (the Settings and Mismatches sections). Every
// change is a new row: a setting change carries the mode and both rates after it, an explanation
// is one per mismatch. The callers check that the person is an admin on GitHub, live; nothing here
// asks GitHub. The rules:
// - switching to enforce with fewer than 20 agreeing comparisons is a warning, never a block;
// - an open (unexplained) mismatch blocks enforce until an admin explains it, and an explanation
//   never switches enforce on by itself;
// - rates can be raised (a lower N), never set below 1 in 10, or 1 in 5 for sandbox tokens; the
//   sandbox rate defaults to twice the repo's.

/** Agreeing comparisons below which switching to enforce warns. */
export const ENFORCE_AGREEMENTS = 20;

export const EXPLANATION_CAUSES = ["flaky_test", "environment_difference", "false_attestation", "other"] as const;
export type ExplanationCause = (typeof EXPLANATION_CAUSES)[number];

/** How long an explanation's note may be. */
export const NOTE_MAX = 2000;

export const OPEN_MISMATCH_PROBLEM = "Explain the open mismatch before switching to enforce.";


export interface Comparisons {
  /** Comparisons whose CI test job reported passed or failed (a cancelled job sent nothing; a refused one ran no tests). */
  compared: number;
  /** Of those, the ones whose latest report passed. */
  agreed: number;
}

export interface ShadowRecord extends Comparisons {
  /** Mismatches recorded in the same window. */
  mismatches: number;
}

export interface SettingsShown extends RepoSettings {
  /** The sandbox rate is the default for the repo's rate (twice as often), so it follows a change of the repo's rate. */
  sandboxFollowsRepo: boolean;
  /** The latest setting change: when, who (null when Testnotary made it) and why. */
  lastChange: { at: Date; by: ShownAccount | null; reason: string } | undefined;
  /** The last 90 days, what retention keeps. */
  record: ShadowRecord;
  /** Since the latest mismatch, when there is one: the agreements that count towards enforce again. */
  sinceLastMismatch: (Comparisons & { at: Date }) | undefined;
  openMismatches: number;
  /** What switching to enforce now would warn about. Empty in enforce mode. */
  warnings: string[];
}

/** The settings in effect and the evidence beside the toggle. */
export async function settingsOf(db: Executor, repoId: number): Promise<SettingsShown> {
  const latest = await latestSettingChange(db, repoId);
  const settings = settingsFrom(latest);
  const since = retainedSince();
  const [record, [lastMismatch], open] = await Promise.all([
    comparisons(db, repoId, since),
    db.select({ at: mismatches.createdAt }).from(mismatches).where(eq(mismatches.repoId, repoId)).orderBy(desc(mismatches.createdAt)).limit(1),
    openMismatchCount(db, repoId),
  ]);
  const [recentMismatches] = await db
    .select({ n: count() })
    .from(mismatches)
    .where(and(eq(mismatches.repoId, repoId), gte(mismatches.createdAt, since)));
  const sinceLastMismatch = lastMismatch ? { at: lastMismatch.at, ...(await comparisons(db, repoId, lastMismatch.at)) } : undefined;
  const [by] = latest?.changedBy ? await accountsAsOf(db, [{ accountId: latest.changedBy, at: latest.at }]) : [];
  return {
    ...settings,
    sandboxFollowsRepo: settings.sandboxAuditOneIn === sandboxAuditDefault(settings.auditOneIn),
    lastChange: latest ? { at: latest.at, by: by ?? null, reason: latest.reason } : undefined,
    record: { ...record, mismatches: recentMismatches?.n ?? 0 },
    sinceLastMismatch,
    openMismatches: open,
    warnings: settings.mode === "enforce" ? [] : enforceWarnings(sinceLastMismatch ?? record, sinceLastMismatch !== undefined),
  };
}

function enforceWarnings(evidence: Comparisons, sinceMismatch: boolean): string[] {
  if (evidence.agreed >= ENFORCE_AGREEMENTS) return [];
  return [`Fewer than ${ENFORCE_AGREEMENTS} agreeing comparisons${sinceMismatch ? " since the last mismatch" : ""}: ${evidence.agreed} so far.`];
}

/** Comparisons since `since` (by what the job did: a would-skip whose signature would fail is none), each counted by its CI job's latest report. */
async function comparisons(db: Executor, repoId: number, since: Date): Promise<Comparisons> {
  const compared = await db
    .select({ id: verifications.id })
    .from(verifications)
    .where(and(eq(verifications.repoId, repoId), inArray(shownResult, [...COMPARED_RESULTS]), gte(verifications.createdAt, since)));
  if (compared.length === 0) return { compared: 0, agreed: 0 };
  const reports = await db
    .selectDistinctOn([jobReports.verificationId], { outcome: jobReports.outcome })
    .from(jobReports)
    .where(
      inArray(
        jobReports.verificationId,
        compared.map((row) => row.id),
      ),
    )
    .orderBy(jobReports.verificationId, desc(jobReports.seq));
  const ran = reports.filter((report) => report.outcome === "passed" || report.outcome === "failed");
  return { compared: ran.length, agreed: ran.filter((report) => report.outcome === "passed").length };
}

function settingsFrom(row: { mode: string; auditOneIn: number; sandboxAuditOneIn: number } | undefined): RepoSettings {
  if (!row) return { ...INITIAL_REPO_SETTINGS };
  return { mode: row.mode === "enforce" ? "enforce" : "shadow", auditOneIn: row.auditOneIn, sandboxAuditOneIn: row.sandboxAuditOneIn };
}

export interface SettingsRequest {
  mode?: RepoMode;
  auditOneIn?: number;
  /** `default`: twice as often as the repo's rate. Left out, a sandbox rate at its default follows the repo's rate. */
  sandboxAuditOneIn?: number | "default";
}

export type SettingsChange = { ok: true; settings: RepoSettings; warnings: string[] } | { ok: false; problem: string };

/**
 * An admin's change of the mode or the rates, as one new setting-change row (none when nothing
 * changes). Refused while a mismatch is open if the repo would be in enforce mode afterwards, and
 * for a rate below the defaults. Switching to enforce answers its warnings and switches anyway.
 */
export async function changeRepoSettings(db: Executor, input: { repoId: number; by: { id: number } } & SettingsRequest): Promise<SettingsChange> {
  const current = settingsFrom(await latestSettingChange(db, input.repoId));
  const auditOneIn = input.auditOneIn ?? current.auditOneIn;
  const followed = current.sandboxAuditOneIn === sandboxAuditDefault(current.auditOneIn);
  const sandboxAuditOneIn =
    input.sandboxAuditOneIn === "default" || (input.sandboxAuditOneIn === undefined && followed && Number.isInteger(auditOneIn))
      ? sandboxAuditDefault(auditOneIn)
      : (input.sandboxAuditOneIn ?? current.sandboxAuditOneIn);
  const next: RepoSettings = { mode: input.mode ?? current.mode, auditOneIn, sandboxAuditOneIn };
  const problem = auditRateProblem(next);
  if (problem) return { ok: false, problem };
  if (next.mode === "enforce" && (await openMismatchCount(db, input.repoId)) > 0) return { ok: false, problem: OPEN_MISMATCH_PROBLEM };
  const switching = next.mode === "enforce" && current.mode !== "enforce";
  const warnings = switching ? (await settingsOf(db, input.repoId)).warnings : [];
  if (next.mode === current.mode && next.auditOneIn === current.auditOneIn && next.sandboxAuditOneIn === current.sandboxAuditOneIn) {
    return { ok: true, settings: current, warnings };
  }
  await db.insert(repoSettingChanges).values({ repoId: input.repoId, ...next, changedBy: input.by.id, reason: "admin", at: now() });
  return { ok: true, settings: next, warnings };
}

/** The rates an admin can pick: every whole 1 in N from the default down to 1 in 1. */
export const RATE_CHOICES = {
  laptop: Array.from({ length: AUDIT_RATE_DEFAULTS.auditOneIn }, (_, i) => AUDIT_RATE_DEFAULTS.auditOneIn - i),
  sandbox: Array.from({ length: AUDIT_RATE_DEFAULTS.sandboxAuditOneIn }, (_, i) => AUDIT_RATE_DEFAULTS.sandboxAuditOneIn - i),
};

export interface Explanation {
  cause: ExplanationCause;
  note: string;
  by: ShownAccount;
  at: Date;
}

export interface MismatchShown {
  mismatch: Mismatch;
  /** Undefined while the mismatch is open. */
  explanation: Explanation | undefined;
}

/** Every mismatch of the repo (kept while it is installed), newest first, with its explanation if it has one. */
export async function repoMismatches(db: Executor, repoId: number): Promise<MismatchShown[]> {
  const rows = await db.select().from(mismatches).where(eq(mismatches.repoId, repoId)).orderBy(desc(mismatches.createdAt));
  if (rows.length === 0) return [];
  const [views, explanations] = await Promise.all([
    mismatchViews(db, rows),
    db
      .select()
      .from(mismatchExplanations)
      .where(
        inArray(
          mismatchExplanations.mismatchId,
          rows.map((row) => row.id),
        ),
      ),
  ]);
  const by = await accountsAsOf(
    db,
    explanations.map((row) => ({ accountId: row.explainedBy, at: row.at })),
  );
  const explained = new Map(
    explanations.map((row, index) => [row.mismatchId, { cause: row.cause as ExplanationCause, note: row.note, by: by[index]!, at: row.at } satisfies Explanation]),
  );
  return views.map((mismatch) => ({ mismatch, explanation: explained.get(mismatch.id) }));
}

async function openMismatchCount(db: Executor, repoId: number): Promise<number> {
  return (await openMismatchCounts(db, [repoId])).get(repoId) ?? 0;
}

/** Each repo's mismatches with no explanation yet: the amber badge. Repos with none are left out. */
export async function openMismatchCounts(db: Executor, repoIds: number[]): Promise<Map<number, number>> {
  if (repoIds.length === 0) return new Map();
  const rows = await db
    .select({ repoId: mismatches.repoId, n: count() })
    .from(mismatches)
    .leftJoin(mismatchExplanations, eq(mismatchExplanations.mismatchId, mismatches.id))
    .where(and(inArray(mismatches.repoId, repoIds), isNull(mismatchExplanations.id)))
    .groupBy(mismatches.repoId);
  return new Map(rows.map((row) => [row.repoId, row.n]));
}

/**
 * An admin's explanation of one of the repo's mismatches. False when the cause is not one of the
 * four, the mismatch is not the repo's, or it is explained already (an explanation is never
 * replaced). The repo stays in shadow mode: switching enforce back on is a separate change.
 */
export async function explainMismatch(
  db: Executor,
  input: { repoId: number; mismatchId: string; by: { id: number }; cause: string; note?: string },
): Promise<boolean> {
  if (!(EXPLANATION_CAUSES as readonly string[]).includes(input.cause)) return false;
  if (!/^[0-9a-f-]{36}$/i.test(input.mismatchId)) return false;
  const [mismatch] = await db
    .select({ id: mismatches.id })
    .from(mismatches)
    .where(and(eq(mismatches.id, input.mismatchId), eq(mismatches.repoId, input.repoId)));
  if (!mismatch) return false;
  const note = (input.note ?? "").trim().slice(0, NOTE_MAX);
  const inserted = await db
    .insert(mismatchExplanations)
    .values({ mismatchId: mismatch.id, cause: input.cause, note, explainedBy: input.by.id, at: now() })
    .onConflictDoNothing({ target: mismatchExplanations.mismatchId })
    .returning({ id: mismatchExplanations.id });
  return inserted.length > 0;
}

export interface GuardedFilesShown {
  /** The product defaults, which a repo can't remove. */
  defaults: readonly string[];
  /** What the repo's `testnotary.json` on the default branch adds (its `guarded`, and its `nodeVersionFile`). */
  added: string[];
  /** Where `added` came from: the config, no config file, a config that doesn't parse, or GitHub could not be asked. */
  source: "config" | "no_config" | "invalid" | "unavailable";
}

/**
 * The guarded globs in effect for pull requests into the default branch, read-only: the product
 * defaults, then what the default branch's `testnotary.json` adds (`guardedGlobs`). A pull request
 * is checked against its own base's config, so another base branch may differ.
 */
export async function guardedFilesOf(repo: Pick<RepoView, "installationId" | "fullName">): Promise<GuardedFilesShown> {
  let text: string | undefined;
  try {
    text = await fileAt(await installationToken(repo.installationId), repo.fullName, CONFIG_FILE);
  } catch {
    return { defaults: GUARDED_DEFAULTS, added: [], source: "unavailable" };
  }
  if (text === undefined) return { defaults: GUARDED_DEFAULTS, added: [], source: "no_config" };
  const parsed = parseConfig(text);
  if (!parsed.ok) return { defaults: GUARDED_DEFAULTS, added: [], source: "invalid" };
  return { defaults: GUARDED_DEFAULTS, added: guardedGlobs(parsed.config).filter((glob) => !GUARDED_DEFAULTS.includes(glob)), source: "config" };
}

/** The mismatch recorded on a verification of the repo, by the verification's id. */
export async function mismatchIdOfVerification(db: Executor, repoId: number, verificationId: string): Promise<string | undefined> {
  if (!/^[0-9a-f-]{36}$/i.test(verificationId)) return undefined;
  const [row] = await db
    .select({ id: mismatches.id })
    .from(mismatches)
    .where(and(eq(mismatches.verificationId, verificationId), eq(mismatches.repoId, repoId)));
  return row?.id;
}
