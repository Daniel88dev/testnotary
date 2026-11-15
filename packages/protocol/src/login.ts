import { z } from "zod";

// `testnotary login`, `whoami` and `logout` against the service. The library never talks to
// GitHub itself: the service runs the device flow with the App's client id, swaps the `ghu_`
// token for a laptop token straight away and discards it.

/** Public pages the CLI links to. Always the hosted site, whatever service URL is in use. */
export const LINKS = {
  terms: "https://testnotary.dev/terms",
  privacy: "https://testnotary.dev/privacy",
  /** The GitHub Enterprise section of "Limits in v1". */
  githubEnterpriseLimits: "https://testnotary.dev/docs/limits#github-enterprise",
  /** "Agents and sandbox tokens". */
  sandboxTokens: "https://testnotary.dev/docs/agents",
} as const;

/** `POST /api/v1/login/device`: starts a device flow. */
export const deviceStartResponse = z.object({
  deviceCode: z.string(),
  userCode: z.string(),
  verificationUri: z.string(),
  /** Seconds to wait between polls. */
  interval: z.number().nonnegative(),
  expiresIn: z.number().positive(),
});
export type DeviceStartResponse = z.infer<typeof deviceStartResponse>;

/** `POST /api/v1/login/poll` body. */
export const devicePollRequest = z.object({
  deviceCode: z.string().min(1).max(200),
  /** "<OS> machine, <date>", never the hostname. */
  tokenName: z.string().min(1).max(100),
  /** The laptop token this machine held before, revoked when the new one is issued. */
  replaces: z.string().max(200).optional(),
});
export type DevicePollRequest = z.infer<typeof devicePollRequest>;

export const account = z.object({ id: z.number(), login: z.string() });
export type Account = z.infer<typeof account>;

/**
 * The shared tombstone that every record of a deleted account shows instead of it: id 0 and no
 * login. No GitHub account has id 0.
 */
export const DELETED_ACCOUNT = { id: 0, login: null } as const;
export const DELETED_ACCOUNT_NAME = "deleted account";

/** How a record names its account: `@login`, `account <id>` when the login is unknown, or *deleted account*. */
export function accountName(account: { id: number; login: string | null }): string {
  if (account.id === DELETED_ACCOUNT.id) return DELETED_ACCOUNT_NAME;
  return account.login ? `@${account.login}` : `account ${account.id}`;
}

export const tokenInfo = z.object({
  id: z.string(),
  kind: z.enum(["laptop", "sandbox"]),
  name: z.string(),
  /** ISO 8601. A laptop token's moves forward each time it is used. */
  expiresAt: z.string(),
});
export type TokenInfo = z.infer<typeof tokenInfo>;

/**
 * Why a sign-in failed, stable across releases:
 * - `expired_token`, `access_denied`: the device code expired, or the person said no on GitHub.
 * - `github_denied`: GitHub refused the service's `/user` call with the person's token, for an
 *   IP allow list or conditional access (`cause`), with GitHub's own words in `message`.
 * - `github_unavailable`: GitHub could not be reached or answered something unexpected.
 * - `account_suspended`: the operator suspended the account for breaking the terms.
 */
export const loginError = z.enum(["expired_token", "access_denied", "github_denied", "github_unavailable", "account_suspended"]);
export type LoginError = z.infer<typeof loginError>;

export const githubDeniedCause = z.enum(["ip_allow_list", "conditional_access", "unknown"]);
export type GitHubDeniedCause = z.infer<typeof githubDeniedCause>;

export const devicePollResponse = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("pending"),
    /** GitHub said `slow_down`: wait `interval` seconds from now on, or 5 s longer without one. */
    slowDown: z.boolean(),
    interval: z.number().nonnegative().optional(),
  }),
  z.object({ status: z.literal("signed_in"), token: z.string(), account, tokenInfo }),
  z.object({
    status: z.literal("failed"),
    error: loginError,
    cause: githubDeniedCause.optional(),
    message: z.string(),
  }),
]);
export type DevicePollResponse = z.infer<typeof devicePollResponse>;

/** `GET /api/v1/whoami` with a token. */
export const whoamiResponse = z.object({ account, token: tokenInfo });
export type WhoamiResponse = z.infer<typeof whoamiResponse>;

/** The body of every 4xx/5xx answer from the API. */
export const apiError = z.object({ error: z.string(), message: z.string().optional() });
export type ApiError = z.infer<typeof apiError>;
