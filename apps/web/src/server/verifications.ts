import { and, desc, eq } from "drizzle-orm";
import { COMPARE_FILE_LIMIT, CONFIG_FILE, decideVerification, resultFor, type AttestationCandidate, type VerificationDecision } from "@testnotary/core";
import {
  IP_ALLOW_LIST_DETAIL,
  VERIFY_REFUSALS,
  decodeAttestationPayload,
  namesIpAllowList,
  type JobReport,
  type JobReportRequest,
  type Mismatch,
  type Verification,
  type VerifyRefusal,
  type VerifyRequest,
  type VerifyResponse,
} from "@testnotary/protocol";
import type { Database } from "../db/client.ts";
import { attestations, jobReports, runs, tokens, verifications } from "../db/schema.ts";
import { now } from "./config.ts";
import { GitHubDenied, GitHubUnavailable, changedPaths, fileAt, gitCommit, installationToken } from "./github.ts";
import { apiError } from "./http.ts";
import { installedRepo, latestRepoState, type Executor, type RepoView } from "./installations.ts";
import { acceptActionsToken, type ActionsClaims } from "./oidc.ts";
import { accountAsOf, shownPayload, withheld } from "./accounts.ts";
import { auditKeyOf } from "./audits.ts";
import { mismatchOfVerification, mismatchViews, recordMismatch } from "./mismatches.ts";
import { tokenVoided } from "./revocations.ts";
import { bearer, currentNames } from "./tokens.ts";
import { hasWriteAccess } from "./write-access.ts";

// Verification: a CI job, identified only by its Actions OIDC token, asks whether an attestation
// names the tree of the commit it builds. The decision itself is the core package's; this module
// supplies what it reads (GitHub, the attestations) and records the answer.

/** An answer that comes before any decision: the action falls back with this reason. */
export function verifyRefusal(code: VerifyRefusal): Response {
  return apiError(VERIFY_REFUSALS[code], code);
}

/**
 * The job behind the request: a valid, fresh, unspent Actions OIDC token (`token_rejected`
 * otherwise) whose `repository_id` is an installed repo (`repo_not_installed`).
 */
export async function identifyJob(db: Database, request: Request): Promise<{ claims: ActionsClaims; repo: RepoView } | { response: Response }> {
  const claims = await acceptActionsToken(db, bearer(request));
  if (!claims) return { response: verifyRefusal("token_rejected") };
  const repo = await installedRepo(db, claims.repositoryId);
  if (!repo) return { response: verifyRefusal("repo_not_installed") };
  return { claims, repo };
}

/**
 * Decides and records one verification. The tree is the token's `sha` resolved through GitHub's
 * commits API with the installation token, on every event; nothing the runner says about the
 * commit, tree or paths is read. Once the job is identified, GitHub refusing the App or failing is
 * recorded too, as a `github_denied` or `github_unavailable` fallback (with GitHub's own words for
 * a refusal), so the dashboard counts it; the service missing a setting still propagates.
 */
export async function verifyJob(db: Database, job: { claims: ActionsClaims; repo: RepoView }, request: VerifyRequest): Promise<VerifyResponse> {
  const { claims, repo } = job;
  const seen: { tree: string } = { tree: "" };
  let decision: VerificationDecision;
  let message: string | undefined;
  try {
    decision = await decide(db, job, request, seen);
  } catch (error) {
    if (!(error instanceof GitHubDenied || error instanceof GitHubUnavailable)) throw error;
    const reason = error instanceof GitHubDenied ? "github_denied" : "github_unavailable";
    if (error instanceof GitHubDenied) message = error.message;
    const detail = error instanceof GitHubDenied && namesIpAllowList(error.message) ? IP_ALLOW_LIST_DETAIL : null;
    decision = { result: resultFor(repo.mode, reason), reason, detail, suite: request.suite, attestation: null };
  }
  const [row] = await db
    .insert(verifications)
    .values({
      repoId: repo.id,
      suite: decision.suite,
      commit: claims.sha,
      tree: seen.tree,
      event: claims.eventName,
      iss: claims.iss,
      mode: repo.mode,
      result: decision.result,
      reason: decision.reason,
      detail: decision.detail,
      attestationId: decision.attestation?.id ?? null,
      environment: request.environment,
      ciRunId: claims.ciRun?.runId ?? null,
      ciRunAttempt: claims.ciRun?.attempt ?? null,
      ciJobId: claims.ciRun?.jobId ?? null,
      createdAt: now(),
    })
    .returning({ id: verifications.id });
  const verification = (await readVerification(db, row!.id, repo.id))!;
  return message === undefined ? { verification } : { verification, message };
}

/** The decision, from GitHub and the attestations. `seen.tree` is the built tree once GitHub gave it (empty before). */
async function decide(db: Database, job: { claims: ActionsClaims; repo: RepoView }, request: VerifyRequest, seen: { tree: string }): Promise<VerificationDecision> {
  const { claims, repo } = job;
  const installation = await installationToken(repo.installationId);
  const commit = await gitCommit(installation, repo.fullName, claims.sha);
  if (!commit) throw new GitHubUnavailable(`GitHub has no commit ${claims.sha} in ${repo.fullName}`);
  seen.tree = commit.tree;
  const firstParent = commit.parents[0];
  return decideVerification({
    requestedSuite: request.suite,
    commit: claims.sha,
    tree: commit.tree,
    event: claims.eventName,
    mode: repo.mode,
    rates: { auditOneIn: repo.auditOneIn, sandboxAuditOneIn: repo.sandboxAuditOneIn },
    now: now(),
    sources: {
      auditKey: () => auditKeyOf(db, repo.id),
      configAtBase: async () => (firstParent ? fileAt(installation, repo.fullName, CONFIG_FILE, firstParent) : undefined),
      attestations: (suite) => attestationsOfTree(db, repo.id, suite, commit.tree),
      hasWriteAccess: (accountId) => hasWriteAccess(db, repo, accountId, installation),
      tokenVoided: (tokenId) => tokenVoided(db, tokenId, repo.id),
      changedPaths: async () => {
        if (!firstParent) return undefined;
        const { paths, count } = await changedPaths(installation, repo.fullName, firstParent, claims.sha);
        return { paths, complete: count < COMPARE_FILE_LIMIT };
      },
    },
  });
}

