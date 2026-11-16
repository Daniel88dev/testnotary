import { and, count, desc, eq, gte, inArray, isNotNull, max, sql } from "drizzle-orm";
import { DELETED_ACCOUNT } from "@testnotary/protocol";
import { attestations, mismatches, runs, tokenRevocations, tokenUses, tokens, verifications } from "../db/schema.ts";
import { accountsAsOf, type ShownAccount } from "./accounts.ts";
import { now } from "./config.ts";
import { retainedSince } from "./history.ts";
import type { Executor } from "./installations.ts";
import { blockedAmong } from "./revocations.ts";
import { shownResult } from "./shown-results.ts";
import { currentNames, tokenExpiry } from "./tokens.ts";

// People: who and what attests on a repo. Each account that uploaded runs to the repo in the
// retained window (or has a mismatch recorded there), with its counts, and under it the tokens it
// used, each with the agent labels its runs reported (self-reported, so unverified) and whether it
// still stands. Counts come from rows, never from aggregate tables.

export interface Counts {
  runs: number;
  /** Passed runs: each has exactly one attestation. */
  attestations: number;
  /** Verifications that skipped on the attestations. */
  skips: number;
  audits: number;
  mismatches: number;
}

export interface PersonToken extends Counts {
  id: string;
  kind: "laptop" | "sandbox";
  name: string;
  /** Agents its runs named (`runs.session` vendors), and how many distinct sessions. Unverified. */
  agents: string[];
  sessions: number;
  lastUsedAt: Date | null;
  /** What stops it attesting on this repo, if anything; a block names when. */
  standing: { kind: "live" } | { kind: "revoked" } | { kind: "expired" } | { kind: "blocked"; at: Date };
}

export interface Person extends Counts {
  /** The account, or the *deleted account* tombstone (id 0) for every deleted account together. */
  account: ShownAccount;
  lastActiveAt: Date | null;
  /** Empty for the tombstone: a deleted account's tokens are not named. */
  tokens: PersonToken[];
}

const zero = (): Counts => ({ runs: 0, attestations: 0, skips: 0, audits: 0, mismatches: 0 });

function add(into: Counts, from: Partial<Counts>) {
  for (const key of Object.keys(from) as (keyof Counts)[]) into[key] += from[key] ?? 0;
}

