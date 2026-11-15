import { and, desc, eq, inArray, isNotNull, lte, or } from "drizzle-orm";
import type { TokenVoid } from "@testnotary/core";
import type { Account } from "@testnotary/protocol";
import { runs, tokenBlocks, tokenRevocations, tokenSecrets, tokens } from "../db/schema.ts";
import { accountsAsOf, type ShownAccount } from "./accounts.ts";
import { now } from "./config.ts";
import type { Executor } from "./installations.ts";
import { currentNames, hashToken, revokeToken, tokenExpiry } from "./tokens.ts";

// Cutting off a credential: a repo admin revokes any of the repo's sandbox tokens, or blocks a
// laptop token from attesting on the repo. Each is one append-only row that takes effect at once:
// the token's attestations stop counting (`tokenVoided`), and a blocked token's runs on the repo are
// refused. The callers (the dashboard's server actions) have checked, live with GitHub, that the
// person is an admin of the repo; these functions check that the token belongs where the admin is.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The token's id, by its value (a test or the operator holds the value, never the dashboard). */
export async function tokenIdOf(db: Executor, value: string): Promise<string | undefined> {
  const [row] = await db.select({ id: tokenSecrets.tokenId }).from(tokenSecrets).where(eq(tokenSecrets.hash, hashToken(value)));
  return row?.id;
}

/**
 * A repo admin revokes one of the repo's sandbox tokens, whoever created it. False when the token
 * is not a sandbox token of that repo (nothing is written). Revoking twice is harmless.
 */
export async function revokeRepoSandboxToken(db: Executor, input: { tokenId: string; repoId: number; by: Account }): Promise<boolean> {
  if (!UUID.test(input.tokenId)) return false;
  const [token] = await db
    .select({ id: tokens.id })
    .from(tokens)
    .where(and(eq(tokens.id, input.tokenId), eq(tokens.kind, "sandbox"), eq(tokens.repoId, input.repoId)));
  if (!token) return false;
  await revokeToken(db, token.id, "revoked_by_admin", input.by.id);
  return true;
}

/**
 * A repo admin blocks a laptop token from attesting on the repo. Only a laptop token that has
 * uploaded a run to the repo can be blocked there (the People section lists those); false
 * otherwise, and nothing is written. Blocking twice keeps the first block.
 */
export async function blockLaptopToken(db: Executor, input: { tokenId: string; repoId: number; by: Account; note?: string }): Promise<boolean> {
  if (!UUID.test(input.tokenId)) return false;
  const [token] = await db
    .select({ id: tokens.id })
    .from(tokens)
    .innerJoin(runs, and(eq(runs.tokenId, tokens.id), eq(runs.repoId, input.repoId)))
    .where(and(eq(tokens.id, input.tokenId), eq(tokens.kind, "laptop")))
    .limit(1);
  if (!token) return false;
  await db
    .insert(tokenBlocks)
    .values({ tokenId: token.id, repoId: input.repoId, blockedBy: input.by.id, note: input.note?.trim() || null, at: now() })
    .onConflictDoNothing();
  return true;
}

/** Whether the token is blocked on the repo. */
export async function isBlocked(db: Executor, tokenId: string, repoId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: tokenBlocks.id })
    .from(tokenBlocks)
    .where(and(eq(tokenBlocks.tokenId, tokenId), eq(tokenBlocks.repoId, repoId)))
    .limit(1);
  return Boolean(row);
}

/**
 * What voids the token's attestations on the repo now: a revocation, a block on this repo, or the
 * token having expired (computed on read, by the service clock). Undefined while it stands.
 */
export async function tokenVoided(db: Executor, tokenId: string, repoId: number): Promise<TokenVoid | undefined> {
  const [token] = await db.select().from(tokens).where(eq(tokens.id, tokenId));
  if (!token) return "revoked";
  const [revocation] = await db.select({ id: tokenRevocations.id }).from(tokenRevocations).where(eq(tokenRevocations.tokenId, tokenId));
  if (revocation) return "revoked";
  if (await isBlocked(db, tokenId, repoId)) return "blocked";
  if ((await tokenExpiry(db, token)).getTime() <= now().getTime()) return "expired";
  return undefined;
}

/** A laptop token blocked on a repo, as Settings lists it. */
export interface BlockedTokenView {
  tokenId: string;
  name: string;
  /** The token's owner, as of now (*deleted account* once deleted). */
  owner: ShownAccount;
  blockedBy: ShownAccount;
  note: string | null;
  at: Date;
}

/** The repo's blocked laptop tokens, newest block first. */
export async function blockedLaptopTokens(db: Executor, repoId: number): Promise<BlockedTokenView[]> {
  const rows = await db
    .select({ block: tokenBlocks, token: tokens })
    .from(tokenBlocks)
    .innerJoin(tokens, eq(tokens.id, tokenBlocks.tokenId))
    .where(eq(tokenBlocks.repoId, repoId))
    .orderBy(desc(tokenBlocks.at), desc(tokenBlocks.id));
  if (rows.length === 0) return [];
  const at = now();
  const [names, owners, admins] = await Promise.all([
    currentNames(
      db,
      rows.map((row) => row.token),
    ),
    accountsAsOf(
      db,
      rows.map((row) => ({ accountId: row.token.accountId, at })),
    ),
    accountsAsOf(
      db,
      rows.map((row) => ({ accountId: row.block.blockedBy, at })),
    ),
  ]);
  return rows.map(({ block, token }, index) => ({
    tokenId: token.id,
    name: names.get(token.id) ?? token.name,
    owner: owners[index]!,
    blockedBy: admins[index]!,
    note: block.note,
    at: block.at,
  }));
}

/** The tokens of `tokenIds` blocked on the repo. */
export async function blockedAmong(db: Executor, repoId: number, tokenIds: string[]): Promise<Map<string, Date>> {
  if (tokenIds.length === 0) return new Map();
  const rows = await db
    .select({ tokenId: tokenBlocks.tokenId, at: tokenBlocks.at })
    .from(tokenBlocks)
    .where(and(eq(tokenBlocks.repoId, repoId), inArray(tokenBlocks.tokenId, tokenIds)));
  return new Map(rows.map((row) => [row.tokenId, row.at]));
}

/**
 * Clears the hash of every revoked or expired token: deletes its `token_secrets` row, so the value
 * can never authenticate again, whatever else changes. Only the retention role may delete, so this
 * runs under that role's connection, from the retention job; the revocation row has already
 * stopped the token at once. `at` is the job's clock. Returns how many hashes were cleared.
 */
export async function clearSpentTokenHashes(retention: Executor, at: Date): Promise<number> {
  const candidates = await retention
    .select({ token: tokens, revoked: tokenRevocations.id })
    .from(tokenSecrets)
    .innerJoin(tokens, eq(tokens.id, tokenSecrets.tokenId))
    .leftJoin(tokenRevocations, eq(tokenRevocations.tokenId, tokens.id))
    .where(or(isNotNull(tokenRevocations.id), and(isNotNull(tokens.expiresAt), lte(tokens.expiresAt, at)), eq(tokens.kind, "laptop")));
  const spent: string[] = [];
  for (const { token, revoked } of candidates) {
    if (revoked !== null || (await tokenExpiry(retention, token)).getTime() <= at.getTime()) spent.push(token.id);
  }
  if (spent.length === 0) return 0;
  const cleared = await retention.delete(tokenSecrets).where(inArray(tokenSecrets.tokenId, spent)).returning({ id: tokenSecrets.tokenId });
  return cleared.length;
}
