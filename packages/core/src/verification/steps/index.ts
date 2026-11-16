import type { VerificationOrder } from "../context.ts";
import { ageStep } from "./age.ts";
import { auditStep } from "./audit.ts";
import { commandStep } from "./command.ts";
import { eventStep } from "./event.ts";
import { guardedFilesStep } from "./guarded-files.ts";
import { revocationStep } from "./revocation.ts";
import { suiteStep } from "./suite.ts";
import { writeAccessStep } from "./write-access.ts";

/**
 * The decision order, after the service has found the repo installed (`repo_not_installed`
 * otherwise) and before the repo's mode turns the answer into a result (`resultFor`). Between
 * `tree` and `attestation` the attestations naming the tree are looked up (`no_attestation` when
 * there are none). One file per step.
 */
export const VERIFICATION_STEPS: VerificationOrder = {
  tree: [
    eventStep,
    suiteStep,
    guardedFilesStep,
  ],
  attestation: [
    commandStep,
    ageStep,
    // Revocations, blocks and token expiry (`attestation_revoked`), beside the age.
    revocationStep,
    writeAccessStep,
  ],
  matched: [
    auditStep,
  ],
};
