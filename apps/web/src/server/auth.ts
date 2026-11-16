import { betterAuth } from "better-auth";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { SESSION_SECONDS, serviceConfig, type ServiceConfig } from "./config.ts";
import { fetchUser } from "./github.ts";

// Browser sessions, and only those (the CLI's tokens are ours, see tokens.ts). better-auth runs the
// GitHub App's own web sign-in (its client id and secret; no separate OAuth App) and keeps the
// session statelessly in signed, encrypted cookies: no session or user table, because the app role
// may only insert and select. A signed-out session is remembered in `session_ends` (sessions.ts).
//
// The cookies, all strictly necessary and named here for the privacy policy:
// - `testnotary.session_token`: the session (signed), for the session's lifetime;
// - `testnotary.session_data`: the session's contents (encrypted), same lifetime;
// - `testnotary.account_data`: the GitHub user token the dashboard reads GitHub with (encrypted);
// - `testnotary.oauth_state`: the sign-in in progress, 10 minutes.
// The privacy policy (content/legal/privacy.md) lists the same names; e2e/legal.spec.ts checks it.

export const GITHUB_PROVIDER = "github";
export const COOKIE_PREFIX = "testnotary";
export { SESSION_SECONDS } from "./config.ts";

const DISABLED_PATHS = [
  "/sign-up/email",
  "/sign-in/email",
  "/update-user",
  "/delete-user",
  "/change-email",
  "/change-password",
  "/set-password",
  "/link-social",
  "/unlink-account",
  "/revoke-session",
  "/revoke-sessions",
  "/revoke-other-sessions",
  "/request-password-reset",
  "/reset-password",
  "/send-verification-email",
  "/verify-email",
];

/** GitHub's no-reply address for an account: `<id>+<login>@users.noreply.github.com`. */
export function noReplyAddress(id: number, login: string): string {
  return `${id}+${login}@users.noreply.github.com`;
}

/** The GitHub account a session belongs to, read back from its no-reply address. */
export function githubIdentity(email: string): { id: number; login: string } | undefined {
  const match = /^(\d+)\+([A-Za-z0-9-]+(?:\[bot\])?)@users\.noreply\.github\.com$/.exec(email);
  return match ? { id: Number(match[1]), login: match[2]! } : undefined;
}

function createAuth(config: ServiceConfig) {
  if (!config.authSecret || !config.githubClientId || !config.githubClientSecret) return undefined;
  return betterAuth({
    appName: "Testnotary",
    baseURL: config.publicUrl,
    basePath: "/api/auth",
    secret: config.authSecret,
    trustedOrigins: [config.publicUrl],
    telemetry: { enabled: false },
    session: {
      expiresIn: SESSION_SECONDS,
      cookieCache: { enabled: true, strategy: "jwe", maxAge: SESSION_SECONDS, refreshCache: false },
    },
    account: { storeStateStrategy: "cookie", storeAccountCookie: true },
    // No IP address in the session (the user agent stays in its encrypted cookie only).
    advanced: { cookiePrefix: COOKIE_PREFIX, ipAddress: { disableIpTracking: true } },
    // Only sign-in, its callback, the session read and sign-out are used. Everything that lets a
    // browser change its own user (name, email, linked accounts) is switched off.
    disabledPaths: DISABLED_PATHS,
    plugins: [
      genericOAuth({
        config: [
          {
            providerId: GITHUB_PROVIDER,
            name: "GitHub",
            clientId: config.githubClientId,
            clientSecret: config.githubClientSecret,
            authorizationUrl: `${config.githubWebUrl}/login/oauth/authorize`,
            tokenUrl: `${config.githubWebUrl}/login/oauth/access_token`,
            pkce: true,
            scopes: [],
            async getUserInfo(tokens) {
              const user = await fetchUser(tokens.accessToken ?? "");
              if (user.kind !== "user") return null;
              return {
                id: user.id,
                name: user.login,
                // The App has no email permission and needs none. The session's email is GitHub's
                // no-reply address for the account, which carries its id and login and which no
                // endpoint lets the browser change: `githubIdentity` reads the person from it.
                email: noReplyAddress(user.id, user.login),
                emailVerified: false,
                image: `/api/avatars/${user.id}`,
              };
            },
          },
        ],
      }),
    ],
  });
}

type Auth = NonNullable<ReturnType<typeof createAuth>>;

const instances = new Map<string, Auth | undefined>();

/** better-auth for the current config, or `undefined` when the service lacks a sign-in setting. */
export function auth(): Auth | undefined {
  const config = serviceConfig();
  // A deployed service rebuilds its config from the environment on every call, and each test
  // world has its own: one instance per distinct config.
  const key = JSON.stringify(config);
  if (!instances.has(key)) instances.set(key, createAuth(config));
  return instances.get(key);
}
