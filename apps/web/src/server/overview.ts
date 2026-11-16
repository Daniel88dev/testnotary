import { and, asc, eq, gte, sql } from "drizzle-orm";
import type { RepoMode } from "@testnotary/core";
import { repoStates, runs, tokens, verifications } from "../db/schema.ts";
import { retainedSince } from "./history.ts";
import type { Executor, RepoView } from "./installations.ts";
import { guardedFilesOf } from "./settings.ts";

// What the Overview reads. There are no aggregate tables: every number is computed from the rows
// retention still holds, so every window here is bounded by the 90 days (`retainedSince`).

/** Where a repo with no verification yet stands on the setup guide's steps, as far as the service can see. */
export interface SetupState {
  /** When the App was last installed on the repo. */
  installedAt: Date | undefined;
  /** `testnotary.json` on the default branch: found, absent, invalid, or GitHub could not be asked. */
  config: "config" | "no_config" | "invalid" | "unavailable";
  /** A run uploaded with a laptop token reached this repo (in the retained window). */
  laptopRun: boolean;
  /** Sandbox tokens created for this repo. */
  sandboxTokens: number;
  mode: RepoMode;
}

/** The repo has at least one retained verification: the Overview shows its numbers, not the setup checklist. */
export async function hasVerifications(db: Executor, repoId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: verifications.id })
    .from(verifications)
    .where(and(eq(verifications.repoId, repoId), gte(verifications.createdAt, retainedSince())))
    .limit(1);
  return row !== undefined;
}

export async function setupState(db: Executor, repo: RepoView): Promise<SetupState> {
  const [states, [laptop], [sandbox], guarded] = await Promise.all([
    db.select({ installed: repoStates.installed, at: repoStates.at }).from(repoStates).where(eq(repoStates.repoId, repo.id)).orderBy(asc(repoStates.id)),
    db
      .select({ id: runs.id })
      .from(runs)
      .innerJoin(tokens, eq(tokens.id, runs.tokenId))
      .where(and(eq(runs.repoId, repo.id), eq(tokens.kind, "laptop"), gte(runs.receivedAt, retainedSince())))
      .limit(1),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(tokens)
      .where(and(eq(tokens.kind, "sandbox"), eq(tokens.repoId, repo.id))),
    guardedFilesOf(repo),
  ]);
  // The install that counts: the first installed row after the last time the repo left.
  let installedAt: Date | undefined;
  for (const state of states) {
    if (!state.installed) installedAt = undefined;
    else installedAt ??= state.at;
  }
  return { installedAt, config: guarded.source, laptopRun: laptop !== undefined, sandboxTokens: sandbox?.n ?? 0, mode: repo.mode };
}
