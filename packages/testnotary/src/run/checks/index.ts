// The refusal checks, in the order they run. Each is one file in this directory exporting a
// `RunCheck`; add a check with one import and one entry, under its own ticket's anchor comment
// below (the anchors are spaced so tickets merged side by side don't touch the same lines).
// `run` and `check` both use these lists, so a check added here is in both.
//
// The repo, remote, base config and suite (`not_a_git_repo`, `no_remote`, `no_config_on_base`,
// `config_invalid`) are found before these run, in `../locate.ts`; the service's clear no's
// (`token_rejected`, `repo_not_installed`, `no_write_access`) come from the preflight after them;
// `command_not_found` comes from starting the command.
import type { RunCheck } from "../context.ts";
import { dirtyTree } from "./dirty-tree.ts";

// Imports for the token checks (T-823).
import { laptopTokenInSandbox } from "./laptop-token-in-sandbox.ts";

// Imports for the command and tree checks (T-816).
import { extraArguments } from "./extra-arguments.ts";
import { historyDependentCommand } from "./history-dependent-command.ts";

// Imports for the platform and environment floor checks (T-815).

/** Before the preflight and the command, in this order. */
export const BEFORE_START: readonly RunCheck[] = [
  // 1. The token (T-823: `laptop_token_in_sandbox`).
  laptopTokenInSandbox,

  // 2. The command line and the command (T-816: `extra_arguments`, `history_dependent_command`).
  extraArguments,
  historyDependentCommand,

  // 3. The tree. (T-816: submodules, after `dirtyTree`.)
  dirtyTree,

  // 4. The platform and the environment floor (T-815: `platform_unsupported`, `platform_not_allowed`,
  //    `package_manager_unsupported`, `runtime_mismatch`, `package_manager_mismatch`, `install_stale`).

];

/**
 * After the command exited, before the upload (T-816: `tree_changed_during_run`). A refusal here
 * ends the run *refused* although the command ran. `context.checkout` still holds `HEAD` as it was
 * before the start; a check that needs more of the before-state (such as `git status`) adds a
 * field to `RunContext` and fills it in `../locate.ts`.
 */
export const AFTER_RUN: readonly RunCheck[] = [
  // T-816: `tree_changed_during_run`.

];
