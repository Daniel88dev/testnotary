import { preflightRequest, type PreflightResponse } from "@testnotary/protocol";
import { database } from "../../../../src/db/client.ts";
import { ok, readBody, withGitHubErrors } from "../../../../src/server/http.ts";
import { gate } from "../../../../src/server/runs.ts";

export const dynamic = "force-dynamic";

/**
 * Before a run starts: names the token the service saw, and says a clear no (`token_rejected`,
 * `repo_not_installed`, `no_write_access`) before the tests are spent. A GitHub problem is a 502,
 * which the library takes as "unreachable": the tests run, nothing is attested.
 */
export async function POST(request: Request): Promise<Response> {
  return withGitHubErrors(async () => {
    const read = await readBody(request, preflightRequest);
    if ("response" in read) return read.response;
    const db = database();
    const passed = await gate(db, request, read.body.repository);
    if ("response" in passed) return passed.response;
    const { auth, repo } = passed;
    const body: PreflightResponse = {
      account: auth.account,
      token: { id: auth.token.id, kind: auth.token.kind, name: auth.token.name },
      repository: { id: repo.id, fullName: repo.fullName },
    };
    return ok(body);
  });
}
