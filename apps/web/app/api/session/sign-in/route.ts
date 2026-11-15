import { auth, GITHUB_PROVIDER } from "../../../../src/server/auth.ts";
import { formField, localPath, redirectWithCookies, sameOrigin } from "../../../../src/server/browser.ts";

// "Sign in with GitHub": a plain form post that sends the browser to GitHub's authorization page.
// GitHub comes back to /api/auth/callback/github, which sets the session and goes on to `next`.

export async function POST(request: Request): Promise<Response> {
  const instance = auth();
  if (!instance) return Response.json({ error: "not_configured" }, { status: 503 });
  if (!sameOrigin(request)) return Response.json({ error: "bad_origin" }, { status: 403 });
  const next = localPath(await formField(request, "next"), "/dashboard");
  const response = await instance.api.signInSocial({
    body: { provider: GITHUB_PROVIDER, callbackURL: next, errorCallbackURL: "/dashboard?signin=failed", disableRedirect: true },
    headers: request.headers,
    asResponse: true,
  });
  const body = (await response.json().catch(() => ({}))) as { url?: unknown };
  if (!response.ok || typeof body.url !== "string") return redirectWithCookies("/dashboard?signin=failed", undefined);
  return redirectWithCookies(body.url, response);
}
