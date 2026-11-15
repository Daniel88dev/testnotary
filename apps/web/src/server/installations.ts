import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { INITIAL_REPO_SETTINGS, type RepoMode } from "@testnotary/core";
import type { Database } from "../db/client.ts";
import { installationEvents, installations, repoSettingChanges, repoStates, repos } from "../db/schema.ts";

// Installations and their repos, as the App's webhooks leave them. Every change is a new row (the
// app role cannot update), and the latest row per installation or repo is its current state.

/** The database, or a transaction on it. */
export type Executor = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

export type InstallationState = "active" | "suspended" | "deleted";
export type RepoChange = "added" | "removed" | "renamed" | "privatized" | "publicized" | "transferred" | "deleted";

export interface RepoView {
  /** GitHub's repo id. */
  id: number;
  installationId: number;
  fullName: string;
  visibility: "public" | "private";
  /** In the installation now, and the installation is active. */
  installed: boolean;
  mode: RepoMode;
  auditOneIn: number;
  sandboxAuditOneIn: number;
}

export interface InstallationView {
  id: number;
  /** The login of the GitHub account the App is installed on. */
  account: string;
  state: InstallationState;
  /** The repos installed now, by full name. */
  repos: RepoView[];
}

export interface RepoInput {
  id: number;
  fullName: string;
  visibility: "public" | "private";
}

/**
 * The repo with this GitHub id, if the App is installed on it and its installation is active.
 * Verification, preflight and upload use this: anything else is `repo_not_installed`.
 */
export async function installedRepo(db: Executor, repoId: number): Promise<RepoView | undefined> {
  const [repo] = await repoViews(db, [repoId]);
  return repo?.installed ? repo : undefined;
}

/**
 * The installed repo whose current name is `owner/name` (case-insensitive, as GitHub's are), the
 * way the library names a repo: from its clone's `origin` URL.
 */
export async function installedRepoByName(db: Executor, fullName: string): Promise<RepoView | undefined> {
  const candidates = await db
    .selectDistinct({ repoId: repoStates.repoId })
    .from(repoStates)
    .where(sql`lower(${repoStates.fullName}) = lower(${fullName})`);
  const views = await repoViews(
    db,
    candidates.map((row) => row.repoId),
  );
  return views.find((repo) => repo.installed && repo.fullName.toLowerCase() === fullName.toLowerCase());
}

/** An installation and the repos installed on it now. */
export async function installationView(db: Executor, installationId: number): Promise<InstallationView | undefined> {
  const [installation] = await db.select().from(installations).where(eq(installations.githubId, installationId));
  if (!installation) return undefined;
  const state = await installationState(db, installationId);
  const latest = await db
    .selectDistinctOn([repoStates.repoId], { repoId: repoStates.repoId, installationId: repoStates.installationId })
    .from(repoStates)
    .where(eq(repoStates.installationId, installationId))
    .orderBy(repoStates.repoId, desc(repoStates.id));
  const views = await repoViews(
    db,
    latest.map((row) => row.repoId),
  );
  return {
    id: installation.githubId,
    account: installation.targetLogin,
    state,
    repos: views.filter((repo) => repo.installed && repo.installationId === installationId).sort((a, b) => a.fullName.localeCompare(b.fullName)),
  };
}

async function installationState(db: Executor, installationId: number): Promise<InstallationState> {
  const [latest] = await db
    .select({ action: installationEvents.action })
    .from(installationEvents)
    .where(and(eq(installationEvents.installationId, installationId), inArray(installationEvents.action, ["created", "deleted", "suspend", "unsuspend"])))
    .orderBy(desc(installationEvents.id))
    .limit(1);
  if (latest?.action === "deleted") return "deleted";
  if (latest?.action === "suspend") return "suspended";
  return "active";
}

