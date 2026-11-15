// Everything the action takes from the private workspace packages comes through here. Both are
// bundled into the action's release build.
export { tokenKind, type FallbackReason, type TokenKind, type VerificationResult } from "@testnotary/core";
export { API_V1, OIDC_AUDIENCE, resolveServiceUrl, verifyResponse, type CiEnvironment } from "@testnotary/protocol";
