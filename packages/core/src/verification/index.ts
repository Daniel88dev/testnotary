// The verification decision: whether CI may skip a suite's tests on the tree it builds. The service
// supplies what the steps read (VerificationSources); the steps and their order live here.
import type { RepoMode } from "../index.ts";
import type { AttestationCandidate, VerificationInput, VerificationOrder, VerificationState, VerificationStep } from "./context.ts";
import type { FallbackReason, VerificationResult } from "./reasons.ts";
import { VERIFICATION_STEPS } from "./steps/index.ts";

export type { AttestationCandidate, VerificationInput, VerificationOrder, VerificationSources, VerificationState, VerificationStep } from "./context.ts";
export { FALLBACK_REASONS, VERIFICATION_RESULTS, type FallbackReason, type VerificationResult } from "./reasons.ts";
export { ATTESTATION_MAX_AGE_MS } from "./steps/age.ts";
export { VERIFICATION_STEPS } from "./steps/index.ts";

export interface VerificationDecision {
  result: VerificationResult;
  /** Why the tests run (or would run in shadow mode); null for a skip. */
  reason: FallbackReason | null;
  /** The suite's name in the base config, or the name the job asked for when there is none. */
  suite: string | null;
  /** The attestation that cleared the attestation steps; when none did, the newest one naming the tree. */
  attestation: AttestationCandidate | null;
}

/** Runs the decision order and lets the repo's mode have the last word. */
export async function decideVerification(input: VerificationInput, order: VerificationOrder = VERIFICATION_STEPS): Promise<VerificationDecision> {
  const state: VerificationState = { ...input };
  const reason = await decide(state, order);
  return {
    result: resultFor(input.mode, reason),
    reason: reason ?? null,
    suite: state.suite?.name ?? input.requestedSuite,
    attestation: state.attestation ?? null,
  };
}

async function decide(state: VerificationState, order: VerificationOrder): Promise<FallbackReason | undefined> {
  const treeReason = await firstReason(state, order.tree);
  if (treeReason) return treeReason;
  // Some attestation for the repo and suite must name the tree. Only the tree counts: the commit it
  // was made on may differ (a pull request's merge commit, a squash).
  const candidates = await state.sources.attestations(state.suite!.name);
  if (candidates.length === 0) return "no_attestation";
  let newest: { attestation: AttestationCandidate; reason: FallbackReason } | undefined;
  for (const attestation of candidates) {
    state.attestation = attestation;
    const reason = await firstReason(state, order.attestation);
    if (!reason) return firstReason(state, order.matched);
    newest ??= { attestation, reason };
  }
  state.attestation = newest!.attestation;
  return newest!.reason;
}

async function firstReason(state: VerificationState, steps: readonly VerificationStep[]): Promise<FallbackReason | undefined> {
  for (const step of steps) {
    const reason = await step.decide(state);
    if (reason) return reason;
  }
  return undefined;
}

/**
 * The mode step, last in the order: enforce skips or falls back; shadow mode never skips and says
 * what would have happened. (T-822 decides how an audit reads in each mode.)
 */
export function resultFor(mode: RepoMode, reason: FallbackReason | undefined): VerificationResult {
  if (mode === "enforce") return reason ? "fallback" : "skip";
  return reason ? "would_fall_back" : "would_skip";
}
