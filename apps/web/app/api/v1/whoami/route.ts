import type { WhoamiResponse } from "@testnotary/protocol";
import { ok } from "../../../../src/server/http.ts";
import { authenticate, tokenRejected } from "../../../../src/server/tokens.ts";

export const dynamic = "force-dynamic";

/** The account and token behind the bearer token. Using a laptop token renews it. */
export async function GET(request: Request): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth) return tokenRejected();
  const { id, kind, name, expiresAt } = auth.token;
  const body: WhoamiResponse = { account: auth.account, token: { id, kind, name, expiresAt } };
  return ok(body);
}
