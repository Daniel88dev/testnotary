import type { FakeAccount, FakeInstallation } from "../app.ts";
import { githubError, json, notFound, route, type RouteContext } from "../router.ts";
import type { FakeRepo } from "../state.ts";

type Folded = "admin" | "write" | "read" | "none";

// What the dashboard asks GitHub with the signed-in person's user token (`ghu_`): which installed
// repos they can read, and their permission on one repo. A user token of a GitHub App reaches only
// repos the App is installed on, intersected with what the person can access (GitHub docs, "About
// authentication with a GitHub App on behalf of a user"); public repos stay readable to anyone.

/** The person behind the request's user token: `undefined` with no token, `null` for an unknown one. */
function bearerUser({ request, github }: RouteContext): FakeAccount | null | undefined {
  const header = request.headers.get("authorization");
  if (!header) return undefined;
  const token = /^(?:Bearer|token) (\S+)$/i.exec(header)?.[1];
  return (token && github.state.userTokens.get(token)) || null;
}

function installationOf(context: RouteContext, repo: FakeRepo): FakeInstallation | undefined {
  return [...context.github.state.installations.values()].find((installation) => installation.repoIds.has(repo.id));
}

/** GitHub's `permissions` object for a folded permission. */
function permissionsObject(permission: Folded) {
  return {
    admin: permission === "admin",
    maintain: permission === "admin",
    push: permission === "admin" || permission === "write",
    triage: permission !== "none",
    pull: permission !== "none",
  };
}

function repoBody(repo: FakeRepo, permission: Folded, withPermissions: boolean) {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: repo.fullName,
    private: repo.visibility === "private",
    visibility: repo.visibility,
    owner: { login: repo.owner, id: repo.ownerId },
    default_branch: repo.defaultBranch,
    ...(withPermissions ? { permissions: permissionsObject(permission) } : {}),
  };
}

function page<T>(context: RouteContext, items: T[]): T[] {
  const perPage = Math.min(Number(context.url.searchParams.get("per_page") ?? 30) || 30, 100);
  const number = Math.max(Number(context.url.searchParams.get("page") ?? 1) || 1, 1);
  return items.slice((number - 1) * perPage, number * perPage);
}

/** The installation's repos the person has explicit access to (what `/user/installations` counts). */
function accessibleRepos(context: RouteContext, installation: FakeInstallation, user: FakeAccount): FakeRepo[] {
  const { state } = context.github;
  return [...state.repos.values()]
    .filter((repo) => {
      const role = state.explicitRole(repo, user);
      return installation.repoIds.has(repo.id) && role !== undefined && role !== "none";
    })
    .sort((a, b) => a.id - b.id);
}

export const userAccessRoutes = [
  // GET /repos/{owner}/{repo}: with a user token, `permissions` says what the person may do.
  // A private repo the person (or the App) cannot reach is 404, as GitHub never confirms it exists.
  route("GET", "/repos/:owner/:repo", (context) => {
    const user = bearerUser(context);
    if (user === null) return githubError(401, "Bad credentials");
    const repo = context.github.state.repo(context.params.owner!, context.params.repo!);
    if (!repo) return notFound();
    const permission: Folded = user ? context.github.state.permission(repo, user) : repo.visibility === "public" ? "read" : "none";
    if (permission === "none") return notFound();
    if (repo.visibility === "private" && !installationOf(context, repo)) return notFound();
    return json(200, repoBody(repo, permission, user !== undefined));
  }),

  // GET /user/installations: installations of the App where the person can access at least one repo.
  route("GET", "/user/installations", (context) => {
    const user = bearerUser(context);
    if (!user) return githubError(401, "Requires authentication");
    const { github } = context;
    const installations = [...github.state.installations.values()]
      .filter((installation) => installation.account.id === user.id || accessibleRepos(context, installation, user).length > 0)
      .sort((a, b) => a.id - b.id);
    return json(200, {
      total_count: installations.length,
      installations: page(context, installations).map((installation) => ({
        id: installation.id,
        account: { login: installation.account.login, id: installation.account.id, type: installation.account.type },
        app_id: github.app.id,
        app_slug: github.app.slug,
        target_id: installation.account.id,
        target_type: installation.account.type,
        repository_selection: "selected",
        permissions: { contents: "read", metadata: "read" },
        suspended_at: installation.suspended ? new Date().toISOString() : null,
      })),
    });
  }),

  // GET /user/installations/{installation_id}/repositories: the repos in it the person has explicit
  // access to, with their permissions.
  route("GET", "/user/installations/:id/repositories", (context) => {
    const user = bearerUser(context);
    if (!user) return githubError(401, "Requires authentication");
    const installation = context.github.state.installations.get(Number(context.params.id));
    if (!installation) return notFound();
    const repos = accessibleRepos(context, installation, user);
    if (repos.length === 0 && installation.account.id !== user.id) return notFound();
    return json(200, {
      total_count: repos.length,
      repository_selection: "selected",
      repositories: page(context, repos).map((repo) => repoBody(repo, context.github.state.permission(repo, user), true)),
    });
  }),
];
