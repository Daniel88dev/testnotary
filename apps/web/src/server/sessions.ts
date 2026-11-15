import { eq } from "drizzle-orm";
import type { Account } from "@testnotary/protocol";
import { database } from "../db/client.ts";
import { sessionEnds } from "../db/schema.ts";
import { auth, githubIdentity } from "./auth.ts";
import { rememberAccount } from "./tokens.ts";

// The person behind a browser request: their GitHub account and the GitHub user token the
// dashboard asks GitHub with. Pages read it through `src/web/viewer.ts`; route handlers call
// `viewerFrom(request.headers)` directly.

export interface Viewer {
  /** The GitHub account, keyed by numeric id. */
  account: Account;
  /** better-auth's session id (what a sign-out records). */
  sessionId: string;
  /** The person's `ghu_` token: read GitHub as them (which repos they can read, their permission). Never shown, never stored. */
  githubToken: string;
}

/** The signed-in person, or `undefined`: no session, a signed-out one, or an expired GitHub token. */
export async function viewerFrom(headers: Headers): Promise<Viewer | undefined> {
  const instance = auth();
  if (!instance) return undefined;
  const session = await instance.api.getSession({ headers }).catch(() => null);
  if (!session) return undefined;
  const identity = githubIdentity(session.user.email);
  if (!identity) return undefined;
  const db = database();
  const ended = await db.select({ id: sessionEnds.sessionId }).from(sessionEnds).where(eq(sessionEnds.sessionId, session.session.id));
  if (ended.length > 0) return undefined;
  const token = await instance.api
    .getAccessToken({ body: { useAccountCookie: true }, headers })
    .catch(() => undefined);
  if (!token?.accessToken) return undefined;
  if (token.accessTokenExpiresAt && new Date(token.accessTokenExpiresAt).getTime() <= Date.now()) return undefined;
  const account = { id: identity.id, login: identity.login };
  await rememberAccount(db, account);
  return { account, sessionId: session.session.id, githubToken: token.accessToken };
}

/** Records that a session was signed out, so its cookie stops working even where a copy survives. */
export async function endSession(sessionId: string): Promise<void> {
  await database().insert(sessionEnds).values({ sessionId }).onConflictDoNothing();
}
