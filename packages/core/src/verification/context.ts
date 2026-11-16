import type { Suite, TestnotaryConfig } from "../config.ts";
import type { RepoMode, RepoSettings, TokenKind } from "../index.ts";
import type { FallbackReason } from "./reasons.ts";

/** An attestation the service holds for the repo, suite and tree CI builds. */
export interface AttestationCandidate {
  id: string;
  /** The attester: the token's account, for a sandbox token the account that created it. */
  accountId: number;
  tokenId: string;
  tokenKind: TokenKind;
  /** The run's end, as the uploader said: up to a few minutes of clock skew ahead of the service. */
  endedAt: Date;
  /** When the service received the attestation. The age counts from the earlier of the two. */
  createdAt: Date;
  /** The command the attested run executed, from its payload. */
  command: string[];
}

/**
 * What a verification reads from outside, supplied by the service. Every source is asked for only
 * when a step needs it, so a verification that stops early makes no further GitHub calls. Later
 * steps add sources here (changed paths, the audit key, revocations).
 */
export interface VerificationSources {
  /** The repo's default branch, as GitHub has it now; undefined when GitHub doesn't say. Asked for on a push only. */
  defaultBranch(): Promise<string | undefined>;
  /** The text of `testnotary.json` at the built commit's first parent, or undefined when it has none. */
  configAtBase(): Promise<string | undefined>;
  /** Every attestation for the repo and suite that names `tree`, newest run end first. */
  attestations(suite: string): Promise<AttestationCandidate[]>;
  /** Whether the account has `admin` or `write` on the repo, checked live with GitHub. */
  hasWriteAccess(accountId: number): Promise<boolean>;
  /**
   * The paths the built commit changes against its first parent (GitHub's compare), or undefined
   * when the commit has no first parent.
   */
  changedPaths(): Promise<ChangedPaths | undefined>;
  /**
   * The repo's audit key: HKDF of the master key, the repo id and the repo's key version
   * (`repoAuditKey`). Asked for only when the draw is made.
   */
  auditKey(): Promise<Uint8Array>;
  /**
   * What voids the token's attestations on this repo now, if anything: revoked, blocked on this
   * repo, or expired. Undefined while the token stands.
   */
  tokenVoided(tokenId: string): Promise<TokenVoid | undefined>;
}

/** Why a token's attestations no longer count: each reads `attestation_revoked`. */
export type TokenVoid = "revoked" | "blocked" | "expired";

/** What GitHub's compare lists between the first parent and the built commit. */
export interface ChangedPaths {
  /** Every path changed, added or removed; a renamed file's old path too. */
  paths: string[];
  /** False when GitHub cut the list short (it lists 300 files at most), so a path may be missing. */
  complete: boolean;
}

/** What a verification starts from: who asks about which commit, and the repo's mode. */
export interface VerificationInput {
  /** The suite the job named, or null to take the config's only suite. */
  requestedSuite: string | null;
  /** The commit CI builds (the OIDC `sha`) and its tree, as GitHub's commits API gives it. */
  commit: string;
  tree: string;
  /** The OIDC `event_name`. */
  event: string;
  /** The OIDC `ref`, such as `refs/heads/main`; empty when the token has none. */
  ref: string;
  mode: RepoMode;
  /** The repo's audit rates, as "1 in N" (the draw never goes below the defaults whatever they say). */
  rates: Pick<RepoSettings, "auditOneIn" | "sandboxAuditOneIn">;
  /** The service clock's now. */
  now: Date;
  sources: VerificationSources;
}

/**
 * The verification as its steps go: the input plus what each step found, for the steps after it.
 * A step fills its field before it may stop the verification.
 */
export interface VerificationState extends VerificationInput {
  /** The config at the first parent, once the suite step has read it. */
  config?: TestnotaryConfig;
  /** The suite in that config, once the suite step has found it. */
  suite?: Suite;
  /**
   * In the attestation steps, the attestation being judged; after them, the one that cleared them
   * (or, when none did, the newest).
   */
  attestation?: AttestationCandidate;
}

/** A fallback reason with what its line names besides the code, such as the guarded file changed. */
export interface Fallback {
  reason: FallbackReason;
  detail: string;
}

/**
 * One step of the decision order. It answers a fallback reason (alone, or with its detail) to stop
 * the verification there, or undefined to pass it on to the next step.
 */
export interface VerificationStep {
  name: string;
  decide(state: VerificationState): Promise<FallbackReason | Fallback | undefined>;
}

/**
 * The decision order, in three parts. The verification stops at the first reason, except in the
 * attestation steps, which judge each attestation naming the tree in turn, newest first: the first
 * one to clear them all is matched, and when none does, the newest one's reason stands.
 */
export interface VerificationOrder {
  /** Before any attestation: about the suite and the tree CI builds. */
  tree: readonly VerificationStep[];
  /** Run once per attestation naming the tree, with `state.attestation` set to it. */
  attestation: readonly VerificationStep[];
  /** Once an attestation has cleared the attestation steps. */
  matched: readonly VerificationStep[];
}
