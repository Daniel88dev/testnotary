import { and, desc, eq, gte, inArray, isNull, max } from "drizzle-orm";
import { DELETED_ACCOUNT } from "@testnotary/protocol";
import { accountDeletions, accountLogins, accountSuspensions, sessionEnds, tokenRevocations, tokens } from "../db/schema.ts";
import { now } from "./config.ts";
import type { Executor } from "./installations.ts";

// What happens to an account as a whole: *Delete account*, and the operator's suspensions and
// token revocations (scripts/ops.ts). Every change is a new row, because the app role only inserts
// (open decision 3). And how a record names its account: through `accountsAsOf`, so a deleted
// account's records show the shared *deleted account*, never its id or login.

/** A record's account as it may be shown: the account, or the *deleted account* tombstone. */
export interface ShownAccount {
  id: number;
  login: string | null;
}

/**
 * Whether what a record's attester left is withheld from every read: once the account reads
 * *deleted account*, the attestation's payload (it names the account's GitHub id), its signature
 * (the account's key) and the token's name (free text its owner picked). The rows keep them.
 */
export function withheld(account: { id: number }): boolean {
  return account.id === DELETED_ACCOUNT.id;
}

/** An attestation's payload exactly as stored, or null when it is withheld (see `withheld`). Decided on the server, so it never reaches a browser. */
export function shownPayload(account: { id: number }, payload: Uint8Array): string | null {
  return withheld(account) ? null : Buffer.from(payload).toString("utf8");
}

/**
 * The accounts of records made at the given times, in the same order. A record made before its
 * account was deleted shows the *deleted account* tombstone; otherwise the account's cached login.
 * Every page and API answer that names a record's account goes through here.
 */
export async function accountsAsOf(db: Executor, records: { accountId: number; at: Date }[]): Promise<ShownAccount[]> {
  const ids = [...new Set(records.map((record) => record.accountId))];
  if (ids.length === 0) return [];
  const [deletions, logins] = await Promise.all([
    db
      .select({ accountId: accountDeletions.accountId, at: max(accountDeletions.at) })
      .from(accountDeletions)
      .where(inArray(accountDeletions.accountId, ids))
      .groupBy(accountDeletions.accountId),
    db
      .selectDistinctOn([accountLogins.accountId], { accountId: accountLogins.accountId, login: accountLogins.login })
      .from(accountLogins)
      .where(inArray(accountLogins.accountId, ids))
      .orderBy(accountLogins.accountId, desc(accountLogins.id)),
  ]);
  const deletedAt = new Map(deletions.map((row) => [row.accountId, row.at]));
  const loginOf = new Map(logins.map((row) => [row.accountId, row.login]));
  return records.map((record) => {
    const deleted = deletedAt.get(record.accountId);
    if (deleted && record.at.getTime() <= deleted.getTime()) return { ...DELETED_ACCOUNT };
    return { id: record.accountId, login: loginOf.get(record.accountId) ?? null };
  });
}

/** One record's account; see `accountsAsOf`. */
export async function accountAsOf(db: Executor, accountId: number, at: Date): Promise<ShownAccount> {
  const [shown] = await accountsAsOf(db, [{ accountId, at }]);
  return shown!;
}

/** When the account was last deleted, if it ever was. Records and sessions from before then are no longer its own. */
export async function deletedAt(db: Executor, accountId: number): Promise<Date | undefined> {
  const [row] = await db.select({ at: accountDeletions.at }).from(accountDeletions).where(eq(accountDeletions.accountId, accountId)).orderBy(desc(accountDeletions.id)).limit(1);
  return row?.at;
}

/**
 * Revokes every live token the account holds: its laptop tokens and every sandbox token it created.
 * Returns how many were revoked. `revokedBy` is null when the operator or a deletion revoked them.
 */
export async function revokeAccountTokens(db: Executor, accountId: number, reason: string): Promise<number> {
  const live = await db
    .select({ id: tokens.id })
    .from(tokens)
    .leftJoin(tokenRevocations, eq(tokenRevocations.tokenId, tokens.id))
    .where(and(eq(tokens.accountId, accountId), isNull(tokenRevocations.id)));
  if (live.length === 0) return 0;
  const revoked = await db
    .insert(tokenRevocations)
    .values(live.map((token) => ({ tokenId: token.id, reason, revokedBy: null, at: now() })))
    .onConflictDoNothing()
    .returning({ id: tokenRevocations.id });
  return revoked.length;
}

/**
 * *Delete account*: one row that takes effect at once. The account's tokens are revoked, the
 * session it was asked from ends (every other session from before now ends too, see
 * `sessionStillValid`), and its records show *deleted account* from now on.
 */
export async function deleteAccount(db: Executor, accountId: number, sessionId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(accountDeletions).values({ accountId, at: now() });
    await revokeAccountTokens(tx, accountId, "account_deleted");
    await tx.insert(sessionEnds).values({ sessionId }).onConflictDoNothing();
  });
}

/** Whether a browser session started at `startedAt` may still act for the account: not if the account was deleted since. */
export async function sessionStillValid(db: Executor, accountId: number, startedAt: Date): Promise<boolean> {
  const [row] = await db
    .select({ id: accountDeletions.id })
    .from(accountDeletions)
    .where(and(eq(accountDeletions.accountId, accountId), gte(accountDeletions.at, startedAt)))
    .limit(1);
  return !row;
}

export type SuspensionAction = "suspended" | "lifted";

/** Whether the operator has suspended the account (its latest suspension row says so). */
export async function isSuspended(db: Executor, accountId: number): Promise<boolean> {
  const [latest] = await db
    .select({ action: accountSuspensions.action })
    .from(accountSuspensions)
    .where(eq(accountSuspensions.accountId, accountId))
    .orderBy(desc(accountSuspensions.id))
    .limit(1);
  return latest?.action === "suspended";
}

/** The operator suspends the account (revoking its tokens) or lifts a suspension. */
export async function setSuspension(db: Executor, accountId: number, action: SuspensionAction, reason: string): Promise<{ revoked: number }> {
  return db.transaction(async (tx) => {
    await tx.insert(accountSuspensions).values({ accountId, action, reason, at: now() });
    return { revoked: action === "suspended" ? await revokeAccountTokens(tx, accountId, "suspended") : 0 };
  });
}
