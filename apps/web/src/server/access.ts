import { desc, sql } from "drizzle-orm";
import { database } from "../db/client.ts";
import { repoStates } from "../db/schema.ts";
import { now } from "./config.ts";
import { fetchAccessibleRepos, fetchRepoPermission, installationToken, repositoryById, type RepoPermission } from "./github.ts";
import { healRepoState, repoViews, type RepoView } from "./installations.ts";
import type { Viewer } from "./sessions.ts";

// Who may see and do what on a repo's dashboard pages. Access follows GitHub, asked live with the
// signed-in person's own user token, so a removed collaborator loses access at their next request:
// - anyone, signed in or not, reads a public installed repo (read-only);
// - a private repo exists only for people GitHub shows it to; for everyone else it is not found;
// - write access (admin, maintain or write on GitHub) creates sandbox tokens;
// - admins change settings, explain mismatches, revoke and block.
// GitHub is asked about the repo by its id, never by the name the last webhook left: after a missed
// rename another repo may carry that name. Its answer heals the recorded name and visibility.

export type { RepoPermission } from "./github.ts";

export interface RepoAccess {
  repo: RepoView;
  /** The person's permission on GitHub; `undefined` when signed out. */
  permission: RepoPermission | undefined;
}

/** May act on the repo at all: create sandbox tokens (spec: write access). */
export function hasWriteAccess(access: RepoAccess): boolean {
  return access.permission === "admin" || access.permission === "write";
}

/** May change settings, toggle enforce, explain mismatches, revoke any sandbox token, block laptop tokens. */
export function isAdmin(access: RepoAccess): boolean {
  return access.permission === "admin";
}

/** The installed repo now named `owner/name` (any letter case), whatever it was called before. */
export async function installedRepoNamed(owner: string, name: string): Promise<RepoView | undefined> {
  const db = database();
  const fullName = `${owner}/${name}`.toLowerCase();
  const candidates = await db
    .selectDistinct({ repoId: repoStates.repoId })
    .from(repoStates)
    .where(sql`lower(${repoStates.fullName}) = ${fullName}`)
    .orderBy(desc(repoStates.repoId));
  if (candidates.length === 0) return undefined;
  const views = await repoViews(
    db,
    candidates.map((row) => row.repoId),
  );
  return views.find((view) => view.installed && view.fullName.toLowerCase() === fullName);
}

/**
 * The repo's pages as this person may see them, or `undefined` for "not found": the repo is not
 * installed, or it is private and GitHub does not show it to them (signed out included).
 */
export async function repoAccess(viewer: Viewer | undefined, owner: string, name: string): Promise<RepoAccess | undefined> {
  const repo = await installedRepoNamed(owner, name);
  if (!repo) return undefined;
  if (!viewer) {
    if (repo.visibility !== "public") return undefined;
    const confirmed = await stillPublic(repo);
    return confirmed ? { repo: confirmed, permission: undefined } : undefined;
  }
  const live = await fetchRepoPermission(viewer.githubToken, repo.id);
  // GitHub shows a public repo to everyone: one it doesn't show this person is private now, or gone.
  if (!live) return undefined;
  return { repo: await healRepoState(database(), repo, live), permission: live.permission };
}

/** How long a signed-out read trusts GitHub's word that a repo is public. */
export const PUBLIC_CONFIRMED_FOR_MS = 60_000;

/** When GitHub last said each repo is public, by the service clock. Per process; a short TTL. */
const confirmedPublic = new Map<number, number>();

/**
 * A repo recorded as public, confirmed public with GitHub (the installation token, by the repo's
 * id) at most a minute ago, or undefined: it went private (a lost `privatized` delivery would
 * otherwise leave it readable signed out), or GitHub can't be asked, which fails closed. A changed
 * name or visibility is recorded, as a missed webhook would have.
 */
async function stillPublic(repo: RepoView): Promise<RepoView | undefined> {
  const at = now().getTime();
  const confirmedAt = confirmedPublic.get(repo.id);
  if (confirmedAt !== undefined && at - confirmedAt < PUBLIC_CONFIRMED_FOR_MS) return repo;
  confirmedPublic.delete(repo.id);
  let live;
  try {
    live = await repositoryById(await installationToken(repo.installationId), repo.id);
  } catch {
    return undefined;
  }
  if (!live) return undefined;
  const healed = await healRepoState(database(), repo, live);
  if (healed.visibility !== "public") return undefined;
  confirmedPublic.set(repo.id, at);
  return healed;
}

export interface ReadableRepo extends RepoView {
  permission: RepoPermission;
  /** Installed on the person's own GitHub account (not by an organization or someone else). */
  installedByViewer: boolean;
}

/**
 * Every installed repo the person can read through GitHub (explicit access: their own, a
 * collaborator's, an organization member's), sorted by name. Home lists these.
 */
export async function readableRepos(viewer: Viewer): Promise<ReadableRepo[]> {
  const accessible = await fetchAccessibleRepos(viewer.githubToken);
  if (accessible.length === 0) return [];
  const views = await repoViews(
    database(),
    accessible.map((repo) => repo.id),
  );
  const readable: ReadableRepo[] = [];
  for (const view of views) {
    const github = accessible.find((repo) => repo.id === view.id);
    if (!view.installed || !github) continue;
    readable.push({ ...view, permission: github.permission, installedByViewer: github.installationAccountId === viewer.account.id });
  }
  return readable.sort((a, b) => a.fullName.localeCompare(b.fullName));
}
