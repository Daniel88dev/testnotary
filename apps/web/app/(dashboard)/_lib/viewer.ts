import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { cache } from "react";
import { readableRepos, repoAccess, type ReadableRepo, type RepoAccess } from "../../../src/server/access.ts";
import { viewerFrom, type Viewer } from "../../../src/server/sessions.ts";

// What every dashboard page asks first, once per request (React `cache` shares the answer between
// layouts and pages). See src/server/access.ts for the rules.

/** The signed-in person, or `undefined` when signed out. */
export const getViewer = cache(async (): Promise<Viewer | undefined> => viewerFrom(await headers()));

/** The repo as this person may see it, or `undefined` (not installed, or private and unreadable). */
export const getRepoAccess = cache(async (owner: string, repo: string): Promise<RepoAccess | undefined> => {
  return repoAccess(await getViewer(), decodeURIComponent(owner), decodeURIComponent(repo));
});

/** The repo as this person may see it; a 404 page otherwise. Use in every `[owner]/[repo]` page. */
export async function requireRepoAccess(params: Promise<{ owner: string; repo: string }>): Promise<RepoAccess> {
  const { owner, repo } = await params;
  const access = await getRepoAccess(owner, repo);
  if (!access) notFound();
  return access;
}

/** Every installed repo the signed-in person can read on GitHub (empty when signed out). */
export const getReadableRepos = cache(async (): Promise<ReadableRepo[]> => {
  const viewer = await getViewer();
  return viewer ? readableRepos(viewer) : [];
});
