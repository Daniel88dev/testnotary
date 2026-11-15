import { z } from "zod";
import { runEnvironment, sessionLabels } from "./run.ts";

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

/**
 * How the CI job's tests ended, as `exec` reported it: `passed`, `failed`, or `refused` when `exec`
 * would not start the command (`config_invalid`, `command_not_found`).
 */
export const jobOutcome = z.enum(["passed", "failed", "refused"]);
export type JobOutcome = z.infer<typeof jobOutcome>;

/**
 * `POST /api/v1/verifications/<id>/report`: one call after the tests ran, with a fresh Actions OIDC
 * token of the same commit. The wall-clock duration is the test command's; the environment is the
 * runner's. Stored as an append-only job report.
 */
export const jobReportRequest = z
  .object({
    outcome: jobOutcome,
    durationMs: z.number().int().min(0).max(7 * 24 * 3_600_000),
    environment: ciEnvironment,
  })
  .strict();
export type JobReportRequest = z.infer<typeof jobReportRequest>;

/** A stored job report. */
export const jobReport = z.object({
  id: z.string(),
  outcome: jobOutcome,
  durationMs: z.number(),
  createdAt: z.string(),
});
export type JobReport = z.infer<typeof jobReport>;

/** 201 from `POST /api/v1/verifications/<id>/report`. */
export const jobReportResponse = z.object({ jobReport });
export type JobReportResponse = z.infer<typeof jobReportResponse>;

/** A commit CI skipped on an account's attestation, as a mismatch copies it in. */
export const skippedCommit = z.object({
  commit: z.string(),
  tree: z.string(),
  suite: z.string().nullable(),
  event: z.string(),
  /** The skip's verification, while retention still holds it. */
  verificationId: z.string(),
  at: z.string(),
});
export type SkippedCommit = z.infer<typeof skippedCommit>;

/**
 * A mismatch: CI's tests failed on a tree an attestation said passed, on an audit or on a shadow
 * *would skip*. Self-contained: everything here was copied in when it was recorded, so it still
 * reads in full after retention prunes the runs, attestations and verifications it came from.
 */
export const mismatch = z.object({
  id: z.string(),
  /** The verification's result: `audit` in enforce mode, `would_skip` in shadow mode. */
  result: z.enum(["audit", "would_skip"]),
  suite: z.string().nullable(),
  /** The commit CI built and its tree, and the event it built it on. */
  commit: z.string(),
  tree: z.string(),
  event: z.string(),
  /** The attester (for a sandbox token, its creator), named as of the attestation: *deleted account* once deleted. */
  account: z.object({ id: z.number(), login: z.string().nullable() }),
  /** The token, with its type and its name when the mismatch was recorded. */
  token: z.object({ id: z.string(), kind: z.enum(["laptop", "sandbox"]), name: z.string() }),
  /** The attestation's payload exactly as stored, and its signature fields (null without a signature). */
  attestation: z.object({
    id: z.string(),
    runId: z.string(),
    /** The commit the attested run was made on, which may differ from CI's. */
    commit: z.string(),
    endedAt: z.string(),
    format: z.string(),
    payload: z.string(),
    signature: z.record(z.string(), z.unknown()).nullable(),
  }),
  /** Both environments: the attested run's and the CI runner's. */
  environments: z.object({ run: runEnvironment.nullable(), ci: ciEnvironment }),
  /** The attested run's agent session labels, unverified. */
  session: sessionLabels.nullable(),
  /** CI's failing report. */
  tests: z.object({ outcome: jobOutcome, durationMs: z.number() }),
  /** Every commit CI skipped on the same account's attestations since its last agreeing audit, newest first, as far as retention held them. */
  skippedCommits: z.array(skippedCommit),
  createdAt: z.string(),
});
export type Mismatch = z.infer<typeof mismatch>;

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
  /**
   * What the reason's line names besides the code, or null: the changed path for
   * `guarded_file_changed` (the first one a guarded glob matched).
   */
  detail: z.string().nullable().default(null),
  /** The attestation matched, with its payload exactly as stored; also when a later step refused it. */
  attestation: z
    .object({
      id: z.string(),
      /** The attested run: its id (the run page), its environment and its unverified session labels. */
      run: z.object({ id: z.string(), environment: runEnvironment.nullable(), session: sessionLabels.nullable() }),
      format: z.string(),
      payload: z.string(),
      endedAt: z.string(),
      /**
       * Who the PR line names: the token's account (for a sandbox token, its creator) with the login
       * GitHub last gave the service (null when it never did), and the token's kind and name.
       */
      attester: z.object({
        account: z.object({ id: z.number(), login: z.string().nullable() }),
        token: z.object({ kind: z.enum(["laptop", "sandbox"]), name: z.string() }),
      }),
    })
    .nullable(),
  /** The CI job's own report of its tests, the latest one; null while none arrived ("outcome unknown"). */
  jobReport: jobReport.nullable(),
  /** The mismatch a failing report on this verification recorded; null when none did. */
  mismatch: mismatch.nullable().default(null),
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
