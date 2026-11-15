import { desc, sql } from "drizzle-orm";
import { database } from "../db/client.ts";
import { repoStates } from "../db/schema.ts";
import { fetchAccessibleRepos, fetchRepoPermission, type RepoPermission } from "./github.ts";
import { repoViews, type RepoView } from "./installations.ts";
import type { Viewer } from "./sessions.ts";

// Who may see and do what on a repo's dashboard pages. Access follows GitHub, asked live with the
// signed-in person's own user token, so a removed collaborator loses access at their next request:
// - anyone, signed in or not, reads a public installed repo (read-only);
// - a private repo exists only for people GitHub shows it to; for everyone else it is not found;
// - write access (admin, maintain or write on GitHub) creates sandbox tokens;
// - admins change settings, explain mismatches, revoke and block.

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
  if (!viewer) return repo.visibility === "public" ? { repo, permission: undefined } : undefined;
  const permission = await fetchRepoPermission(viewer.githubToken, repo.fullName);
  if (!permission && repo.visibility !== "public") return undefined;
  return { repo, permission: permission ?? "read" };
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
