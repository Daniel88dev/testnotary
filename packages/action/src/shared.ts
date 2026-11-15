// Everything the action takes from the private workspace packages comes through here. Both are
// bundled into the action's release build.
export {
  CONFIG_FILE,
  FALLBACK_REASONS,
  parseConfig,
  suiteNames,
  tokenKind,
  type FallbackReason,
  type TokenKind,
  type VerificationResult,
} from "@testnotary/core";
export {
  API_V1,
  OIDC_AUDIENCE,
  accountName,
  jobReportResponse,
  resolveServiceUrl,
  runPageUrl,
  verifyResponse,
  type CiEnvironment,
  type JobOutcome,
  type JobReportRequest,
  type Verification,
} from "@testnotary/protocol";
