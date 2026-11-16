import { randomBytes, randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT, type JWK, type JWTPayload } from "jose";
import type { FakeRepo } from "./state.ts";

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

/** What a simulated Actions job looks like to the OIDC issuer. */
export interface ActionsJob {
  repo: FakeRepo;
  /** `GITHUB_SHA`. On `pull_request` that is the test merge commit (live behaviour 2). */
  sha: string;
  ref: string;
  eventName: string;
  actor?: string;
  actorId?: number;
  headRef?: string;
  baseRef?: string;
  workflow?: string;
  runId?: number;
  /** An enterprise slug: the token's `iss` becomes `<issuer>/<slug>`. */
  enterpriseSlug?: string;
  /** Extra or replaced claims. */
  claims?: JWTPayload;
  /** `exp - iat`; GitHub's is 300 s. Shorter makes a token a job holds run low sooner. */
  lifetimeSeconds?: number;
}

/** Token lifetime observed live: `exp - iat = 300` and `iat - nbf = 300` (live behaviour 3). */
export const OIDC_LIFETIME_SECONDS = 300;

/**
 * The Actions OIDC issuer: signing keys, the JWKS, and the per-job token request endpoint a
 * runner exposes as `ACTIONS_ID_TOKEN_REQUEST_URL` / `ACTIONS_ID_TOKEN_REQUEST_TOKEN`.
 */
export class OidcIssuer {
  private keys: Promise<{ privateKey: SigningKey; jwk: JWK }> | undefined;
  private readonly jobs = new Map<string, ActionsJob>();
  /** Seconds since the epoch; replace to issue tokens from another moment. */
  now: () => number = () => Math.floor(Date.now() / 1000);

  private readonly baseUrl: () => string;

  constructor(baseUrl: () => string) {
    this.baseUrl = baseUrl;
  }

  /** `https://token.actions.githubusercontent.com` in production. */
  get issuer(): string {
    return `${this.baseUrl()}/oidc`;
  }

  get jwksUrl(): string {
    return `${this.issuer}/.well-known/jwks`;
  }

  /** Registers a job and returns what the runner would put in its environment. */
  startJob(job: ActionsJob): { requestUrl: string; requestToken: string } {
    const requestToken = randomBytes(16).toString("hex");
    this.jobs.set(requestToken, job);
    return { requestUrl: `${this.issuer}/_request?api-version=2.0`, requestToken };
  }

  job(requestToken: string): ActionsJob | undefined {
    return this.jobs.get(requestToken);
  }

  /** The token a job would receive for `audience` (GitHub's default audience is the owner's URL). */
  async tokenFor(job: ActionsJob, audience?: string): Promise<string> {
    const { repo } = job;
    const iat = this.now();
    const actor = job.actor ?? "octocat";
    // Repos created after 2026-07-15 get the id form of `sub`. Testnotary
    // keys on `repository_id`, never on `sub`.
    const subject = `repo:${repo.owner}@${repo.ownerId}/${repo.name}@${repo.id}`;
    const claims: JWTPayload = {
      jti: randomUUID(),
      sub: job.eventName === "pull_request" ? `${subject}:pull_request` : `${subject}:ref:${job.ref}`,
      aud: audience ?? `https://github.com/${repo.owner}`,
      ref: job.ref,
      sha: job.sha,
      repository: repo.fullName,
      repository_owner: repo.owner,
      repository_owner_id: String(repo.ownerId),
      repository_id: String(repo.id),
      repository_visibility: repo.visibility,
      run_id: String(job.runId ?? 1),
      run_number: "1",
      run_attempt: "1",
      actor,
      actor_id: String(job.actorId ?? 583231),
      workflow: job.workflow ?? "CI",
      head_ref: job.headRef ?? "",
      base_ref: job.baseRef ?? "",
      event_name: job.eventName,
      ref_type: "branch",
      workflow_ref: `${repo.fullName}/.github/workflows/ci.yml@${job.ref}`,
      workflow_sha: job.sha,
      job_workflow_ref: `${repo.fullName}/.github/workflows/ci.yml@${job.ref}`,
      job_workflow_sha: job.sha,
      check_run_id: String(job.runId ?? 1),
      runner_environment: "github-hosted",
      ...(job.enterpriseSlug ? { enterprise: job.enterpriseSlug, enterprise_id: "123" } : {}),
      // An enterprise slug issuer is signed by the same keys as the root issuer.
      iss: job.enterpriseSlug ? `${this.issuer}/${job.enterpriseSlug}` : this.issuer,
      nbf: iat - OIDC_LIFETIME_SECONDS,
      iat,
      exp: iat + (job.lifetimeSeconds ?? OIDC_LIFETIME_SECONDS),
      ...job.claims,
    };
    return this.sign(claims);
  }

  /** Signs any claims with the issuer's key, for tests that need a malformed or foreign token. */
  async sign(claims: JWTPayload): Promise<string> {
    const { privateKey, jwk } = await this.keyPair();
    return new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: jwk.kid!, typ: "JWT" }).sign(privateKey);
  }

  async jwks(): Promise<{ keys: JWK[] }> {
    return { keys: [(await this.keyPair()).jwk] };
  }

  private keyPair() {
    this.keys ??= (async () => {
      const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
      const jwk = { ...(await exportJWK(publicKey)), kid: randomBytes(8).toString("hex"), alg: "RS256", use: "sig" };
      return { privateKey, jwk };
    })();
    return this.keys;
  }
}
