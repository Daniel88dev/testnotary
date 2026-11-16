// The verification decision: whether CI may skip a suite's tests on the tree it builds. The service
// supplies what the steps read (VerificationSources); the steps and their order live here.
import type { RepoMode } from "../index.ts";
import type { AttestationCandidate, Fallback, VerificationInput, VerificationOrder, VerificationState, VerificationStep } from "./context.ts";
import type { FallbackReason, VerificationResult } from "./reasons.ts";
import { VERIFICATION_STEPS } from "./steps/index.ts";

export type {
  AttestationCandidate,
  ChangedPaths,
  Fallback,
  TokenVoid,
  VerificationInput,
  VerificationOrder,
  VerificationSources,
  VerificationState,
  VerificationStep,
} from "./context.ts";
export { FALLBACK_REASONS, VERIFICATION_RESULTS, type FallbackReason, type VerificationResult } from "./reasons.ts";
export { ATTESTATION_MAX_AGE_MS } from "./steps/age.ts";
export { COMPARE_FILE_LIMIT } from "./steps/guarded-files.ts";
export { VERIFIED_EVENTS } from "./steps/event.ts";
export { VERIFICATION_STEPS } from "./steps/index.ts";

export interface VerificationDecision {
  result: VerificationResult;
  /** Why the tests run (or would run in shadow mode); null for a skip. */
  reason: FallbackReason | null;
  /** What the reason's line names besides the code, such as the guarded file changed; null when nothing. */
  detail: string | null;
  /** The suite's name in the base config, or the name the job asked for when there is none. */
  suite: string | null;
  /** The attestation that cleared the attestation steps; when none did, the newest one naming the tree. */
  attestation: AttestationCandidate | null;
}

/** A step's answer, the detail filled in (null when the step gave none). */
interface Stop {
  reason: FallbackReason;
  detail: string | null;
}

/** Runs the decision order and lets the repo's mode have the last word. */
export async function decideVerification(input: VerificationInput, order: VerificationOrder = VERIFICATION_STEPS): Promise<VerificationDecision> {
  const state: VerificationState = { ...input };
  const stop = await decide(state, order);
  return {
    result: resultFor(input.mode, stop?.reason),
    reason: stop?.reason ?? null,
    detail: stop?.detail ?? null,
    suite: state.suite?.name ?? input.requestedSuite,
    attestation: state.attestation ?? null,
  };
}

async function decide(state: VerificationState, order: VerificationOrder): Promise<Stop | undefined> {
  const treeStop = await firstStop(state, order.tree);
  if (treeStop) return treeStop;
  // Some attestation for the repo and suite must name the tree. Only the tree counts: the commit it
  // was made on may differ (a pull request's merge commit, a squash).
  const candidates = await state.sources.attestations(state.suite!.name);
  if (candidates.length === 0) return { reason: "no_attestation", detail: null };
  let newest: { attestation: AttestationCandidate; stop: Stop } | undefined;
  for (const attestation of candidates) {
    state.attestation = attestation;
    const stop = await firstStop(state, order.attestation);
    if (!stop) return firstStop(state, order.matched);
    newest ??= { attestation, stop };
  }
  state.attestation = newest!.attestation;
  return newest!.stop;
}

async function firstStop(state: VerificationState, steps: readonly VerificationStep[]): Promise<Stop | undefined> {
  for (const step of steps) {
    const answer: FallbackReason | Fallback | undefined = await step.decide(state);
    if (typeof answer === "string") return { reason: answer, detail: null };
    if (answer) return answer;
  }
  return undefined;
}

/**
 * The mode step, last in the order: enforce skips, audits or falls back; shadow mode never skips
 * and says what would have happened. The audit draw is made in enforce mode only, so shadow mode
 * never reads `audit`.
 */
export function resultFor(mode: RepoMode, reason: FallbackReason | undefined): VerificationResult {
  if (mode === "enforce") return reason === "audit" ? "audit" : reason ? "fallback" : "skip";
  return reason ? "would_fall_back" : "would_skip";
}
