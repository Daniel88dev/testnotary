import { collaboratorPermission, installationToken, userById } from "./github.ts";
import type { Executor, RepoView } from "./installations.ts";
import { rememberAccount } from "./tokens.ts";

// Write access, checked live with GitHub every time: at preflight, at upload, and (T-814) at
// verification. Only `admin` or `write` counts; `read` is what anyone has on a public repo.
// Throws GitHubUnavailable, GitHubDenied or GitHubNotConfigured when GitHub can't say; callers
// wrap their handler in `withGitHubErrors`, so that is never taken as a no.

/**
 * Whether the account (for a sandbox token, the account that created it) can write to the repo.
 * The login is looked up by id first, since a person may have renamed themselves since signing in;
 * an id GitHub no longer knows has no access. A caller that already bought an installation token
 * for the repo passes it.
 */
export async function hasWriteAccess(db: Executor, repo: RepoView, accountId: number, installation?: string): Promise<boolean> {
  const token = installation ?? (await installationToken(repo.installationId));
  const user = await userById(token, accountId);
  if (!user) return false;
  await rememberAccount(db, user);
  const permission = await collaboratorPermission(token, repo.fullName, user.login);
  return permission === "admin" || permission === "write";
}
