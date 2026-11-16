import { auth } from "../../../../src/server/auth.ts";
import { redirectWithCookies, sameOrigin } from "../../../../src/server/browser.ts";
import { endSession } from "../../../../src/server/sessions.ts";

// "Sign out": records the session as ended (so a surviving copy of its cookie is worthless) and
// clears the session cookies.

export async function POST(request: Request): Promise<Response> {
  const instance = auth();
  if (!instance) return redirectWithCookies("/dashboard", undefined);
  if (!sameOrigin(request)) return Response.json({ error: "bad_origin" }, { status: 403 });
  const session = await instance.api.getSession({ headers: request.headers }).catch(() => null);
  if (session) await endSession(session.session.id);
  const response = await instance.api.signOut({ headers: request.headers, asResponse: true }).catch(() => undefined);
  return redirectWithCookies("/dashboard", response);
}
