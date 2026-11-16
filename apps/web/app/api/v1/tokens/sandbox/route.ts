import type { SandboxTokensResponse } from "@testnotary/protocol";
import { database } from "../../../../../src/db/client.ts";
import { ok } from "../../../../../src/server/http.ts";
import { authenticate, sandboxTokens, tokenRejected } from "../../../../../src/server/tokens.ts";

export const dynamic = "force-dynamic";

/**
 * `testnotary sandbox-key <token-name>`: the live sandbox tokens the bearer's account created, so
 * the CLI can name one by its name. Laptop tokens only; a sandbox token is upload only. Never a
 * token's value, which is shown once at creation.
 */
export async function GET(request: Request): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth || auth.token.kind === "sandbox") return tokenRejected();
  const tokens = await sandboxTokens(database(), { createdBy: auth.account.id });
  const body: SandboxTokensResponse = {
    account: auth.account,
    tokens: tokens.map((token) => ({ id: token.id, name: token.name, repository: token.repo, expiresAt: token.expiresAt.toISOString() })),
  };
  return ok(body);
}