/** The current view of each repo (whether installed or not), in no particular order. */
export async function repoViews(db: Executor, repoIds: number[]): Promise<RepoView[]> {
  if (repoIds.length === 0) return [];
  const states = await db
    .selectDistinctOn([repoStates.repoId])
    .from(repoStates)
    .where(inArray(repoStates.repoId, repoIds))
    .orderBy(repoStates.repoId, desc(repoStates.id));
  const settings = await db
    .selectDistinctOn([repoSettingChanges.repoId])
    .from(repoSettingChanges)
    .where(inArray(repoSettingChanges.repoId, repoIds))
    .orderBy(repoSettingChanges.repoId, desc(repoSettingChanges.id));
  const installationStates = new Map<number, InstallationState>();
  const views: RepoView[] = [];
  for (const state of states) {
    let installationNow = installationStates.get(state.installationId);
    if (!installationNow) {
      installationNow = await installationState(db, state.installationId);
      installationStates.set(state.installationId, installationNow);
    }
    const setting = settings.find((row) => row.repoId === state.repoId);
    views.push({
      id: state.repoId,
      installationId: state.installationId,
      fullName: state.fullName,
      visibility: state.visibility === "private" ? "private" : "public",
      installed: state.installed && installationNow === "active",
      mode: setting?.mode === "enforce" ? "enforce" : "shadow",
      auditOneIn: setting?.auditOneIn ?? INITIAL_REPO_SETTINGS.auditOneIn,
      sandboxAuditOneIn: setting?.sandboxAuditOneIn ?? INITIAL_REPO_SETTINGS.sandboxAuditOneIn,
    });
  }
  return views;
}

/** Records the installation the first time it is seen. */
export async function rememberInstallation(
  db: Executor,
  installation: { id: number; account: { id: number; login: string; type: string } },
): Promise<void> {
  await db
    .insert(installations)
    .values({
      githubId: installation.id,
      targetId: installation.account.id,
      targetLogin: installation.account.login,
      targetType: installation.account.type,
    })
    .onConflictDoNothing();
}

export async function knownInstallation(db: Executor, installationId: number): Promise<boolean> {
  const rows = await db.select({ id: installations.githubId }).from(installations).where(eq(installations.githubId, installationId));
  return rows.length > 0;
}

export async function recordInstallationEvent(db: Executor, installationId: number, action: string, deliveryId: string): Promise<void> {
  await db.insert(installationEvents).values({ installationId, action, deliveryId });
}

/**
 * Records a repo's state after one change. A repo that is added (new, or back after being removed
 * or uninstalled) starts in shadow mode, recorded as a setting change Testnotary made.
 */
export async function recordRepoState(
  db: Executor,
  input: { repo: RepoInput; installationId: number; installed: boolean; change: RepoChange; deliveryId: string },
): Promise<void> {
  await db.insert(repos).values({ githubId: input.repo.id }).onConflictDoNothing();
  await db.insert(repoStates).values({
    repoId: input.repo.id,
    installationId: input.installationId,
    fullName: input.repo.fullName,
    visibility: input.repo.visibility,
    installed: input.installed,
    change: input.change,
    deliveryId: input.deliveryId,
  });
  if (input.change !== "added") return;
  const [current] = await db
    .select()
    .from(repoSettingChanges)
    .where(eq(repoSettingChanges.repoId, input.repo.id))
    .orderBy(desc(repoSettingChanges.id))
    .limit(1);
  if (current?.mode === "shadow") return;
  await db.insert(repoSettingChanges).values({
    repoId: input.repo.id,
    mode: INITIAL_REPO_SETTINGS.mode,
    auditOneIn: current?.auditOneIn ?? INITIAL_REPO_SETTINGS.auditOneIn,
    sandboxAuditOneIn: current?.sandboxAuditOneIn ?? INITIAL_REPO_SETTINGS.sandboxAuditOneIn,
    changedBy: null,
    reason: current ? "reinstalled" : "installed",
  });
}

/** The latest recorded state of a repo, whatever its installation. */
export async function latestRepoState(db: Executor, repoId: number) {
  const [state] = await db.select().from(repoStates).where(eq(repoStates.repoId, repoId)).orderBy(desc(repoStates.id)).limit(1);
  return state;
}
