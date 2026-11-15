import { jobReportRequest, type JobReportResponse } from "@testnotary/protocol";
import { database } from "../../../../../../src/db/client.ts";
import { apiError, ok, readBody, withGitHubErrors } from "../../../../../../src/server/http.ts";
import { identifyJob, recordJobReport } from "../../../../../../src/server/verifications.ts";

export const dynamic = "force-dynamic";

/**
 * A CI job's report of its tests after a verification: the outcome, the test command's wall-clock
 * duration and the runner's environment, sent once after the tests with a fresh Actions OIDC token.
 * 201 with the stored job report; 404 unless the verification is the token's repo's and of the
 * token's commit. The action only warns when this fails.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return withGitHubErrors(async () => {
    const read = await readBody(request, jobReportRequest);
    if ("response" in read) return read.response;
    const db = database();
    const job = await identifyJob(db, request);
    if ("response" in job) return job.response;
    const { id } = await context.params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return apiError(404, "not_found");
    const jobReport = await recordJobReport(db, job, id, read.body);
    if (!jobReport) return apiError(404, "not_found");
    const body: JobReportResponse = { jobReport };
    return ok(body, 201);
  });
}
