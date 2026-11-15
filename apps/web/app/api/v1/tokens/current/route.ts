import { database } from "../../../../../src/db/client.ts";
import { ok } from "../../../../../src/server/http.ts";
import { authenticate, revokeToken, tokenRejected } from "../../../../../src/server/tokens.ts";

export const dynamic = "force-dynamic";

/** `testnotary logout`: the bearer revokes its own token. Answers with the token it revoked. */
export async function DELETE(request: Request): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth) return tokenRejected();
  await revokeToken(database(), auth.token.id, "logout");
  const { id, kind, name, expiresAt } = auth.token;
  return ok({ revoked: { id, kind, name, expiresAt } });
}
