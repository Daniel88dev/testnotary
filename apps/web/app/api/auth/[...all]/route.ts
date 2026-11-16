import { auth } from "../../../../src/server/auth.ts";

// better-auth's own endpoints: GitHub's sign-in callback (`/api/auth/callback/github`) and the
// session reads it serves. Sign-in and sign-out start at `/api/session/*`.

function handle(request: Request): Promise<Response> | Response {
  const instance = auth();
  if (!instance) return Response.json({ error: "not_configured" }, { status: 503 });
  return instance.handler(request);
}

export const GET = handle;
export const POST = handle;
