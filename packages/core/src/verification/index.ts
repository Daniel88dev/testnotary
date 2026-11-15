// The verification decision: whether CI may skip a suite's tests on the tree it builds. The service
// supplies what the steps read (VerificationSources); the steps and their order live here.
import type { RepoMode } from "../index.ts";
import type { AttestationCandidate, VerificationInput, VerificationState, VerificationStep } from "./context.ts";
import type { FallbackReason, VerificationResult } from "./reasons.ts";
import { VERIFICATION_STEPS } from "./steps/index.ts";

export type { AttestationCandidate, VerificationInput, VerificationSources, VerificationState, VerificationStep } from "./context.ts";
export { FALLBACK_REASONS, VERIFICATION_RESULTS, type FallbackReason, type VerificationResult } from "./reasons.ts";
export { ATTESTATION_MAX_AGE_MS } from "./steps/age.ts";
export { VERIFICATION_STEPS } from "./steps/index.ts";

export interface VerificationDecision {
  result: VerificationResult;
  /** Why the tests run (or would run in shadow mode); null for a skip. */
  reason: FallbackReason | null;
  /** The suite's name in the base config, or the name the job asked for when there is none. */
  suite: string | null;
  /** The attestation matched, also when a later step then refused it. */
  attestation: AttestationCandidate | null;
}

/** Runs the steps in order and lets the repo's mode have the last word. */
export async function decideVerification(input: VerificationInput, steps: readonly VerificationStep[] = VERIFICATION_STEPS): Promise<VerificationDecision> {
  const state: VerificationState = { ...input };
  let reason: FallbackReason | undefined;
  for (const step of steps) {
    reason = await step.decide(state);
    if (reason) break;
  }
  return {
    result: resultFor(input.mode, reason),
    reason: reason ?? null,
    suite: state.suite?.name ?? input.requestedSuite,
    attestation: state.attestation ?? null,
  };
}

/**
 * The mode step, last in the order: enforce skips or falls back; shadow mode never skips and says
 * what would have happened. (T-822 decides how an audit reads in each mode.)
 */
export function resultFor(mode: RepoMode, reason: FallbackReason | undefined): VerificationResult {
  if (mode === "enforce") return reason ? "fallback" : "skip";
  return reason ? "would_fall_back" : "would_skip";
}
