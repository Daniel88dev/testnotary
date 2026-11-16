import { database } from "../../../../../src/db/client.ts";
import { repoAccess } from "../../../../../src/server/access.ts";
import { liveLog } from "../../../../../src/server/overview.ts";
import { viewerFrom } from "../../../../../src/server/sessions.ts";

// The Overview's live verification log, polled by the open page. The same rule as the repo's
// pages: a public repo reads signed out, a private one only for someone GitHub lets read it, and
// anything else is not found. Never cached.

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

export async function GET(request: Request, { params }: { params: Promise<{ owner: string; repo: string }> }): Promise<Response> {
  const { owner, repo } = await params;
  let access;
  try {
    access = await repoAccess(await viewerFrom(request.headers), decodeURIComponent(owner), decodeURIComponent(repo));
  } catch {
    return Response.json({ error: "github_unavailable" }, { status: 503, headers: NO_STORE });
  }
  if (!access) return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  return Response.json({ lines: await liveLog(database(), access.repo.id) }, { headers: NO_STORE });
}
