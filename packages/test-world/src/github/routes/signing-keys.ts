import { json, notFound, route } from "../router.ts";

// `GET /users/{login}/ssh_signing_keys`, read by the action's signature check (with
// `GITHUB_TOKEN`) and by the service at upload (with an installation token). Public data:
// `x-accepted-github-permissions: allows_permissionless_access=true`, so any token, or none, reads
// it. `[]` for an account without keys, 404 for a login GitHub doesn't know. Every answer carries
// GitHub's `cache-control: private, max-age=60`, but the fake serves the current list on every
// request: authenticated reads saw a deleted key gone within 2 s live, and readers must not cache.

export const signingKeyRoutes = [
  route("GET", "/users/:login/ssh_signing_keys", ({ params, url, github }) => {
    const account = github.state.accounts.get(params.login!.toLowerCase());
    if (!account || account.type !== "User") return notFound();
    const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get("per_page") ?? 30) || 30));
    const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
    const keys = github.state.signingKeys.filter((key) => key.accountId === account.id);
    const slice = keys.slice((page - 1) * perPage, page * perPage);
    return json(
      200,
      slice.map((key) => ({ id: key.id, key: key.key, title: key.title, created_at: key.createdAt })),
      { "cache-control": "private, max-age=60, s-maxage=60", "x-accepted-github-permissions": "allows_permissionless_access=true" },
    );
  }),
];
