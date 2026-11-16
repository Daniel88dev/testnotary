import { verifyRequest, type VerifyResponse } from "@testnotary/protocol";
import { database } from "../../../../src/db/client.ts";
import { ok, readBody, withGitHubErrors } from "../../../../src/server/http.ts";
import { identifyJob, verifyJob } from "../../../../src/server/verifications.ts";

export const dynamic = "force-dynamic";

/**
 * A CI job's verification. The job is its Actions OIDC token (`Authorization: Bearer`); the body
 * carries the suite and the runner's environment only. 200 with the recorded verification for
 * every decision, a skip or a fallback alike, GitHub refusing or failing the service included
 * (`github_denied`, `github_unavailable`); 401 `token_rejected` and 404 `repo_not_installed` before
 * any; 502 when the Actions keys can't be read and 503 when the service lacks a setting (its audit
 * key, say), which the action treats as a fallback.
 */
export async function POST(request: Request): Promise<Response> {
  return withGitHubErrors(async () => {
    const read = await readBody(request, verifyRequest);
    if ("response" in read) return read.response;
    const db = database();
    const job = await identifyJob(db, request);
    if ("response" in job) return job.response;
    const body: VerifyResponse = await verifyJob(db, job, read.body);
    return ok(body);
  });
}
