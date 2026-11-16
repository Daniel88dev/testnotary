import { and, desc, eq, gt, inArray } from "drizzle-orm";
import { DELETED_ACCOUNT, type Mismatch, type SkippedCommit } from "@testnotary/protocol";
import { attestations, jobReports, mismatches, repoSettingChanges, runs, tokens, verifications } from "../db/schema.ts";
import { accountsAsOf } from "./accounts.ts";
import { now } from "./config.ts";
import type { Executor } from "./installations.ts";
import { currentNames } from "./tokens.ts";

// Mismatches: a CI job's report that fails on an audit, or on a shadow verification that would
// have skipped. Each one is recorded against the account and the token (with its type), copies in
// everything it will ever be shown with, and sends its repo back to shadow mode at once. Nothing
// is revoked and no other repo is touched. A cancelled job sends no report, so it is neither an
// agreement nor a mismatch; a refused one (`exec` would not start the tests) is neither too.

type VerificationRow = typeof verifications.$inferSelect;
type JobReportRow = typeof jobReports.$inferSelect;
type MismatchRow = typeof mismatches.$inferSelect;

/** The verification results a failing report turns into a mismatch. */
const COMPARED = ["audit", "would_skip"] as const;

/**
 * Records the mismatch a job report makes, if it makes one, and returns the repo to shadow mode.
 * Run it in the transaction that stores the report. At most one mismatch per verification: a re-run
 * that fails again adds a report, not a second mismatch, and one that passes takes nothing back.
 */
export async function recordMismatch(tx: Executor, verification: VerificationRow, report: JobReportRow): Promise<MismatchRow | undefined> {
  if (report.outcome !== "failed" || !(COMPARED as readonly string[]).includes(verification.result) || !verification.attestationId) return undefined;
  const [matched] = await tx
    .select({ attestation: attestations, run: runs, token: tokens })
    .from(attestations)
    .innerJoin(runs, eq(runs.id, attestations.runId))
    .innerJoin(tokens, eq(tokens.id, attestations.tokenId))
    .where(eq(attestations.id, verification.attestationId));
  if (!matched) return undefined;
  const { attestation, run, token } = matched;
  const tokenName = (await currentNames(tx, [token])).get(token.id) ?? token.name;
  const [row] = await tx
    .insert(mismatches)
    .values({
      repoId: verification.repoId,
      verificationId: verification.id,
      jobReportId: report.id,
      result: verification.result,
      suite: verification.suite,
      commit: verification.commit,
      tree: verification.tree,
      event: verification.event,
      accountId: attestation.accountId,
      tokenId: token.id,
      tokenKind: token.kind,
      tokenName,
      attestationId: attestation.id,
      runId: run.id,
      attestedCommit: attestation.commit,
      attestedAt: attestation.createdAt,
      attestationEndedAt: attestation.endedAt,
      attestationFormat: attestation.format,
      attestationPayload: attestation.payload,
      signature: attestation.signature ?? null,
      runEnvironment: run.environment,
      session: run.session,
      ciEnvironment: report.environment,
      outcome: report.outcome,
      durationMs: report.durationMs,
      skippedCommits: await skippedSinceLastAgreeingAudit(tx, verification.repoId, attestation.accountId),
      createdAt: now(),
    })
    .onConflictDoNothing({ target: mismatches.verificationId })
    .returning();
  if (!row) return undefined;
  await returnToShadow(tx, verification.repoId);
  return row;
}

/**
 * Every commit CI skipped in the repo on the account's attestations since the account's last
 * agreeing audit (an audit whose latest report passed), newest first, one entry per commit and
 * suite: what an admin may want to re-run by hand. As far as retention still holds them.
 */
