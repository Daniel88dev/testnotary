import type { FallbackReason, RefusalCode, VerificationResult } from "@testnotary/core";
import type { ExplanationCause } from "../../../src/server/settings.ts";

// The dashboard's words for the codes. The codes come from core; adding one there makes these
// tables fail to typecheck until it has its words here. Seeded from the dashboard prototype's
// `REASON` and `REFUSAL`, completed for every code.

/** A fallback reason in a few words: the Verifications filter, the "Why" column, the gates. */
export const REASON_LABELS: Record<FallbackReason, string> = {
  disabled: "Kill switch set (TESTNOTARY_DISABLED)",
  host_not_supported: "Not github.com",
  no_oidc_token: "No OIDC token (fork)",
  service_unreachable: "Service unreachable",
  service_error: "Service error",
  timeout: "Service slower than 10 s",
  repo_not_installed: "App not installed on the repo",
  token_rejected: "Job's OIDC token not accepted",
  github_denied: "GitHub refused the service",
  unknown_suite: "Suite not in testnotary.json on the base",
  no_attestation: "No attestation for this tree",
  attestation_expired: "Attestation 24 hours old or more",
  attestation_revoked: "Attesting token revoked, blocked or expired",
  attester_no_write: "Attester has no write access",
  command_changed: "Command differs from the base branch",
  guarded_file_changed: "Guarded file changed",
  signature_missing: "Signature required, none given",
  signature_invalid: "Signature check failed",
  github_unavailable: "GitHub could not be asked",
  audit: "Drawn for an audit",
};

/** Why a run was refused, in a few words. */
export const REFUSAL_LABELS: Record<RefusalCode, string> = {
  not_a_git_repo: "Not a git repo with a commit",
  no_remote: "No origin remote",
  no_config_on_base: "No testnotary.json on the base branch",
  config_invalid: "testnotary.json is invalid or lacks the suite",
  extra_arguments: "Extra arguments after --",
  history_dependent_command: "Command picks tests from git history",
  command_not_found: "Command not found",
  dirty_tree: "Uncommitted changes in the tree",
  tree_changed_during_run: "Files changed while the tests ran",
  platform_not_allowed: "Platform not allowed by testnotary.json",
  platform_unsupported: "Platform not supported",
  repo_not_installed: "App not installed on the repo",
  no_write_access: "No write access to the repo",
  token_rejected: "Token not accepted",
  interrupted: "Stopped before the tests ended",
  runtime_mismatch: "Node version differs from the pinned one",
  package_manager_mismatch: "Package manager differs from the pinned one",
  install_stale: "node_modules does not match the lockfile",
  package_manager_unsupported: "Package manager not supported",
  laptop_token_in_sandbox: "Laptop token used inside a sandbox",
};

/** A verification's result as its chip reads; shadow results in their own words. */
export const RESULT_LABELS: Record<VerificationResult, string> = {
  skip: "Skipped",
  audit: "Audited",
  fallback: "Ran",
  would_skip: "Would have skipped",
  would_fall_back: "Would have fallen back",
};

/** A mismatch explanation's cause. */
export const CAUSE_LABELS: Record<ExplanationCause, string> = {
  flaky_test: "Flaky test",
  environment_difference: "Environment difference",
  false_attestation: "False attestation",
  other: "Other",
};

export function reasonLabel(code: string): string {
  return (REASON_LABELS as Record<string, string>)[code] ?? code;
}

export function refusalLabel(code: string): string {
  return (REFUSAL_LABELS as Record<string, string>)[code] ?? code;
}
