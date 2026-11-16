import type { TokenVoid, VerificationStep } from "../context.ts";

/** What the line names besides `attestation_revoked`: what voided the attestation. */
const DETAIL: Record<TokenVoid, string> = {
  revoked: "token revoked",
  blocked: "token blocked on this repo",
  expired: "token expired",
};

/**
 * The attestation's token must still stand: not revoked (by its owner, a repo admin, the operator
 * or an account deletion), not blocked on this repo, and not expired. Any of the three voids every
 * attestation the token made, at once, however young.
 */
export const revocationStep: VerificationStep = {
  name: "revocation",
  async decide(state) {
    const voided = await state.sources.tokenVoided(state.attestation!.tokenId);
    return voided ? { reason: "attestation_revoked", detail: DETAIL[voided] } : undefined;
  },
};
