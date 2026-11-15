// What a verification can answer. Reason codes are stable snake_case: adding one is a minor
// version, renaming or removing one a major version. Every fallback runs the tests, and only an
// audit can fail a build.

export const FALLBACK_REASONS = [
  // before the service (the action decides these without asking)
  "disabled",
  "host_not_supported",
  "no_oidc_token",
  // service availability (the action decides these too)
  "service_unreachable",
  "service_error",
  "timeout",
  // identity and GitHub
  "repo_not_installed",
  "token_rejected",
  "github_denied",
  // attestation
  "unknown_suite",
  "no_attestation",
  "attestation_expired",
  "attestation_revoked",
  "attester_no_write",
  // policy
  "command_changed",
  "guarded_file_changed",
  // signature mode
  "signature_missing",
  "signature_invalid",
  "github_unavailable",
  // the audit draw: the tests run although an attestation covers the tree
  "audit",
] as const;

export type FallbackReason = (typeof FALLBACK_REASONS)[number];

/**
 * The action's `result` output. Shadow mode never skips, so there a verification reads
 * `would_skip` or `would_fall_back`, never `skip` or `fallback`.
 */
export const VERIFICATION_RESULTS = ["skip", "audit", "fallback", "would_skip", "would_fall_back"] as const;

export type VerificationResult = (typeof VERIFICATION_RESULTS)[number];