/** Every attestation for the repo and suite that names the tree, newest run end first. */
async function attestationsOfTree(db: Executor, repoId: number, suite: string, tree: string): Promise<AttestationCandidate[]> {
  const rows = await db
    .select({ attestation: attestations, tokenKind: tokens.kind })
    .from(attestations)
    .innerJoin(tokens, eq(tokens.id, attestations.tokenId))
    .where(and(eq(attestations.repoId, repoId), eq(attestations.suite, suite), eq(attestations.tree, tree)))
    .orderBy(desc(attestations.endedAt), desc(attestations.createdAt));
  return rows.map(({ attestation, tokenKind }) => ({
    id: attestation.id,
    accountId: attestation.accountId,
    tokenId: attestation.tokenId,
    tokenKind: tokenKind === "sandbox" ? "sandbox" : "laptop",
    endedAt: attestation.endedAt,
    createdAt: attestation.createdAt,
    command: decodeAttestationPayload(attestation.payload.toString("utf8"))?.command ?? [],
  }));
}

/**
 * Stores a CI job's report of its tests against one of its repo's verifications. The token must be
 * of the verification's commit: a job reports only on what it built. Undefined when it isn't. A
 * failing report on an audit or a *would skip* records a mismatch, returned with the report, and
 * sends the repo back to shadow mode (see mismatches.ts).
 */
export async function recordJobReport(
  db: Database,
  job: { claims: ActionsClaims; repo: RepoView },
  verificationId: string,
  report: JobReportRequest,
): Promise<{ jobReport: JobReport; mismatch: Mismatch | null } | undefined> {
  return db.transaction(async (tx) => {
    const [verification] = await tx
      .select()
      .from(verifications)
      .where(and(eq(verifications.id, verificationId), eq(verifications.repoId, job.repo.id), eq(verifications.commit, job.claims.sha)));
    if (!verification) return undefined;
    const [row] = await tx
      .insert(jobReports)
      .values({
        verificationId: verification.id,
        outcome: report.outcome,
        durationMs: report.durationMs,
        environment: report.environment,
        result: report.result ?? null,
        reason: report.result ? (report.reason ?? null) : null,
        detail: report.result ? (report.detail ?? null) : null,
        createdAt: now(),
      })
      .returning();
    const mismatch = await recordMismatch(tx, verification, row!);
    return { jobReport: jobReportView(row!), mismatch: mismatch ? (await mismatchViews(tx, [mismatch]))[0]! : null };
  });
}

function jobReportView(row: typeof jobReports.$inferSelect): JobReport {
  return {
    id: row.id,
    outcome: row.outcome as JobReport["outcome"],
    durationMs: row.durationMs,
    result: row.result as JobReport["result"],
    reason: row.reason,
    detail: row.detail,
    createdAt: row.createdAt.toISOString(),
  };
}

/** One of the repo's verifications, with the matched attestation's payload exactly as stored. */
export async function readVerification(db: Executor, id: string, repoId: number): Promise<Verification | undefined> {
  const [row] = await db
    .select({ verification: verifications, attestation: attestations, run: runs, token: tokens })
    .from(verifications)
    .leftJoin(attestations, eq(attestations.id, verifications.attestationId))
    .leftJoin(runs, eq(runs.id, attestations.runId))
    .leftJoin(tokens, eq(tokens.id, attestations.tokenId))
    .where(and(eq(verifications.id, id), eq(verifications.repoId, repoId)));
  if (!row) return undefined;
  const { verification, attestation, run, token } = row;
  const attester = attestation ? await accountAsOf(db, attestation.accountId, attestation.createdAt) : undefined;
  const hidden = attester !== undefined && withheld(attester);
  const [report] = await db
    .select()
    .from(jobReports)
    .where(eq(jobReports.verificationId, verification.id))
    .orderBy(desc(jobReports.seq))
    .limit(1);
  return {
    id: verification.id,
    repository: { id: verification.repoId, fullName: (await latestRepoState(db, verification.repoId))?.fullName ?? "" },
    suite: verification.suite,
    commit: verification.commit,
    tree: verification.tree,
    event: verification.event,
    iss: verification.iss,
    mode: verification.mode === "enforce" ? "enforce" : "shadow",
    result: verification.result as Verification["result"],
    reason: verification.reason,
    detail: verification.detail,
    attestation: attestation
      ? {
          id: attestation.id,
          run: { id: attestation.runId, environment: run?.environment ?? null, session: run?.session ?? null },
          format: attestation.format,
          payload: shownPayload(attester!, attestation.payload),
          signature: hidden ? null : (attestation.signature ?? null),
          endedAt: attestation.endedAt.toISOString(),
          attester: {
            account: attester!,
            // A token's name is free text its owner picked, so it is withheld with the account.
            token: { kind: token?.kind === "sandbox" ? "sandbox" : "laptop", name: token && !hidden ? ((await currentNames(db, [token])).get(token.id) ?? token.name) : "" },
          },
        }
      : null,
    jobReport: report ? jobReportView(report) : null,
    mismatch: await mismatchOfVerification(db, verification.id),
    createdAt: verification.createdAt.toISOString(),
  };
}
