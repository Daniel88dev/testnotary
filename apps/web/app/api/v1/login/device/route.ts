import { ok, withGitHubErrors } from "../../../../../src/server/http.ts";
import { startLogin } from "../../../../../src/server/login.ts";

export const dynamic = "force-dynamic";

/** Starts `testnotary login`: a GitHub device code for the App. */
export function POST(): Promise<Response> {
  return withGitHubErrors(async () => ok(await startLogin()));
}
