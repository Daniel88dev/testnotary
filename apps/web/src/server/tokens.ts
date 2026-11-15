import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { LAPTOP_TOKEN_LIFETIME_DAYS, SANDBOX_TOKEN_MAX_DAYS, tokenKind, type TokenKind } from "@testnotary/core";
import type { Account, TokenInfo } from "@testnotary/protocol";
import { database } from "../db/client.ts";
import { now } from "./config.ts";
import { accountLogins, accounts, tokenRenames, tokenRevocations, tokenSecrets, tokenUses, tokens } from "../db/schema.ts";
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
 * Issues a sandbox token for one repo, upload only, expiring `days` after creation (never
 * renewed). The caller has checked that `creator` has write access to the repo (the dashboard asks
 * GitHub live). The value is returned once and only its hash is kept.
 */
export async function issueSandboxToken(
  db: Executor,
  input: { creator: Account; repoId: number; name: string; days: number },
): Promise<{ value: string; info: TokenInfo }> {
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > SANDBOX_TOKEN_MAX_DAYS) throw new RangeError(`days: 1 to ${SANDBOX_TOKEN_MAX_DAYS}`);
  await rememberAccount(db, input.creator);
  const value = newTokenValue("sandbox");
  const createdAt = now();
  const expiresAt = new Date(createdAt.getTime() + input.days * DAY_MS);
  const [row] = await db
    .insert(tokens)
    .values({ kind: "sandbox", accountId: input.creator.id, name: input.name, repoId: input.repoId, expiresAt, createdAt })
    .returning();
  await db.insert(tokenSecrets).values({ tokenId: row!.id, hash: hashToken(value) });
  return { value, info: { id: row!.id, kind: "sandbox", name: input.name, expiresAt: expiresAt.toISOString() } };
}

/** A sandbox token's lifetime in days as typed in the dashboard; `undefined` outside 1 to 365. */
export function sandboxTokenDays(value: unknown): number | undefined {
  const days = typeof value === "string" && /^\d{1,3}$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
  return days >= 1 && days <= SANDBOX_TOKEN_MAX_DAYS ? days : undefined;
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
  // The first use is always recorded (the Tokens page shows it as the last use); later ones hourly.
  if (!lastUse || at.getTime() - lastSeen.getTime() >= USE_GRANULARITY_MS) {
    await db.insert(tokenUses).values({ tokenId: token.id, at });
    renewedFrom = at;
  }
  const login = await accountLogin(db, token.accountId);
  const names = await currentNames(db, [token]);
  return {
    account: { id: token.accountId, login: login ?? "" },
    token: {
      id: token.id,
      kind,
      name: names.get(token.id) ?? token.name,
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

/** Each token's name now: the latest rename, or the name it was created with. */
export async function currentNames(db: Executor, rows: { id: string; name: string }[]): Promise<Map<string, string>> {
  const names = new Map(rows.map((row) => [row.id, row.name]));
  if (rows.length === 0) return names;
  const renames = await db
    .selectDistinctOn([tokenRenames.tokenId], { tokenId: tokenRenames.tokenId, name: tokenRenames.name })
    .from(tokenRenames)
    .where(inArray(tokenRenames.tokenId, [...names.keys()]))
    .orderBy(tokenRenames.tokenId, desc(tokenRenames.id));
  for (const rename of renames) names.set(rename.tokenId, rename.name);
  return names;
}

export const TOKEN_NAME_MAX = 100;

/** A token name as typed, trimmed; `undefined` when empty or too long. */
export function tokenName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim().replace(/\s+/g, " ");
  return name.length > 0 && name.length <= TOKEN_NAME_MAX ? name : undefined;
}

export interface LaptopTokenView {
  id: string;
  name: string;
  createdAt: Date;
  expiresAt: Date;
  /** When it was last used (hourly granularity after the first use); null when never. */
  lastUsedAt: Date | null;
}

/** The account's live laptop tokens (not revoked, not expired), newest first: the Tokens page. */
export async function laptopTokensOf(db: Executor, accountId: number): Promise<LaptopTokenView[]> {
  const rows = await db
    .select({ token: tokens })
    .from(tokens)
    .leftJoin(tokenRevocations, eq(tokenRevocations.tokenId, tokens.id))
    .where(and(eq(tokens.accountId, accountId), eq(tokens.kind, "laptop"), isNull(tokenRevocations.id)))
    .orderBy(desc(tokens.createdAt));
  const list = rows.map((row) => row.token);
  if (list.length === 0) return [];
  const uses = await db
    .selectDistinctOn([tokenUses.tokenId], { tokenId: tokenUses.tokenId, at: tokenUses.at })
    .from(tokenUses)
    .where(inArray(tokenUses.tokenId, list.map((token) => token.id)))
    .orderBy(tokenUses.tokenId, desc(tokenUses.id));
  const names = await currentNames(db, list);
  const current = now().getTime();
  return list
    .map((token) => {
      const lastUsedAt = uses.find((use) => use.tokenId === token.id)?.at ?? null;
      return {
        id: token.id,
        name: names.get(token.id) ?? token.name,
        createdAt: token.createdAt,
        expiresAt: expiry(token, lastUsedAt ?? token.createdAt),
        lastUsedAt,
      };
    })
    .filter((token) => token.expiresAt.getTime() > current);
}

/** The account's own laptop token with this id, live or not; `undefined` for anyone else's. */
export async function ownLaptopToken(db: Executor, accountId: number, tokenId: string): Promise<{ id: string } | undefined> {
  if (!/^[0-9a-f-]{36}$/i.test(tokenId)) return undefined;
  const [row] = await db
    .select({ id: tokens.id })
    .from(tokens)
    .where(and(eq(tokens.id, tokenId), eq(tokens.accountId, accountId), eq(tokens.kind, "laptop")));
  return row;
}

/** Gives a token a new name (a new row; the latest one is its name). */
export async function renameToken(db: Executor, tokenId: string, name: string): Promise<void> {
  await db.insert(tokenRenames).values({ tokenId, name });
}
