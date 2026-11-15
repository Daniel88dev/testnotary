import { runUpload, type RunUploadResponse } from "@testnotary/protocol";
import { database } from "../../../../src/db/client.ts";
import { apiError, ok, withGitHubErrors } from "../../../../src/server/http.ts";
import { gate, recordRun, uploadProblem } from "../../../../src/server/runs.ts";

export const dynamic = "force-dynamic";

/**
 * The one upload after a run, for every outcome. Checks the token and the account's write access
 * again (they may have changed since the preflight), then stores the run and, for a pass, its
 * attestation with the canonical payload's exact bytes. The reserved `report` field is refused
 * when filled.
 */
export async function POST(request: Request): Promise<Response> {
  return withGitHubErrors(async () => {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return apiError(400, "bad_request", "The body is not JSON.");
    }
    if (raw && typeof raw === "object" && "report" in raw && (raw as { report: unknown }).report !== null) {
      return apiError(400, "report_not_supported", "The report field is reserved for per-test results and must be left out in v1.");
    }
    const parsed = runUpload.safeParse(raw);
    if (!parsed.success) return apiError(400, "bad_request", parsed.error.message);
    const upload = parsed.data;
    const db = database();
    const passed = await gate(db, request, upload.repository);
    if ("response" in passed) return passed.response;
    const { auth, repo } = passed;
    if (upload.outcome !== "refused") {
      const problem = uploadProblem(upload, auth, repo);
      if (problem) return apiError(400, problem.error, problem.message);
    }
    const stored = await recordRun(db, upload, auth, repo);
    const body: RunUploadResponse = { run: { id: stored.runId }, attestation: stored.attestationId ? { id: stored.attestationId } : null };
    return ok(body, 201);
  });
}
