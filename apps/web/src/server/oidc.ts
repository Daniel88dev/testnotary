import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { OIDC_AUDIENCE } from "@testnotary/protocol";
import type { Executor } from "./installations.ts";
import { now, serviceConfig } from "./config.ts";
import { GitHubUnavailable } from "./github.ts";
import { logEvent } from "./log.ts";
import { oidcTokenUses } from "../db/schema.ts";

// The Actions OIDC token a CI job sends with each verification.

/** Tokens live 300 s from `iat`; the service allows 60 s of clock skew on every time claim. */
const TOKEN_LIFETIME_S = 300;
const SKEW_S = 60;

/** The claims a verification uses. Testnotary keys on `repository_id`, never on names or `sub`. */
export interface ActionsClaims {
  iss: string;
  jti: string;
  /** The commit CI builds: `GITHUB_SHA`, the test merge commit on `pull_request`. */
  sha: string;
  repositoryId: number;
  eventName: string;
  /** The ref the workflow ran for, e.g. `refs/heads/main` on a push; empty when the token has none. */
  ref: string;
  exp: number;
  /**
   * Where the job's log is: `run_id`, `run_attempt` and `check_run_id` (the job's id), when the
   * token carries them as decimal strings. Shown as the CI log link, never used to decide.
   */
  ciRun: { runId: number; attempt: number | null; jobId: number | null } | null;
}

/** A claim GitHub sends as a decimal string (`run_id`, `run_attempt`, `check_run_id`), or null. */
function numericClaim(value: unknown): number | null {
  return typeof value === "string" && /^[1-9][0-9]{0,15}$/.test(value) ? Number(value) : null;
}

// One key set per JWKS URL, so its keys are cached between requests (jose refetches on an unknown
// `kid`, at most every 30 s).
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function keySet(): ReturnType<typeof createRemoteJWKSet> {
  // The root issuer's JWKS only: never discovery on a token's `iss`, never `<iss>/.well-known/jwks`.
  const url = `${serviceConfig().actionsOidcIssuer}/.well-known/jwks`;
  let set = keySets.get(url);
  if (!set) {
    set = createRemoteJWKSet(new URL(url), { timeoutDuration: 5_000 });
    keySets.set(url, set);
  }
  return set;
}

// Why a token was rejected, by jose's error code: for the service's log only, never the caller. A
// failure not listed here (the JWKS unreachable, slow or malformed) means the service can't tell,
// which is never a yes and never a no.
const REJECTIONS: Record<string, string> = {
  ERR_JOSE_ALG_NOT_ALLOWED: "algorithm",
  ERR_JOSE_NOT_SUPPORTED: "algorithm",
  ERR_JWKS_NO_MATCHING_KEY: "unknown_key",
  ERR_JWKS_MULTIPLE_MATCHING_KEYS: "ambiguous_key",
  ERR_JWS_INVALID: "malformed",
  ERR_JWS_SIGNATURE_VERIFICATION_FAILED: "signature",
  ERR_JWT_CLAIM_VALIDATION_FAILED: "claim",
  ERR_JWT_EXPIRED: "expired",
  ERR_JWT_INVALID: "malformed",
};

/**
 * The issuers accepted: the root issuer, or it plus `/` and one GitHub Enterprise Cloud slug
 * (`https://token.actions.githubusercontent.com/<enterprise>`), anchored at both ends (an
 * unanchored match was Fulcio's CVE-2026-22772). Either way the keys come from the root's JWKS
 * only, never by discovery on `iss`, and `iss` is stored with the verification.
 */
function actionsIssuer(root: string): RegExp {
  return new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(?:/[A-Za-z0-9_-]+)?$`);
}

/** Logs why a token was rejected (`token_rejected` itself never says) and answers undefined. */
function rejected(reason: string, detail?: string): undefined {
  logEvent({ level: "warn", event: "token_rejected", reason, ...(detail ? { detail } : {}) });
  return undefined;
}

/**
 * The token's claims when it is GitHub Actions' and fresh, or undefined to reject it
 * (`token_rejected`, which never tells the caller why; the service logs it): RS256 against the
 * root JWKS, `iss` the issuer or one enterprise slug under it (`actionsIssuer`), `aud` Testnotary, inside its 300 s window with 60 s of skew
 * by the service clock, and a `jti` never seen before. Accepting a token spends its `jti`. Throws
 * GitHubUnavailable when the JWKS can't be read.
 */
export async function acceptActionsToken(db: Executor, token: string | undefined): Promise<ActionsClaims | undefined> {
  if (!token) return rejected("no_token");
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, keySet(), {
      algorithms: ["RS256"],
      audience: OIDC_AUDIENCE,
      currentDate: now(),
      clockTolerance: SKEW_S,
      maxTokenAge: TOKEN_LIFETIME_S,
      requiredClaims: ["jti", "exp", "nbf", "iat", "sha", "repository_id", "event_name"],
    }));
  } catch (error) {
    const { code, claim, message } = error as { code?: unknown; claim?: unknown; message?: unknown };
    const reason = typeof code === "string" ? REJECTIONS[code] : undefined;
    const detail = typeof message === "string" ? message : undefined;
    if (reason === "claim") return rejected(typeof claim === "string" ? `claim_${claim}` : "claim", detail);
    if (reason) return rejected(reason, detail);
    throw new GitHubUnavailable(`the Actions JWKS could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  const { iss, jti, sha, repository_id: repositoryId, event_name: eventName, exp } = payload;
  if (typeof iss !== "string" || !actionsIssuer(serviceConfig().actionsOidcIssuer).test(iss)) {
    return rejected("claim_iss", `unexpected "iss" claim value`);
  }
  if (typeof jti !== "string" || typeof sha !== "string" || typeof eventName !== "string" || typeof exp !== "number") {
    return rejected("claim_type");
  }
  if (typeof repositoryId !== "string" || !/^[1-9][0-9]{0,15}$/.test(repositoryId)) return rejected("claim_repository_id");
  const spent = await db
    .insert(oidcTokenUses)
    .values({ jti, expiresAt: new Date(exp * 1000), at: now() })
    .onConflictDoNothing()
    .returning({ jti: oidcTokenUses.jti });
  if (spent.length === 0) return rejected("replayed_jti");
  const runId = numericClaim(payload.run_id);
  const ciRun = runId === null ? null : { runId, attempt: numericClaim(payload.run_attempt), jobId: numericClaim(payload.check_run_id) };
  const ref = typeof payload.ref === "string" ? payload.ref : "";
  return { iss, jti, sha, repositoryId: Number(repositoryId), eventName, ref, exp, ciRun };
}
