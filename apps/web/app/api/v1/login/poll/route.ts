import { devicePollRequest } from "@testnotary/protocol";
import { ok, readBody, withGitHubErrors } from "../../../../../src/server/http.ts";
import { pollLogin } from "../../../../../src/server/login.ts";

export const dynamic = "force-dynamic";

/** One poll of `testnotary login`: pending, failed with a stable reason, or a new laptop token. */
export async function POST(request: Request): Promise<Response> {
  const read = await readBody(request, devicePollRequest);
  if ("response" in read) return read.response;
  return withGitHubErrors(async () => ok(await pollLogin(read.body)));
}
