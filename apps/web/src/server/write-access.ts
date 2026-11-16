import { GitHubUnavailable, collaboratorPermission, installationToken, repositoryById, userById } from "./github.ts";
import type { Executor, RepoView } from "./installations.ts";
import { rememberAccount } from "./tokens.ts";

// Write access, checked live with GitHub every time: at preflight, at upload, and at
// verification. Only `admin` or `write` counts; `read` is what anyone has on a public repo.
// Throws GitHubUnavailable, GitHubDenied or GitHubNotConfigured when GitHub can't say; callers
// wrap their handler in `withGitHubErrors`, so that is never taken as a no.

/**
 * Whether the account (for a sandbox token, the account that created it) can write to the repo.
 * The login is looked up by id first, since a person may have renamed themselves since signing in;
 * an id GitHub no longer knows has no access. The repo too: its name is asked of GitHub by its id
 * (unless the caller has just done so and passes `liveName`), since after a missed rename another
 * repo may carry the recorded one. A caller that already bought an installation token passes it.
 */
export async function hasWriteAccess(db: Executor, repo: RepoView, accountId: number, installation?: string, liveName?: string): Promise<boolean> {
  const token = installation ?? (await installationToken(repo.installationId));
  const fullName = liveName ?? (await repositoryById(token, repo.id))?.fullName;
  if (!fullName) throw new GitHubUnavailable(`GitHub does not show the installation repo ${repo.id}`);
  const user = await userById(token, accountId);
  if (!user) return false;
  await rememberAccount(db, user);
  const permission = await collaboratorPermission(token, fullName, user.login);
  return permission === "admin" || permission === "write";
}
