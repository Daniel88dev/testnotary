import { and, desc, eq, gt, inArray, lt, lte, max, ne, notExists, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type postgres from "postgres";
import type { Database } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import {
  accountDeletions,
  accountLogins,
  accountSuspensions,
  accounts,
  attestations,
  jobReports,
  mismatchExplanations,
  mismatches,
  repoSettingChanges,
  runs,
  tokenBlocks,
  tokenRenames,
  tokenRevocations,
  tokenSecrets,
  tokenUses,
  tokens,
  verifications,
} from "../db/schema.ts";
import { RETAINED_DAYS } from "./history.ts";
import { clearSpentTokenHashes } from "./revocations.ts";
import { tokenExpiry } from "./tokens.ts";

// The retention job (spec, "Retention"). It runs on a schedule as the retention role, the only role
// that may delete, and decides by the job's own clock (`at`):
// - runs, attestations, verifications and job reports are hard-deleted at 90 days;
// - mismatches and their explanations stay while the repo is installed;
// - a token goes 90 days after its revocation or expiry, once nothing kept points at it, and its
//   hash goes as soon as it is revoked or expired;
// - a repo that left Testnotary (uninstalled, removed, deleted, transferred) loses all its data
//   30 days after it left, unless it came back first;
// - a deleted account loses its login at once and its row once nothing names it.

const DAY_MS = 86_400_000;

/** How many rows of each kind one pass deleted. */
export interface RetentionSummary {
  runs: number;
  attestations: number;
  verifications: number;
  jobReports: number;
  /** Hashes of revoked or expired tokens cleared, so their values never authenticate again. */
  tokenHashes: number;
  /** Tokens deleted 90 days after their revocation or expiry. */
  tokens: number;
  /** Cached logins of deleted accounts. */
  logins: number;
  /** Rows of deleted accounts that nothing names any more. */
  accounts: number;
}

/** The database through a connection as the retention role (the job never uses the app's pool). */
export function retentionDatabase(connection: postgres.Sql): Database {
  return drizzle(connection, { schema });
}

/** One pass of the retention job, in one transaction. `retention` connects as the retention role. */
export async function runRetention(retention: Database, at: Date): Promise<RetentionSummary> {
  return retention.transaction(async (tx) => {
    const cutoff = new Date(at.getTime() - RETAINED_DAYS * DAY_MS);
    const pruned = await pruneHistory(tx, cutoff);
    const tokenHashes = await clearSpentTokenHashes(tx, at);
    const spentTokens = await deleteSpentTokens(tx, cutoff);
    const deleted = await forgetDeletedAccounts(tx);
    return { ...pruned, tokenHashes, tokens: spentTokens, ...deleted };
  });
}

/**
 * *Delete account* is an append-only row that takes effect at once (open decision 3); here the
 * account's login goes, and its row goes once nothing names it any more. The retention role can
 * only delete, so references are never repointed at a tombstone: records name the account by id,
 * and `accountsAsOf` shows *deleted account* for any record made before the deletion row. That row
 * therefore stays as long as the account's row does, and both go together once no run,
 * attestation, token, revocation, block, mismatch, explanation or setting change names the id
 * (runs and attestations at 90 days, tokens 90 days after the deletion revoked them).
 *
 * Someone who signed in again since (a token created after the deletion) keeps the login they
 * signed in with; only older ones go.
 */
async function forgetDeletedAccounts(tx: Tx): Promise<{ logins: number; accounts: number }> {
  const deletions = await tx
    .select({ accountId: accountDeletions.accountId, at: max(accountDeletions.at) })
    .from(accountDeletions)
    .groupBy(accountDeletions.accountId);
  let logins = 0;
  let accountsDeleted = 0;
  for (const { accountId, at: deletedAt } of deletions) {
    if (!deletedAt) continue;
    const [since] = await tx
      .select({ id: tokens.id })
      .from(tokens)
      .where(and(eq(tokens.accountId, accountId), gt(tokens.createdAt, deletedAt)))
      .limit(1);
    if (since) {
      const [latest] = await tx
        .select({ id: accountLogins.id })
        .from(accountLogins)
        .where(eq(accountLogins.accountId, accountId))
        .orderBy(desc(accountLogins.id))
        .limit(1);
      const older = await tx
        .delete(accountLogins)
        .where(and(eq(accountLogins.accountId, accountId), lte(accountLogins.at, deletedAt), ne(accountLogins.id, latest?.id ?? 0)))
        .returning({ id: accountLogins.id });
      logins += older.length;
      continue;
    }
    const before = await tx
      .delete(accountLogins)
      .where(and(eq(accountLogins.accountId, accountId), lte(accountLogins.at, deletedAt)))
      .returning({ id: accountLogins.id });
    logins += before.length;
    if (await accountNamed(tx, accountId)) continue;
    logins += (await tx.delete(accountLogins).where(eq(accountLogins.accountId, accountId)).returning({ id: accountLogins.id })).length;
    await tx.delete(accountSuspensions).where(eq(accountSuspensions.accountId, accountId));
    await tx.delete(accountDeletions).where(eq(accountDeletions.accountId, accountId));
    accountsDeleted += (await tx.delete(accounts).where(eq(accounts.githubId, accountId)).returning({ id: accounts.githubId })).length;
  }
  return { logins, accounts: accountsDeleted };
}

/** Whether any kept record names the account, by foreign key or by a plain id column. */
async function accountNamed(tx: Tx, accountId: number): Promise<boolean> {
  const one = { one: sql`1` };
  const [named] = await tx.execute<{ named: boolean }>(sql`select exists (
      ${tx.select(one).from(tokens).where(eq(tokens.accountId, accountId))}
      union all ${tx.select(one).from(runs).where(eq(runs.accountId, accountId))}
      union all ${tx.select(one).from(attestations).where(eq(attestations.accountId, accountId))}
      union all ${tx.select(one).from(tokenRevocations).where(eq(tokenRevocations.revokedBy, accountId))}
      union all ${tx.select(one).from(tokenBlocks).where(eq(tokenBlocks.blockedBy, accountId))}
      union all ${tx.select(one).from(mismatches).where(eq(mismatches.accountId, accountId))}
      union all ${tx.select(one).from(mismatchExplanations).where(eq(mismatchExplanations.explainedBy, accountId))}
      union all ${tx.select(one).from(repoSettingChanges).where(eq(repoSettingChanges.changedBy, accountId))}
    ) as named`);
  return Boolean(named?.named);
}

/**
 * Tokens revoked or expired before `cutoff` that nothing kept points at: no run, attestation or
 * block of theirs is left, and no mismatch names them. A token's own rows (its hash, uses, renames
 * and revocation) go with it.
 */
async function deleteSpentTokens(tx: Tx, cutoff: Date): Promise<number> {
  const unreferenced = await tx
    .select({ token: tokens, revokedAt: tokenRevocations.at })
    .from(tokens)
    .leftJoin(tokenRevocations, eq(tokenRevocations.tokenId, tokens.id))
    .where(
      and(
        notExists(tx.select({ one: sql`1` }).from(runs).where(eq(runs.tokenId, tokens.id))),
        notExists(tx.select({ one: sql`1` }).from(attestations).where(eq(attestations.tokenId, tokens.id))),
        notExists(tx.select({ one: sql`1` }).from(tokenBlocks).where(eq(tokenBlocks.tokenId, tokens.id))),
        notExists(tx.select({ one: sql`1` }).from(mismatches).where(eq(mismatches.tokenId, tokens.id))),
      ),
    );
  const spent: string[] = [];
  for (const { token, revokedAt } of unreferenced) {
    if (revokedAt && revokedAt < cutoff) spent.push(token.id);
    else if ((await tokenExpiry(tx, token)) < cutoff) spent.push(token.id);
  }
  return deleteTokens(tx, spent);
}

/** Deletes tokens with their own rows. The caller has made sure nothing else points at them. */
async function deleteTokens(tx: Tx, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  await tx.delete(tokenSecrets).where(inArray(tokenSecrets.tokenId, ids));
  await tx.delete(tokenUses).where(inArray(tokenUses.tokenId, ids));
  await tx.delete(tokenRenames).where(inArray(tokenRenames.tokenId, ids));
  await tx.delete(tokenRevocations).where(inArray(tokenRevocations.tokenId, ids));
  const deleted = await tx.delete(tokens).where(inArray(tokens.id, ids)).returning({ id: tokens.id });
  return deleted.length;
}

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Runs, attestations, verifications and job reports from before `cutoff`. An attestation a kept
 * verification still matched (one refused as too old, say) stays until that verification goes, and
 * a run stays while its attestation does: the foreign keys say so, and nothing kept loses a link.
 */
async function pruneHistory(tx: Tx, cutoff: Date): Promise<Pick<RetentionSummary, "runs" | "attestations" | "verifications" | "jobReports">> {
  const old = tx.select({ id: verifications.id }).from(verifications).where(lt(verifications.createdAt, cutoff));
  const jobReportRows = await tx.delete(jobReports).where(inArray(jobReports.verificationId, old)).returning({ id: jobReports.id });
  const verificationRows = await tx.delete(verifications).where(lt(verifications.createdAt, cutoff)).returning({ id: verifications.id });
  const attestationRows = await tx
    .delete(attestations)
    .where(
      and(
        lt(attestations.createdAt, cutoff),
        notExists(tx.select({ one: sql`1` }).from(verifications).where(sql`${verifications.attestationId} = ${attestations.id}`)),
      ),
    )
    .returning({ id: attestations.id });
  const runRows = await tx
    .delete(runs)
    .where(and(lt(runs.receivedAt, cutoff), notExists(tx.select({ one: sql`1` }).from(attestations).where(sql`${attestations.runId} = ${runs.id}`))))
    .returning({ id: runs.id });
  return { runs: runRows.length, attestations: attestationRows.length, verifications: verificationRows.length, jobReports: jobReportRows.length };
}
