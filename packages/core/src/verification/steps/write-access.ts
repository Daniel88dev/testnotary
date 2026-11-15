import type { VerificationStep } from "../context.ts";

/**
 * The attester (for a sandbox token, the account that created it) must have `admin` or `write` on
 * the repo now, asked live. `read` never counts: anyone has it on a public repo.
 */
export const writeAccessStep: VerificationStep = {
  name: "write access",
  async decide(state) {
    return (await state.sources.hasWriteAccess(state.attestation!.accountId)) ? undefined : "attester_no_write";
  },
};
