import { and, desc, eq } from "drizzle-orm";
import { CONFIG_FILE, decideVerification, type AttestationCandidate } from "@testnotary/core";
import { VERIFY_REFUSALS, decodeAttestationPayload, type Verification, type VerifyRefusal, type VerifyRequest } from "@testnotary/protocol";
import type { Database } from "../db/client.ts";
import { attestations, tokens, verifications } from "../db/schema.ts";
import { now } from "./config.ts";
import { GitHubUnavailable, fileAt, gitCommit, installationToken } from "./github.ts";
import { apiError } from "./http.ts";
import { installedRepo, latestRepoState, type Executor, type RepoView } from "./installations.ts";
import { acceptActionsToken, type ActionsClaims } from "./oidc.ts";
import { bearer } from "./tokens.ts";
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
 * commit, tree or paths is read. GitHub errors propagate (wrap the handler in `withGitHubErrors`).
 */
export async function verifyJob(db: Database, job: { claims: ActionsClaims; repo: RepoView }, request: VerifyRequest): Promise<Verification> {
  const { claims, repo } = job;
  const installation = await installationToken(repo.installationId);
  const commit = await gitCommit(installation, repo.fullName, claims.sha);
  if (!commit) throw new GitHubUnavailable(`GitHub has no commit ${claims.sha} in ${repo.fullName}`);
  const firstParent = commit.parents[0];
  const decision = await decideVerification({
    requestedSuite: request.suite,
    commit: claims.sha,
    tree: commit.tree,
    event: claims.eventName,
    mode: repo.mode,
    now: now(),
    sources: {
      configAtBase: async () => (firstParent ? fileAt(installation, repo.fullName, CONFIG_FILE, firstParent) : undefined),
      attestations: (suite) => attestationsOfTree(db, repo.id, suite, commit.tree),
      hasWriteAccess: (accountId) => hasWriteAccess(db, repo, accountId, installation),
    },
  });
  const [row] = await db
    .insert(verifications)
    .values({
      repoId: repo.id,
      suite: decision.suite,
      commit: claims.sha,
      tree: commit.tree,
      event: claims.eventName,
      iss: claims.iss,
      mode: repo.mode,
      result: decision.result,
      reason: decision.reason,
      attestationId: decision.attestation?.id ?? null,
      environment: request.environment,
      createdAt: now(),
    })
    .returning({ id: verifications.id });
  return (await readVerification(db, row!.id, repo.id))!;
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
    command: decodeAttestationPayload(attestation.payload.toString("utf8"))?.command ?? [],
  }));
}

/** One of the repo's verifications, with the matched attestation's payload exactly as stored. */
export async function readVerification(db: Executor, id: string, repoId: number): Promise<Verification | undefined> {
  const [row] = await db
    .select({ verification: verifications, attestation: attestations })
    .from(verifications)
    .leftJoin(attestations, eq(attestations.id, verifications.attestationId))
    .where(and(eq(verifications.id, id), eq(verifications.repoId, repoId)));
  if (!row) return undefined;
  const { verification, attestation } = row;
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
    attestation: attestation
      ? {
          id: attestation.id,
          run: { id: attestation.runId },
          format: attestation.format,
          payload: attestation.payload.toString("utf8"),
          endedAt: attestation.endedAt.toISOString(),
        }
      : null,
    createdAt: verification.createdAt.toISOString(),
  };
}
