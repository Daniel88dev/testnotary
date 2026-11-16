// How a run ends. Refusal codes are stable snake_case and never renamed once shipped.

export type Outcome = "passed" | "failed" | "refused";

export const REFUSAL_CODES = [
  // repo and config
  "not_a_git_repo",
  "no_remote",
  "no_config_on_base",
  "config_invalid",
  // command
  "extra_arguments",
  "history_dependent_command",
  "command_not_found",
  // tree
  "dirty_tree",
  "tree_changed_during_run",
  // platform
  "platform_not_allowed",
  "platform_unsupported",
  // service
  "repo_not_installed",
  "no_write_access",
  "token_rejected",
  // run
  "interrupted",
  // environment
  "runtime_mismatch",
  "package_manager_mismatch",
  "install_stale",
  "package_manager_unsupported",
  // sandbox
  "laptop_token_in_sandbox",
] as const;

export type RefusalCode = (typeof REFUSAL_CODES)[number];

/**
 * What a run can warn about. A warning never refuses: the run goes on, the code is in the run's
 * `warnings[]` (and its upload), and a `testnotary:` line on stderr explains it. Stable snake_case,
 * like the refusal codes.
 */
export const WARNING_CODES = [
  // the service
  "not_signed_in",
  "service_unreachable",
  "upload_failed",
  // the base and its config
  "base_fetch_skipped",
  "branch_behind_base",
  "local_config_differs",
  // the environment
  "ignored_env_file",
  "runtime_sources_disagree",
  // signature mode
  "no_signing_key",
] as const;

export type WarningCode = (typeof WARNING_CODES)[number];
