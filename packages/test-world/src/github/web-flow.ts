import { createHash, randomBytes } from "node:crypto";
import type { FakeAccount } from "./app.ts";

// The browser sign-in: GitHub's web application flow for the App's user tokens (authorize, then
// exchange the code with the client secret; PKCE S256 accepted). Nobody clicks "Authorize" on
// github.com in tests: a test plans who is signed in on GitHub for the next authorization, as a
// person who already authorized the App is sent straight back without a consent screen.

/** User tokens live 8 hours and refresh tokens 6 months, as for an App with expiring user tokens. */
export const USER_TOKEN_LIFETIME_SECONDS = 28_800;
const REFRESH_TOKEN_LIFETIME_SECONDS = 15_897_600;

interface PendingCode {
  code: string;
  user: FakeAccount;
  clientId: string;
  redirectUri: string;
  codeChallenge: string | undefined;
}

export interface Authorization {
  /** Where GitHub sends the browser next. */
  location: string;
}

export class WebFlow {
  /** Every user token (`ghu_…`) handed out, and whose it is (shared with the device flow). */
  readonly userTokens: Map<string, FakeAccount>;
  /** Refresh tokens (`ghr_…`) and whose they are; each works once (GitHub rotates them). */
  readonly refreshTokens = new Map<string, FakeAccount>();
  /** Every authorization request the browser made (its query), oldest first. */
  readonly authorizations: Record<string, string>[] = [];
  private readonly plans: { user?: FakeAccount; deny?: boolean }[] = [];
  private readonly codes = new Map<string, PendingCode>();

  constructor(userTokens: Map<string, FakeAccount>) {
    this.userTokens = userTokens;
  }

  /** The next authorization is approved by `user`, as if they were signed in on github.com. */
  approveNext(user: FakeAccount): void {
    this.plans.push({ user });
  }

  /** The person clicks "Cancel" on GitHub's authorization page for the next authorization. */
  denyNext(): void {
    this.plans.push({ deny: true });
  }

  /** `GET /login/oauth/authorize`: answers with the redirect back to the App, or `undefined` when nothing was planned. */
  authorize(clientId: string, query: Record<string, string>): Authorization | undefined {
    this.authorizations.push(query);
    const redirectUri = query.redirect_uri;
    if (!redirectUri || query.client_id !== clientId) return undefined;
    const plan = this.plans.shift();
    if (!plan) return undefined;
    const back = new URL(redirectUri);
    if (query.state) back.searchParams.set("state", query.state);
    if (plan.deny || !plan.user) {
      back.searchParams.set("error", "access_denied");
      back.searchParams.set("error_description", "The user has denied your application access.");
      return { location: back.toString() };
    }
    const code = randomBytes(10).toString("hex");
    if (query.code_challenge && query.code_challenge_method !== "S256") return undefined;
    this.codes.set(code, { code, user: plan.user, clientId, redirectUri, codeChallenge: query.code_challenge });
    back.searchParams.set("code", code);
    return { location: back.toString() };
  }

  /** `POST /login/oauth/access_token` for a code or a refresh token. GitHub answers 200 with `error` on failure. */
  exchange(app: { clientId: string; clientSecret: string }, form: Record<string, string>): Record<string, string | number> {
    if (form.client_id !== app.clientId || form.client_secret !== app.clientSecret) {
      return oauthError("incorrect_client_credentials", "The client_id and/or client_secret passed are incorrect.");
    }
    if (form.grant_type === "refresh_token") {
      const user = this.refreshTokens.get(form.refresh_token ?? "");
      if (!user) return oauthError("bad_refresh_token", "The refresh token passed is incorrect or expired.");
      this.refreshTokens.delete(form.refresh_token!);
      return this.issue(user);
    }
    const pending = this.codes.get(form.code ?? "");
    if (!pending) return oauthError("bad_verification_code", "The code passed is incorrect or expired.");
    this.codes.delete(pending.code);
    if (form.redirect_uri && form.redirect_uri !== pending.redirectUri) {
      return oauthError("redirect_uri_mismatch", "The redirect_uri MUST match the registered callback URL for this application.");
    }
    if (pending.codeChallenge) {
      const verifier = form.code_verifier ?? "";
      if (createHash("sha256").update(verifier).digest("base64url") !== pending.codeChallenge) {
        return oauthError("bad_verification_code", "The code passed is incorrect or expired.");
      }
    }
    return this.issue(pending.user);
  }

  private issue(user: FakeAccount): Record<string, string | number> {
    const accessToken = `ghu_${randomBytes(18).toString("base64url")}`;
    const refreshToken = `ghr_${randomBytes(30).toString("base64url")}`;
    this.userTokens.set(accessToken, user);
    this.refreshTokens.set(refreshToken, user);
    return {
      access_token: accessToken,
      expires_in: USER_TOKEN_LIFETIME_SECONDS,
      refresh_token: refreshToken,
      refresh_token_expires_in: REFRESH_TOKEN_LIFETIME_SECONDS,
      token_type: "bearer",
      scope: "",
    };
  }
}

function oauthError(error: string, description: string): Record<string, string> {
  return { error, error_description: description, error_uri: "https://docs.github.com/apps/oauth-apps/maintaining-oauth-apps/troubleshooting-oauth-app-access-token-request-errors" };
}
