import type { VerificationStep } from "../context.ts";

/**
 * Some attestation for the repo and suite must name the tree CI builds. Only the tree counts: the
 * commit it was made on may differ (a pull request's merge commit, a squash). The newest one is
 * matched, and the steps after this one judge that one alone.
 */
export const attestationStep: VerificationStep = {
  name: "attestation",
  async decide(state) {
    const attestation = await state.sources.newestAttestation(state.suite!.name);
    if (!attestation) return "no_attestation";
    state.attestation = attestation;
    return undefined;
  },
};
