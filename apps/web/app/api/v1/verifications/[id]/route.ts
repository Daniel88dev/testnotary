import type { VerifyResponse } from "@testnotary/protocol";
import { database } from "../../../../../src/db/client.ts";
import { apiError, ok, withGitHubErrors } from "../../../../../src/server/http.ts";
import { identifyJob, readVerification } from "../../../../../src/server/verifications.ts";

export const dynamic = "force-dynamic";

/**
 * One verification, read back by a later step of the same repo's CI (the test job given a gate
 * job's `verification` id) with its own fresh Actions OIDC token. A verification of another repo,
 * or an id that isn't one, is a 404.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return withGitHubErrors(async () => {
    const db = database();
    const job = await identifyJob(db, request);
    if ("response" in job) return job.response;
    const { id } = await context.params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return apiError(404, "not_found");
    const verification = await readVerification(db, id, job.repo.id);
    if (!verification) return apiError(404, "not_found");
    const body: VerifyResponse = { verification };
    return ok(body);
  });
}