/** The repo's people, most runs first. */
export async function peopleOf(db: Executor, repoId: number): Promise<Person[]> {
  const since = retainedSince();
  const [runRows, verificationRows, mismatchRows, sessionRows] = await Promise.all([
    db
      .select({
        tokenId: runs.tokenId,
        accountId: runs.accountId,
        runs: count(),
        attestations: sql<number>`count(*) filter (where ${runs.outcome} = 'passed')`.mapWith(Number),
        last: max(runs.receivedAt),
      })
      .from(runs)
      .where(and(eq(runs.repoId, repoId), gte(runs.receivedAt, since)))
      .groupBy(runs.tokenId, runs.accountId),
    db
      .select({
        tokenId: attestations.tokenId,
        // What the job did: a skip the action turned into a fallback is no skip.
        skips: sql<number>`count(*) filter (where ${shownResult} = 'skip')`.mapWith(Number),
        audits: sql<number>`count(*) filter (where ${shownResult} = 'audit')`.mapWith(Number),
      })
      .from(verifications)
      .innerJoin(attestations, eq(attestations.id, verifications.attestationId))
      .where(and(eq(verifications.repoId, repoId), gte(verifications.createdAt, since)))
      .groupBy(attestations.tokenId),
    // Mismatches are kept while the repo is installed, so they count beyond the 90 days.
    db
      .select({ tokenId: mismatches.tokenId, accountId: mismatches.accountId, n: count(), last: max(mismatches.attestedAt) })
      .from(mismatches)
      .where(eq(mismatches.repoId, repoId))
      .groupBy(mismatches.tokenId, mismatches.accountId),
    db
      .selectDistinct({ tokenId: runs.tokenId, vendor: sql<string>`${runs.session}->>'vendor'`, id: sql<string | null>`${runs.session}->>'id'` })
      .from(runs)
      .where(and(eq(runs.repoId, repoId), gte(runs.receivedAt, since), isNotNull(runs.session))),
  ]);

  // Every token seen, with its account and counts.
  const byToken = new Map<string, { accountId: number; counts: Counts; last: Date | null }>();
  const entry = (tokenId: string, accountId: number) => {
    let found = byToken.get(tokenId);
    if (!found) byToken.set(tokenId, (found = { accountId, counts: zero(), last: null }));
    return found;
  };
  for (const row of runRows) {
    const token = entry(row.tokenId, row.accountId);
    add(token.counts, { runs: row.runs, attestations: row.attestations });
    token.last = row.last;
  }
  for (const row of mismatchRows) {
    const token = entry(row.tokenId, row.accountId);
    add(token.counts, { mismatches: row.n });
    if (!token.last && row.last) token.last = row.last;
  }
  for (const row of verificationRows) {
    const token = byToken.get(row.tokenId);
    if (token) add(token.counts, { skips: row.skips, audits: row.audits });
  }
  if (byToken.size === 0) return [];

  const tokenIds = [...byToken.keys()];
  const [tokenRows, revoked, blocked, uses] = await Promise.all([
    db.select().from(tokens).where(inArray(tokens.id, tokenIds)),
    db.select({ tokenId: tokenRevocations.tokenId }).from(tokenRevocations).where(inArray(tokenRevocations.tokenId, tokenIds)),
    blockedAmong(db, repoId, tokenIds),
    db
      .selectDistinctOn([tokenUses.tokenId], { tokenId: tokenUses.tokenId, at: tokenUses.at })
      .from(tokenUses)
      .where(inArray(tokenUses.tokenId, tokenIds))
      .orderBy(tokenUses.tokenId, desc(tokenUses.id)),
  ]);
  const names = await currentNames(db, tokenRows);
  const revokedIds = new Set(revoked.map((row) => row.tokenId));
  const at = now();

  // Accounts, named as of their latest activity: a deleted account folds into the tombstone.
  const accountIds = [...new Set([...byToken.values()].map((token) => token.accountId))];
  const lastOf = (accountId: number) =>
    [...byToken.values()]
      .filter((token) => token.accountId === accountId)
      .reduce<Date | null>((latest, token) => (token.last && (!latest || token.last > latest) ? token.last : latest), null);
  const shown = await accountsAsOf(
    db,
    accountIds.map((accountId) => ({ accountId, at: lastOf(accountId) ?? at })),
  );

  const people = new Map<number, Person>();
  for (const [index, accountId] of accountIds.entries()) {
    const account = shown[index]!;
    const deleted = account.id === DELETED_ACCOUNT.id;
    let person = people.get(account.id);
    if (!person) people.set(account.id, (person = { account, lastActiveAt: null, tokens: [], ...zero() }));
    const last = lastOf(accountId);
    if (last && (!person.lastActiveAt || last > person.lastActiveAt)) person.lastActiveAt = last;
    for (const [tokenId, token] of byToken) {
      if (token.accountId !== accountId) continue;
      add(person, token.counts);
      if (deleted) continue;
      const row = tokenRows.find((candidate) => candidate.id === tokenId)!;
      const sessions = sessionRows.filter((session) => session.tokenId === tokenId);
      const blockedAt = blocked.get(tokenId);
      const standing: PersonToken["standing"] = revokedIds.has(tokenId)
        ? { kind: "revoked" }
        : blockedAt
          ? { kind: "blocked", at: blockedAt }
          : (await tokenExpiry(db, row)).getTime() <= at.getTime()
            ? { kind: "expired" }
            : { kind: "live" };
      person.tokens.push({
        id: tokenId,
        kind: row.kind === "sandbox" ? "sandbox" : "laptop",
        name: names.get(tokenId) ?? row.name,
        agents: [...new Set(sessions.map((session) => session.vendor))].sort(),
        sessions: new Set(sessions.filter((session) => session.id !== null).map((session) => session.id)).size,
        lastUsedAt: uses.find((use) => use.tokenId === tokenId)?.at ?? null,
        standing,
        ...token.counts,
      });
    }
    person.tokens.sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name));
  }
  return [...people.values()].sort((a, b) => b.runs - a.runs || (b.lastActiveAt?.getTime() ?? 0) - (a.lastActiveAt?.getTime() ?? 0));
}
