// The audit draw: CI re-runs a random share of the skips it would make. Random to anyone without
// the key, and fixed for a tree: HMAC(per-repo key, tree + suite) compared with the rate. The
// per-repo key is HKDF(master key, repo id, key version); the service holds the master key as a
// secret and the database holds only the version, so rotating means raising the version.
// WebCrypto only (no `node:` imports): it does no I/O.

import type { RepoSettings, TokenKind } from "./index.ts";

/**
 * The least frequent audits a repo can have: 1 in 10 for laptop tokens, 1 in 5 for sandbox
 * tokens. A repo may audit more often (a lower N); a setting may never audit less often.
 */
export const AUDIT_RATE_DEFAULTS = { auditOneIn: 10, sandboxAuditOneIn: 5 } as const;

/** What a repo's audit draws are keyed by: the service's master key, the repo, and the repo's key version. */
export interface AuditKeyInput {
  /** The master key, from Secrets Manager (`AUDIT_MASTER_KEY`), as its UTF-8 bytes. */
  masterKey: string;
  /** GitHub's repo id. */
  repoId: number;
  /** The repo's audit key version; 1 until it is first rotated. */
  keyVersion: number;
}

/** What one draw is about: the tree CI builds and the suite (the job) it would skip. */
export interface AuditSubject {
  tree: string;
  suite: string;
}

const encoder = new TextEncoder();

/** HKDF-SHA256(master key, salt, info: repo id and key version), 32 bytes: the repo's audit key. */
export async function repoAuditKey(input: AuditKeyInput): Promise<Uint8Array> {
  if (!input.masterKey) throw new Error("the audit master key is empty");
  const master = await crypto.subtle.importKey("raw", encoder.encode(input.masterKey), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: encoder.encode("testnotary audit key"), info: encoder.encode(`repo ${input.repoId} version ${input.keyVersion}`) },
    master,
    256,
  );
  return new Uint8Array(bits);
}

/**
 * Where a tree and suite fall in [0, 1) under the repo's key: HMAC-SHA256(key, tree + suite), its
 * first 48 bits as a fraction. Below 1/N means drawn at 1 in N, so a tree drawn at 1 in 10 is also
 * drawn at 1 in 5.
 */
export async function auditPoint(repoKey: Uint8Array, subject: AuditSubject): Promise<number> {
  const key = await crypto.subtle.importKey("raw", repoKey as Uint8Array<ArrayBuffer>, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${subject.tree}\n${subject.suite}`)));
  let value = 0;
  for (let i = 0; i < 6; i++) value = value * 256 + mac[i]!;
  return value / 2 ** 48;
}

/**
 * The rate an attestation's token is drawn at, as N in "1 in N". A setting that would audit less
 * often than the defaults never takes effect (nothing lowers a rate), and a sandbox token is never
 * audited less often than a laptop token.
 */
export function auditOneIn(settings: Pick<RepoSettings, "auditOneIn" | "sandboxAuditOneIn">, tokenKind: TokenKind): number {
  const laptop = clampRate(settings.auditOneIn, AUDIT_RATE_DEFAULTS.auditOneIn);
  if (tokenKind === "laptop") return laptop;
  return Math.min(laptop, clampRate(settings.sandboxAuditOneIn, AUDIT_RATE_DEFAULTS.sandboxAuditOneIn));
}

/**
 * The sandbox rate a repo gets unless an admin sets another: twice as often as the repo's own rate
 * (1 in 10 → 1 in 5), rounded towards more audits, and never less often than the sandbox default.
 */
export function sandboxAuditDefault(auditOneIn: number): number {
  return Math.min(AUDIT_RATE_DEFAULTS.sandboxAuditOneIn, Math.max(1, Math.floor(auditOneIn / 2)));
}

function clampRate(oneIn: number, least: number): number {
  return Number.isInteger(oneIn) && oneIn >= 1 ? Math.min(oneIn, least) : least;
}

/** Whether the draw picks this tree and suite for an audit at 1 in `oneIn`. */
export async function auditDrawn(repoKey: Uint8Array, subject: AuditSubject, oneIn: number): Promise<boolean> {
  return (await auditPoint(repoKey, subject)) * oneIn < 1;
}

/**
 * Why a repo's audit rates can't be set as given, or undefined when they can: each is a whole
 * "1 in N" with N from 1 (every skip audited) up to its default, 10 for the repo and 5 for
 * sandbox tokens. Raising a rate means a lower N; nothing can go below the defaults.
 */
export function auditRateProblem(settings: Pick<RepoSettings, "auditOneIn" | "sandboxAuditOneIn">): string | undefined {
  if (!Number.isInteger(settings.auditOneIn) || settings.auditOneIn < 1 || settings.auditOneIn > AUDIT_RATE_DEFAULTS.auditOneIn) {
    return `The audit rate must be between 1 in 1 and 1 in ${AUDIT_RATE_DEFAULTS.auditOneIn}; it can be raised, never lowered below 1 in ${AUDIT_RATE_DEFAULTS.auditOneIn}.`;
  }
  if (
    !Number.isInteger(settings.sandboxAuditOneIn) ||
    settings.sandboxAuditOneIn < 1 ||
    settings.sandboxAuditOneIn > AUDIT_RATE_DEFAULTS.sandboxAuditOneIn
  ) {
    return `The sandbox audit rate must be between 1 in 1 and 1 in ${AUDIT_RATE_DEFAULTS.sandboxAuditOneIn}; it can be raised, never lowered below 1 in ${AUDIT_RATE_DEFAULTS.sandboxAuditOneIn}.`;
  }
  return undefined;
}
