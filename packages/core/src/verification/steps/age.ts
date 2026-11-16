import type { VerificationStep } from "../context.ts";

/** An attestation lets CI skip for this long after its run ended. */
export const ATTESTATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The attestation must be under 24 h old, counted from the end of its run, by the service clock.
 * An uploader's clock may run ahead (the service accepts an end up to its clock skew in the
 * future), so the end counts no later than when the service received the attestation.
 */
export const ageStep: VerificationStep = {
  name: "age",
  async decide(state) {
    const { endedAt, createdAt } = state.attestation!;
    const age = state.now.getTime() - Math.min(endedAt.getTime(), createdAt.getTime());
    return age < ATTESTATION_MAX_AGE_MS ? undefined : "attestation_expired";
  },
};
