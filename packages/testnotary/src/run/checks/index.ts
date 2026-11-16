// The refusal checks, in the order they run. Each is one file in this directory exporting a
// `RunCheck`; add a check with one import and one entry. `run` and `check` both use these lists,
// so a check added here is in both.
//
// The repo, remote, base config and suite (`not_a_git_repo`, `no_remote`, `no_config_on_base`,
// `config_invalid`) are found before these run, in `../locate.ts`; the service's clear no's
// (`token_rejected`, `repo_not_installed`, `no_write_access`) come from the preflight, whose answer
// counts after them;
// `command_not_found` comes from starting the command.
//
// `WARNINGS` are checks that only ever warn: they run once every refusal check passed.
import type { RunCheck } from "../context.ts";
import { dirtyTree } from "./dirty-tree.ts";
import { laptopTokenInSandbox } from "./laptop-token-in-sandbox.ts";
import { extraArguments } from "./extra-arguments.ts";
import { historyDependentCommand } from "./history-dependent-command.ts";
import { submodules } from "./submodules.ts";
import { treeChangedDuringRun } from "./tree-changed-during-run.ts";
import { baseFetchSkipped } from "./base-fetch-skipped.ts";
import { branchBehindBase } from "./branch-behind-base.ts";
import { localConfigDiffers } from "./local-config-differs.ts";
import { ignoredEnvFile } from "./ignored-env-file.ts";
import { platformUnsupported } from "./platform-unsupported.ts";
import { platformNotAllowed } from "./platform-not-allowed.ts";
import { packageManagerUnsupported } from "./package-manager-unsupported.ts";
import { runtimeMismatch } from "./runtime-mismatch.ts";
import { packageManagerMismatch } from "./package-manager-mismatch.ts";
import { installStale } from "./install-stale.ts";
import { runtimeSourcesDisagree } from "./runtime-sources-disagree.ts";

/** Before the preflight and the command, in this order. */
export const BEFORE_START: readonly RunCheck[] = [
  // 1. The token.
  laptopTokenInSandbox,

  // 2. The command line and the command.
  extraArguments,
  historyDependentCommand,

  // 3. The tree: submodules after the dirty tree.
  dirtyTree,
  submodules,

  // 4. The platform and the environment floor. They read files and PATH only, never running a package manager; the runtime and package
  //    manager checks fill `notes.notPinned` and `notes.packageManager` for the record.
  platformUnsupported,
  platformNotAllowed,
  packageManagerUnsupported,
  runtimeMismatch,
  packageManagerMismatch,
  installStale,
];

/**
 * Warnings, never refusals, after every check in `BEFORE_START` passed and before the preflight's
 * answer counts.
 * Each returns nothing and raises its warning with `warn()`.
 */
export const WARNINGS: readonly RunCheck[] = [
  // The base and its config.
  baseFetchSkipped,
  branchBehindBase,
  localConfigDiffers,

  // The environment.
  ignoredEnvFile,
  runtimeSourcesDisagree,
];

/**
 * After the command exited, before the upload. A refusal here
 * ends the run *refused* although the command ran. `context.checkout` and `context.statusBefore`
 * hold `HEAD` and `git status` as they were before the start (filled in `../locate.ts`).
 */
export const AFTER_RUN: readonly RunCheck[] = [
  treeChangedDuringRun,
];
