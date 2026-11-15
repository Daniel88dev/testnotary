import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { OIDC_AUDIENCE } from "@testnotary/protocol";
import type { Executor } from "./installations.ts";
import { now, serviceConfig } from "./config.ts";
import { GitHubUnavailable } from "./github.ts";
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

// A token that fails one of these is rejected. Any other failure (the JWKS unreachable, slow or
// malformed) means the service can't tell, which is never a yes and never a no.
const REJECTIONS = new Set([
  "ERR_JOSE_ALG_NOT_ALLOWED",
  "ERR_JOSE_NOT_SUPPORTED",
  "ERR_JWKS_NO_MATCHING_KEY",
  "ERR_JWKS_MULTIPLE_MATCHING_KEYS",
  "ERR_JWS_INVALID",
  "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
  "ERR_JWT_CLAIM_VALIDATION_FAILED",
  "ERR_JWT_EXPIRED",
  "ERR_JWT_INVALID",
]);

/**
 * The token's claims when it is GitHub Actions' and fresh, or undefined to reject it
 * (`token_rejected`, which never says why): RS256 against the root JWKS, `iss` exactly the
 * issuer, `aud` Testnotary, inside its 300 s window with 60 s of skew by the service clock, and a
 * `jti` never seen before. Accepting a token spends its `jti`. Throws GitHubUnavailable when the
 * JWKS can't be read.
 */
export async function acceptActionsToken(db: Executor, token: string): Promise<ActionsClaims | undefined> {
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
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && REJECTIONS.has(code)) return undefined;
    throw new GitHubUnavailable(`the Actions JWKS could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  const { iss, jti, sha, repository_id: repositoryId, event_name: eventName, exp } = payload;
  if (typeof iss !== "string" || typeof jti !== "string" || typeof sha !== "string" || typeof eventName !== "string" || typeof exp !== "number") return undefined;
  if (typeof repositoryId !== "string" || !/^[1-9][0-9]{0,15}$/.test(repositoryId)) return undefined;
  const spent = await db
    .insert(oidcTokenUses)
    .values({ jti, expiresAt: new Date(exp * 1000), at: now() })
    .onConflictDoNothing()
    .returning({ jti: oidcTokenUses.jti });
  if (spent.length === 0) return undefined;
  return { iss, jti, sha, repositoryId: Number(repositoryId), eventName, exp };
}
