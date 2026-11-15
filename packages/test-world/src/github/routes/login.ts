import { githubError, json, route, type RouteContext } from "../router.ts";

// The device flow on github.com and `GET /user` on the API (NOTES/github-behaviours.md §11).
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

  // POST https://github.com/login/oauth/access_token with the device_code grant.
  route("POST", "/login/oauth/access_token", async (context) => {
    const { github, request } = context;
    const form = await formOrJson(request);
    if (form.grant_type !== "urn:ietf:params:oauth:grant-type:device_code") {
      return answer(context, { error: "unsupported_grant_type", error_description: "The grant type is not supported." });
    }
    return answer(context, github.deviceFlow.poll(form.client_id ?? "", form.device_code ?? ""));
  }),

  // GET /user with the user token. Under an IP allow list or Entra conditional access GitHub
  // refuses it from the service's address: tests stage that with `github.override("GET", "/user", …)`.
  route("GET", "/user", ({ request, github }) => {
    const token = /^(?:Bearer|token) (\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
    const user = token ? github.deviceFlow.userTokens.get(token) : undefined;
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
