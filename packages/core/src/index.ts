// Core rules: tree match, guarded-file globbing, audit draw, token checks, config parsing and the
// verification decision live here as later tickets add them. The library, the action and the web
// app import this package; nothing in it does I/O.

export {
  CONFIG_FILE,
  CONFIG_SCHEMA_URL,
  configJsonSchema,
  parseConfig,
  suiteFromConfig,
  suiteNames,
  type ConfigResult,
  type EnvRules,
  type Suite,
  type TestnotaryConfig,
} from "./config.ts";
export { REFUSAL_CODES, type Outcome, type RefusalCode } from "./outcome.ts";
export {
  ATTESTATION_MAX_AGE_MS,
  FALLBACK_REASONS,
  VERIFICATION_RESULTS,
  VERIFICATION_STEPS,
  decideVerification,
  resultFor,
  type AttestationCandidate,
  type FallbackReason,
  type VerificationDecision,
  type VerificationInput,
  type VerificationOrder,
  type VerificationResult,
  type VerificationSources,
  type VerificationState,
  type VerificationStep,
} from "./verification/index.ts";
export {
  BASELINE_FIXED,
  BASELINE_NAMES,
  BASELINE_OVERRIDABLE,
  PASSED_THROUGH,
  baselineOverrides,
  strippedEnvironment,
  type StrippedEnvironmentOptions,
} from "./stripped-environment.ts";

export type TokenKind = "laptop" | "sandbox";

/** Which kind of token a value is, judged by its prefix alone (`tnl_` or `tns_`). */
export function tokenKind(value: string): TokenKind | undefined {
  if (value.startsWith("tnl_")) return "laptop";
  if (value.startsWith("tns_")) return "sandbox";
  return undefined;
}

/** Shadow mode reports what would have skipped while CI runs every test job; enforce skips. */
export type RepoMode = "shadow" | "enforce";

/** A repo's settings in effect. Audit rates are "1 in N": a lower N audits more often. */
export interface RepoSettings {
  mode: RepoMode;
  auditOneIn: number;
  sandboxAuditOneIn: number;
}

/**
 * What every repo starts with when the App is given it, and again when it comes back after being
 * removed: shadow mode, 1 in 10 audits, and 1 in 5 for sandbox tokens. Rates never go below these.
 */
export const INITIAL_REPO_SETTINGS: RepoSettings = { mode: "shadow", auditOneIn: 10, sandboxAuditOneIn: 5 };

export { SANDBOX_MARKERS, type SandboxMarker } from "./sandbox.ts";
export {
  ACTION_REF,
  KILL_SWITCH_VARIABLE,
  PACKAGE_MANAGERS,
  WORKFLOW_PERMISSIONS,
  agentsBlock,
  setupSteps,
  workflowHeader,
  workflowSnippet,
  type PackageManager,
  type PackageManagerName,
  type WorkflowSnippetOptions,
} from "./workflow.ts";

/** A laptop token lasts this long from its last use. */
export const LAPTOP_TOKEN_LIFETIME_DAYS = 90;

/** A sandbox token's fixed lifetime, chosen at creation: 90 days unless its creator picks another, never over a year. It is never renewed. */
export const SANDBOX_TOKEN_DEFAULT_DAYS = 90;
export const SANDBOX_TOKEN_MAX_DAYS = 365;
