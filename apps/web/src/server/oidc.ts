import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { OIDC_AUDIENCE } from "@testnotary/protocol";
import type { Executor } from "./installations.ts";
import { now, serviceConfig } from "./config.ts";
import { GitHubUnavailable } from "./github.ts";
import { logEvent } from "./log.ts";
import { oidcTokenUses } from "../db/schema.ts";

// The Actions OIDC token a CI job sends with each verification (NOTES/github-behaviours.md §2).

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
  exp: number;
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

/** Logs why a token was rejected (`token_rejected` itself never says) and answers undefined. */
function rejected(reason: string, detail?: string): undefined {
  logEvent({ level: "warn", event: "token_rejected", reason, ...(detail ? { detail } : {}) });
  return undefined;
}

/**
 * The token's claims when it is GitHub Actions' and fresh, or undefined to reject it
 * (`token_rejected`, which never tells the caller why; the service logs it): RS256 against the
 * root JWKS, `iss` exactly the issuer, `aud` Testnotary, inside its 300 s window with 60 s of skew
 * by the service clock, and a `jti` never seen before. Accepting a token spends its `jti`. Throws
 * GitHubUnavailable when the JWKS can't be read.
 */
export async function acceptActionsToken(db: Executor, token: string | undefined): Promise<ActionsClaims | undefined> {
  if (!token) return rejected("no_token");
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, keySet(), {
      algorithms: ["RS256"],
      issuer: serviceConfig().actionsOidcIssuer,
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
  if (typeof iss !== "string" || typeof jti !== "string" || typeof sha !== "string" || typeof eventName !== "string" || typeof exp !== "number") {
    return rejected("claim_type");
  }
  if (typeof repositoryId !== "string" || !/^[1-9][0-9]{0,15}$/.test(repositoryId)) return rejected("claim_repository_id");
  const spent = await db
    .insert(oidcTokenUses)
    .values({ jti, expiresAt: new Date(exp * 1000), at: now() })
    .onConflictDoNothing()
    .returning({ jti: oidcTokenUses.jti });
  if (spent.length === 0) return rejected("replayed_jti");
  return { iss, jti, sha, repositoryId: Number(repositoryId), eventName, exp };
}
