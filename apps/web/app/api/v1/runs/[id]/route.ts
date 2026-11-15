import { database } from "../../../../../src/db/client.ts";
import { apiError, ok } from "../../../../../src/server/http.ts";
import { readRun } from "../../../../../src/server/runs.ts";
import { authenticate, tokenRejected } from "../../../../../src/server/tokens.ts";

export const dynamic = "force-dynamic";

/**
 * One of the token's account's own runs, with its attestation payload exactly as uploaded.
 * Another account's run, or an id that isn't one, is a 404.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth) return tokenRejected();
  const { id } = await context.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return apiError(404, "not_found");
  const run = await readRun(database(), id, auth.account.id);
  return run ? ok(run) : apiError(404, "not_found");
}
