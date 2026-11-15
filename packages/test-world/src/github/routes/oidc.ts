import { githubError, json, route } from "../router.ts";
import type { FakeGitHub } from "../server.ts";

// The Actions OIDC issuer (token.actions.githubusercontent.com in production), mounted under /oidc.
// See NOTES/github-behaviours.md §1 and §2.

function discovery(github: FakeGitHub, issuer: string) {
  return json(200, {
    issuer,
    // Always the root JWKS, also for a slug issuer.
    jwks_uri: github.oidc.jwksUrl,
    subject_types_supported: ["public", "pairwise"],
    response_types_supported: ["id_token"],
    id_token_signing_alg_values_supported: ["RS256"],
  });
}

export const oidcRoutes = [
  route("GET", "/oidc/.well-known/openid-configuration", ({ github }) => discovery(github, github.oidc.issuer)),

  // Any slug, even a made-up one, gets a discovery document naming it as the issuer. Its own
  // `/<slug>/.well-known/jwks` has no route and so answers 404, as GitHub's does: a service that
  // trusts discovery on `iss`, or appends the JWKS path to it, fails.
  route("GET", "/oidc/:slug/.well-known/openid-configuration", ({ github, params }) =>
    discovery(github, `${github.oidc.issuer}/${params.slug}`),
  ),

  route("GET", "/oidc/.well-known/jwks", async ({ github }) => json(200, await github.oidc.jwks())),

  // The runner's token request endpoint: ACTIONS_ID_TOKEN_REQUEST_URL plus `&audience=`.
  route("GET", "/oidc/_request", async ({ request, url, github }) => {
    const bearer = /^Bearer (.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
    const job = bearer ? github.oidc.job(bearer) : undefined;
    if (!job) return githubError(401, "Bad credentials");
    const audience = url.searchParams.get("audience") ?? undefined;
    return json(200, { count: 1, value: await github.oidc.tokenFor(job, audience) });
  }),
];
