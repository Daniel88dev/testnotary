import { z } from "zod";
import { isoInstant, objectId } from "./attestation.ts";
import { account } from "./login.ts";

// `testnotary run` against the service: the preflight before the command starts, the one upload
// after it, and reading a run back. Every request carries the token as `Bearer` (or none, so a
// vendor proxy can attach one).

/** A GitHub repo as `owner/name`, read from the clone's `origin` URL. */
export const repositoryName = z.string().max(200).regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*)\/[A-Za-z0-9._-]+$/);

/** The answers the preflight and the upload give as a clear no: the run is refused. */
export const SERVICE_REFUSALS = {
  /** 401: the token is unknown, revoked or expired. Never says which. */
  token_rejected: 401,
  /** 404: no installation of the App covers the repo (or it is suspended). */
  repo_not_installed: 404,
  /** 403: the token's account (a sandbox token's creator) has neither `admin` nor `write`. */
  no_write_access: 403,
} as const;
export type ServiceRefusal = keyof typeof SERVICE_REFUSALS;

/** `POST /api/v1/preflight`: before the command starts, with a timeout of about 3 s. */
export const preflightRequest = z.object({ repository: repositoryName }).strict();
export type PreflightRequest = z.infer<typeof preflightRequest>;

/** The token the service saw, whose account it checked, and the repo's GitHub id. */
export const preflightResponse = z.object({
  account,
  token: z.object({ id: z.string(), kind: z.enum(["laptop", "sandbox"]), name: z.string() }),
  repository: z.object({ id: z.number(), fullName: z.string() }),
});
export type PreflightResponse = z.infer<typeof preflightResponse>;

/** What the run executed with. Recorded to explain results, never to decide a skip. */
export const runEnvironment = z
  .object({
    /** `process.platform`. */
    os: z.string().max(50),
    /** `os.release()`. */
    osVersion: z.string().max(100),
    /** `process.arch`. */
    arch: z.string().max(50),
    /** `process.version`. */
    node: z.string().max(50),
    packageManager: z.object({ name: z.string().max(50), version: z.string().max(100) }).strict().nullable(),
    /** The child's `TZ`. */
    tz: z.string().max(100),
    /** The child's `LANG`. */
    locale: z.string().max(100),
  })
  .strict();
export type RunEnvironment = z.infer<typeof runEnvironment>;

/** The agent session the run says it came from. Always shown *unverified*. */
export const sessionLabels = z
  .object({ vendor: z.string().max(100), id: z.string().max(200).nullable(), url: z.string().max(500).nullable() })
  .strict();

const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(200);
const suiteName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const code = z.string().regex(/^[a-z][a-z0-9_]*$/).max(100);

/**
 * `POST /api/v1/runs` for a run whose command ran: the record "What a run uploads" lists, and for
 * a pass the canonical attestation payload's exact text. Nothing else is accepted: no log, file
 * lists, environment values, hostname, username or local paths. `report` is reserved for later
 * per-test results and refused when filled.
 */
export const completedRunUpload = z
  .object({
    repository: repositoryName,
    outcome: z.enum(["passed", "failed"]),
    suite: suiteName,
    tree: objectId,
    commit: objectId,
    command: z.array(z.string().max(10_000)).min(1).max(1_000),
    exitCode: z.number().int(),
    startedAt: isoInstant,
    endedAt: isoInstant,
    durationMs: z.number().int().nonnegative(),
    environment: runEnvironment,
    session: sessionLabels.nullable(),
    /** The names (never values) of the variables `env.pass` brought in. */
    passedEnv: z.array(envName).max(200),
    guardedMatched: z.array(z.string().max(500)).max(200),
    warnings: z.array(code).max(50),
    notPinned: z.array(z.enum(["runtime", "package_manager"])),
    /** Which of `CI`, `TZ`, `LANG` the config's `env.set` changed. */
    baselineOverrides: z.array(z.enum(["CI", "TZ", "LANG"])),
    /** Required for a pass, refused otherwise. */
    attestation: z.object({ payload: z.string().max(100_000) }).strict().optional(),
    report: z.null().optional(),
  })
  .strict();
export type CompletedRunUpload = z.infer<typeof completedRunUpload>;

/** `POST /api/v1/runs` for a refused run: only the refusal code, tree and commit. */
export const refusedRunUpload = z
  .object({
    repository: repositoryName,
    outcome: z.literal("refused"),
    refusal: code,
    tree: objectId.nullable(),
    commit: objectId.nullable(),
    report: z.null().optional(),
  })
  .strict();
export type RefusedRunUpload = z.infer<typeof refusedRunUpload>;

export const runUpload = z.discriminatedUnion("outcome", [completedRunUpload, refusedRunUpload]);
export type RunUpload = z.infer<typeof runUpload>;

/** 201 from `POST /api/v1/runs`. */
export const runUploadResponse = z.object({
  run: z.object({ id: z.string() }),
  attestation: z.object({ id: z.string() }).nullable(),
});
export type RunUploadResponse = z.infer<typeof runUploadResponse>;

/** `GET /api/v1/runs/<id>`: one of the token's account's own runs. */
export const runResponse = z.object({
  run: z.object({
    id: z.string(),
    repository: z.object({ id: z.number(), fullName: z.string() }),
    outcome: z.enum(["passed", "failed", "refused"]),
    refusal: z.string().nullable(),
    suite: z.string().nullable(),
    tree: z.string().nullable(),
    commit: z.string().nullable(),
    command: z.array(z.string()).nullable(),
    exitCode: z.number().nullable(),
    startedAt: z.string().nullable(),
    endedAt: z.string().nullable(),
    durationMs: z.number().nullable(),
    receivedAt: z.string(),
    account,
    token: z.object({ id: z.string(), kind: z.enum(["laptop", "sandbox"]) }),
    environment: runEnvironment.nullable(),
    session: sessionLabels.nullable(),
    passedEnv: z.array(z.string()),
    guardedMatched: z.array(z.string()),
    warnings: z.array(z.string()),
    notPinned: z.array(z.string()),
    baselineOverrides: z.array(z.string()),
  }),
  /** The attestation, with its payload exactly as uploaded. */
  attestation: z.object({ id: z.string(), format: z.string(), payload: z.string() }).nullable(),
});
export type RunResponse = z.infer<typeof runResponse>;
