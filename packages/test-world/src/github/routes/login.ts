import { githubError, json, route, type RouteContext } from "../router.ts";

// The device flow and the browser sign-in (web application flow) on github.com, and `GET /user` on
// the API (NOTES/github-behaviours.md §11).
// The fake serves both hosts at one URL; the paths do not collide.

/** GitHub takes these as a form or as JSON. */
async function formOrJson(request: Request): Promise<Record<string, string>> {
  const text = await request.text();
  if ((request.headers.get("content-type") ?? "").includes("json")) {
    try {
      return JSON.parse(text) as Record<string, string>;
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

/** JSON only with `Accept: application/json`; GitHub answers form-encoded otherwise. */
function answer(context: RouteContext, body: Record<string, string | number>, status = 200): Response {
  if ((context.request.headers.get("accept") ?? "").includes("json")) return json(status, body);
  const form = new URLSearchParams(Object.entries(body).map(([key, value]): [string, string] => [key, String(value)]));
  return new Response(form.toString(), { status, headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" } });
}

export const loginRoutes = [
  // POST https://github.com/login/device/code: client_id only, no secret.
  route("POST", "/login/device/code", async (context) => {
    const { github, request } = context;
    const form = await formOrJson(request);
    if (form.client_id !== github.app.clientId) return answer(context, { error: "Not Found" }, 404);
    const code = github.deviceFlow.start(form.client_id);
    return answer(context, {
      device_code: code.deviceCode,
      user_code: code.userCode,
      verification_uri: "https://github.com/login/device",
      expires_in: github.deviceFlow.expiresIn,
      interval: code.interval,
    });
  }),

  // GET https://github.com/login/oauth/authorize: the browser sign-in. A person who already
  // authorized the App is sent straight back with a code; tests plan who with `webFlow.approveNext`.
  route("GET", "/login/oauth/authorize", ({ github, url }) => {
    const query = Object.fromEntries(url.searchParams);
    const authorization = github.webFlow.authorize(github.app.clientId, query);
    if (!authorization) {
      return new Response("<!doctype html><title>GitHub</title><h1>No GitHub user is signed in for this authorization</h1>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return new Response(null, { status: 302, headers: { location: authorization.location } });
  }),

  // POST https://github.com/login/oauth/access_token: the device_code grant (no secret), or a code
  // or refresh token from the browser sign-in (client secret required).
  route("POST", "/login/oauth/access_token", async (context) => {
    const { github, request } = context;
    const form = await formOrJson(request);
    if (form.grant_type === "urn:ietf:params:oauth:grant-type:device_code") {
      return answer(context, github.deviceFlow.poll(form.client_id ?? "", form.device_code ?? ""));
    }
    if (form.grant_type === undefined || form.grant_type === "authorization_code" || form.grant_type === "refresh_token") {
      return answer(context, github.webFlow.exchange(github.app, form));
    }
    return answer(context, { error: "unsupported_grant_type", error_description: "The grant type is not supported." });
  }),

  // GET /user with the user token. Under an IP allow list or Entra conditional access GitHub
  // refuses it from the service's address: tests stage that with `github.override("GET", "/user", …)`.
  route("GET", "/user", ({ request, github }) => {
    const token = /^(?:Bearer|token) (\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
    const user = token ? github.state.userTokens.get(token) : undefined;
    if (!user) return githubError(401, "Bad credentials");
    return json(200, {
      login: user.login,
      id: user.id,
      node_id: `U_${user.id}`,
      avatar_url: `https://avatars.githubusercontent.com/u/${user.id}?v=4`,
      type: "User",
      site_admin: false,
      name: null,
    });
  }),
];
