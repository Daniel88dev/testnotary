import type { VerificationOrder } from "../context.ts";
import { ageStep } from "./age.ts";
import { auditStep } from "./audit.ts";
import { commandStep } from "./command.ts";
import { guardedFilesStep } from "./guarded-files.ts";
import { suiteStep } from "./suite.ts";
import { writeAccessStep } from "./write-access.ts";

/**
 * The decision order, after the service has found the repo installed (`repo_not_installed`
 * otherwise) and before the repo's mode turns the answer into a result (`resultFor`). Between
 * `tree` and `attestation` the attestations naming the tree are looked up (`no_attestation` when
 * there are none). One file per step; later tickets add theirs at the anchors below and leave the
 * others alone.
 */
export const VERIFICATION_STEPS: VerificationOrder = {
  tree: [
    suiteStep,
    guardedFilesStep,
  ],
  attestation: [
    commandStep,
    ageStep,
    // Revocations, blocks and token expiry (`attestation_revoked`) go here, beside the age.
    writeAccessStep,
  ],
  matched: [
    auditStep,
  ],
};
