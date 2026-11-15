import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { LAPTOP_TOKEN_LIFETIME_DAYS, tokenKind, type TokenKind } from "@testnotary/core";
import type { Account, TokenInfo } from "@testnotary/protocol";
import { database } from "../db/client.ts";
import { now } from "./config.ts";
import { accountLogins, accounts, tokenRevocations, tokenSecrets, tokenUses, tokens } from "../db/schema.ts";
import type { Executor } from "./installations.ts";

// Tokens: issued here, stored as SHA-256 hashes only, and recognised by hash. Every API route that
// takes a token goes through `authenticate`, which also renews a laptop token on use.

const DAY_MS = 86_400_000;
/** A use is recorded at most this often per token. */
const USE_GRANULARITY_MS = 3_600_000;

export interface Authenticated {
  account: Account;
  token: TokenInfo & { kind: TokenKind; repoId: number | null };
}

/** The hash a token is stored and looked up by. Tokens are 240 random bits, so no salt or stretching is needed. */
export function hashToken(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function newTokenValue(kind: TokenKind): string {
  return `${kind === "laptop" ? "tnl_" : "tns_"}${randomBytes(30).toString("base64url")}`;
}

/** Records a GitHub user as an account, and their login when it is new or changed. */
export async function rememberAccount(db: Executor, account: Account): Promise<void> {
  await db.insert(accounts).values({ githubId: account.id }).onConflictDoNothing();
  const [latest] = await db
    .select({ login: accountLogins.login })
    .from(accountLogins)
    .where(eq(accountLogins.accountId, account.id))
    .orderBy(desc(accountLogins.id))
    .limit(1);
  if (latest?.login !== account.login) await db.insert(accountLogins).values({ accountId: account.id, login: account.login });
}

/** The account's cached login. */
export async function accountLogin(db: Executor, accountId: number): Promise<string | undefined> {
  const [latest] = await db
    .select({ login: accountLogins.login })
    .from(accountLogins)
    .where(eq(accountLogins.accountId, accountId))
    .orderBy(desc(accountLogins.id))
    .limit(1);
  return latest?.login;
}

/** Issues a laptop token. The value is returned once and only its hash is kept. */
export async function issueLaptopToken(db: Executor, account: Account, name: string): Promise<{ value: string; info: TokenInfo }> {
  const value = newTokenValue("laptop");
  const [row] = await db.insert(tokens).values({ kind: "laptop", accountId: account.id, name, createdAt: now() }).returning();
  await db.insert(tokenSecrets).values({ tokenId: row!.id, hash: hashToken(value) });
  return { value, info: { id: row!.id, kind: "laptop", name, expiresAt: expiry(row!, row!.createdAt).toISOString() } };
}

/**
 * Who a token value belongs to, if it is live: known by its hash, not revoked, not expired. A use
 * is recorded, which renews a laptop token for another 90 days.
 */
export async function authenticateToken(db: Executor, value: string): Promise<Authenticated | undefined> {
  const kind = tokenKind(value);
  if (!kind) return undefined;
  const [row] = await db
    .select({ token: tokens })
    .from(tokenSecrets)
    .innerJoin(tokens, eq(tokens.id, tokenSecrets.tokenId))
    .leftJoin(tokenRevocations, eq(tokenRevocations.tokenId, tokens.id))
    .where(and(eq(tokenSecrets.hash, hashToken(value)), isNull(tokenRevocations.id)));
  if (!row || row.token.kind !== kind) return undefined;
  const token = row.token;
  const [lastUse] = await db.select({ at: tokenUses.at }).from(tokenUses).where(eq(tokenUses.tokenId, token.id)).orderBy(desc(tokenUses.id)).limit(1);
  const lastSeen = lastUse?.at ?? token.createdAt;
  const at = now();
  if (expiry(token, lastSeen) <= at) return undefined;
  let renewedFrom = lastSeen;
  if (at.getTime() - lastSeen.getTime() >= USE_GRANULARITY_MS) {
    await db.insert(tokenUses).values({ tokenId: token.id, at });
    renewedFrom = at;
  }
  const login = await accountLogin(db, token.accountId);
  return {
    account: { id: token.accountId, login: login ?? "" },
    token: {
      id: token.id,
      kind,
      name: token.name,
      expiresAt: expiry(token, renewedFrom).toISOString(),
      repoId: token.repoId,
    },
  };
}

/** The bearer token of a request, checked. Use in every route that takes a token. */
export async function authenticate(request: Request): Promise<Authenticated | undefined> {
  const value = bearer(request);
  return value ? authenticateToken(database(), value) : undefined;
}

export function bearer(request: Request): string | undefined {
  return /^Bearer (\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
}

/** The answer to a request whose token is missing, unknown, revoked or expired. It never says which. */
export function tokenRejected(): Response {
  return Response.json({ error: "token_rejected" }, { status: 401 });
}

/** Ends a token for good. Revoking it twice is harmless. */
export async function revokeToken(db: Executor, tokenId: string, reason: string, revokedBy: number | null = null): Promise<void> {
  await db.insert(tokenRevocations).values({ tokenId, reason, revokedBy }).onConflictDoNothing();
}

function expiry(token: { kind: string; expiresAt: Date | null }, lastSeen: Date): Date {
  if (token.expiresAt) return token.expiresAt;
  return new Date(lastSeen.getTime() + LAPTOP_TOKEN_LIFETIME_DAYS * DAY_MS);
}
