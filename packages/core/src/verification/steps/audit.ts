import { auditDrawn, auditOneIn } from "../../audit.ts";
import type { VerificationStep } from "../context.ts";

/**
 * The audit draw, last: CI runs the tests anyway on a random share of the trees it would skip, at
 * the repo's rate for the matched attestation's token (1 in 10, 1 in 5 for a sandbox token, or
 * more often when the repo raised them). Only in enforce mode: shadow mode runs every test job
 * already, and each *would skip* is compared with CI's outcome.
 */
export const auditStep: VerificationStep = {
  name: "audit",
  async decide(state) {
    if (state.mode !== "enforce") return undefined;
    const oneIn = auditOneIn(state.rates, state.attestation!.tokenKind);
    const drawn = await auditDrawn(await state.sources.auditKey(), { tree: state.tree, suite: state.suite!.name }, oneIn);
    return drawn ? "audit" : undefined;
  },
};
