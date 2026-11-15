import type { VerificationStep } from "../context.ts";
import { ageStep } from "./age.ts";
import { attestationStep } from "./attestation.ts";
import { suiteStep } from "./suite.ts";
import { writeAccessStep } from "./write-access.ts";

/**
 * The decision order, after the service has found the repo installed (`repo_not_installed`
 * otherwise) and before the repo's mode turns the answer into a result (`resultFor`). The first
 * step to answer a reason ends the verification. One file per step; later tickets add theirs at
 * the anchors below and leave the others alone.
 */
export const VERIFICATION_STEPS: readonly VerificationStep[] = [
  suiteStep,
  // T-820: guarded files (`guarded_file_changed`) go here, between the suite and the attestation.
  attestationStep,
  // T-820: `command_changed` goes here, right after the attestation is matched.
  ageStep,
  // Revocations, blocks and token expiry (`attestation_revoked`) go here, beside the age.
  writeAccessStep,
  // T-822: the audit draw (`audit`) comes last.
];
