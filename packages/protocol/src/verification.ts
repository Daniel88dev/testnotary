import { z } from "zod";

// Verification: the action asks the service whether an attestation names the tree of the commit CI
// builds. It sends its Actions OIDC token as `Authorization: Bearer`, the suite and the runner's
// environment, and never a SHA, tree or paths: the service takes the commit from the token and the
// tree from GitHub.

/** The audience the action asks the runner's OIDC token for. */
export const OIDC_AUDIENCE = "https://testnotary.dev";

/** GitHub Actions' OIDC issuer. Its keys are read from `<issuer>/.well-known/jwks`, never by discovery. */
export const ACTIONS_OIDC_ISSUER = "https://token.actions.githubusercontent.com";

const suiteName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);

/** The CI job's environment, recorded to explain results, never to decide a skip. */
export const ciEnvironment = z
  .object({
    /** `RUNNER_OS`: Linux, Windows, macOS. */
    os: z.string().max(50),
    /** `RUNNER_ARCH`: X64, ARM64, … */
    arch: z.string().max(50),
    /** `ImageOS` and `ImageVersion` on GitHub-hosted runners; null on self-hosted ones. */
    image: z.string().max(100).nullable(),
    imageVersion: z.string().max(100).nullable(),
    /** The Node the action runs on. */
    node: z.string().max(50),
  })
  .strict();
export type CiEnvironment = z.infer<typeof ciEnvironment>;

/**
 * `POST /api/v1/verifications`. Unknown fields are dropped unread, so a client that sends a SHA or
 * a tree changes nothing: the service never takes the runner's word for either.
 */
export const verifyRequest = z.object({
  /** The action's `suite` input; null when it was left out (the config must then declare one suite). */
  suite: suiteName.nullable(),
  environment: ciEnvironment,
});
export type VerifyRequest = z.infer<typeof verifyRequest>;

export const verificationResult = z.enum(["skip", "audit", "fallback", "would_skip", "would_fall_back"]);

/** A verification as the service decided and recorded it. */
export const verification = z.object({
  id: z.string(),
  repository: z.object({ id: z.number(), fullName: z.string() }),
  /** The suite in the base config, or the name the job asked for when the config has no such suite. */
  suite: z.string().nullable(),
  /** The commit CI builds (the OIDC `sha`) and its tree, from GitHub's commits API. */
  commit: z.string(),
  tree: z.string(),
  /** The OIDC `event_name`. */
  event: z.string(),
  /** The OIDC token's issuer. */
  iss: z.string(),
  mode: z.enum(["shadow", "enforce"]),
  result: verificationResult,
  /** A fallback reason code; null for a skip or *would skip*. */
  reason: z.string().nullable(),
  /** The attestation matched, with its payload exactly as stored; also when a later step refused it. */
  attestation: z
    .object({
      id: z.string(),
      run: z.object({ id: z.string() }),
      format: z.string(),
      payload: z.string(),
      endedAt: z.string(),
    })
    .nullable(),
  createdAt: z.string(),
});
export type Verification = z.infer<typeof verification>;

/** 200 from `POST /api/v1/verifications` and from `GET /api/v1/verifications/<id>`. */
export const verifyResponse = z.object({ verification });
export type VerifyResponse = z.infer<typeof verifyResponse>;

/**
 * The service's answers that come before any decision, with their status. The action reports each
 * as the fallback reason of the same name. `token_rejected` never says which check failed.
 */
export const VERIFY_REFUSALS = {
  token_rejected: 401,
  repo_not_installed: 404,
} as const;
export type VerifyRefusal = keyof typeof VERIFY_REFUSALS;