async function skippedSinceLastAgreeingAudit(tx: Executor, repoId: number, accountId: number): Promise<SkippedCommit[]> {
  const audits = await tx
    .select({ id: verifications.id, createdAt: verifications.createdAt })
    .from(verifications)
    .innerJoin(attestations, eq(attestations.id, verifications.attestationId))
    .where(and(eq(verifications.repoId, repoId), eq(attestations.accountId, accountId), eq(verifications.result, "audit")))
    .orderBy(desc(verifications.createdAt));
  let since = new Date(0);
  if (audits.length > 0) {
    const reports = await tx
      .select({ verificationId: jobReports.verificationId, outcome: jobReports.outcome })
      .from(jobReports)
      .where(inArray(jobReports.verificationId, audits.map((audit) => audit.id)))
      .orderBy(desc(jobReports.seq));
    const latestOutcome = new Map<string, string>();
    for (const report of reports) if (!latestOutcome.has(report.verificationId)) latestOutcome.set(report.verificationId, report.outcome);
    since = audits.find((audit) => latestOutcome.get(audit.id) === "passed")?.createdAt ?? since;
  }
  const skips = await tx
    .select({ id: verifications.id, commit: verifications.commit, tree: verifications.tree, suite: verifications.suite, event: verifications.event, createdAt: verifications.createdAt })
    .from(verifications)
    .innerJoin(attestations, eq(attestations.id, verifications.attestationId))
    .where(and(eq(verifications.repoId, repoId), eq(attestations.accountId, accountId), eq(verifications.result, "skip"), gt(verifications.createdAt, since)))
    .orderBy(desc(verifications.createdAt));
  const seen = new Set<string>();
  const commits: SkippedCommit[] = [];
  for (const skip of skips) {
    const key = `${skip.commit} ${skip.suite ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    commits.push({ commit: skip.commit, tree: skip.tree, suite: skip.suite, event: skip.event, verificationId: skip.id, at: skip.createdAt.toISOString() });
  }
  return commits;
}

/** Sends the repo back to shadow mode, as Testnotary's own setting change, keeping its rates. Nothing to do when it is in shadow mode already. */
async function returnToShadow(tx: Executor, repoId: number): Promise<void> {
  const [current] = await tx.select().from(repoSettingChanges).where(eq(repoSettingChanges.repoId, repoId)).orderBy(desc(repoSettingChanges.id)).limit(1);
  if (!current || current.mode !== "enforce") return;
  await tx.insert(repoSettingChanges).values({
    repoId,
    mode: "shadow",
    auditOneIn: current.auditOneIn,
    sandboxAuditOneIn: current.sandboxAuditOneIn,
    changedBy: null,
    reason: "mismatch",
    at: now(),
  });
}

/** The mismatch recorded on a verification, if any. */
export async function mismatchOfVerification(db: Executor, verificationId: string): Promise<Mismatch | null> {
  const [row] = await db.select().from(mismatches).where(eq(mismatches.verificationId, verificationId));
  return row ? (await mismatchViews(db, [row]))[0]! : null;
}

/**
 * Mismatches as they are shown, from their own copies only: none of the rows they came from need
 * still exist. The account is named as of the attestation, so a deleted account reads *deleted
 * account*.
 */
export async function mismatchViews(db: Executor, rows: MismatchRow[]): Promise<Mismatch[]> {
  const accounts = await accountsAsOf(
    db,
    rows.map((row) => ({ accountId: row.accountId, at: row.attestedAt })),
  );
  return rows.map((row, index) => {
    // A deleted account's mismatch keeps its copy of the payload, the signature and the token's
    // name (never removed on request), but no read hands them out: the payload names the account's
    // GitHub id, the signature its key, and the name is free text its owner picked.
    const withheld = accounts[index]!.id === DELETED_ACCOUNT.id;
    return {
      id: row.id,
      result: row.result === "audit" ? "audit" : "would_skip",
      suite: row.suite,
      commit: row.commit,
      tree: row.tree,
      event: row.event,
      account: accounts[index]!,
      token: { id: row.tokenId, kind: row.tokenKind === "sandbox" ? "sandbox" : "laptop", name: withheld ? "" : row.tokenName },
      attestation: {
        id: row.attestationId,
        runId: row.runId,
        commit: row.attestedCommit,
        endedAt: row.attestationEndedAt.toISOString(),
        format: row.attestationFormat,
        payload: withheld ? null : row.attestationPayload.toString("utf8"),
        signature: withheld ? null : (row.signature ?? null),
      },
      environments: { run: row.runEnvironment ?? null, ci: row.ciEnvironment },
      session: row.session ?? null,
      tests: { outcome: row.outcome === "passed" ? "passed" : row.outcome === "refused" ? "refused" : "failed", durationMs: row.durationMs },
      skippedCommits: row.skippedCommits,
      createdAt: row.createdAt.toISOString(),
    };
  });
}
