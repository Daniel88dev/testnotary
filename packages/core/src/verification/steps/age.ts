import type { VerificationStep } from "../context.ts";

/** An attestation lets CI skip for this long after its run ended. */
export const ATTESTATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** The attestation must be under 24 h old, counted from the end of its run, by the service clock. */
export const ageStep: VerificationStep = {
  name: "age",
  async decide(state) {
    const age = state.now.getTime() - state.attestation!.endedAt.getTime();
    return age < ATTESTATION_MAX_AGE_MS ? undefined : "attestation_expired";
  },
};
