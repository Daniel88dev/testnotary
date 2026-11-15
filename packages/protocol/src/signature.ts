import { z } from "zod";
import { isoInstant } from "./attestation.ts";

// An attestation's signature fields (signature mode). The library uploads them beside the
// canonical payload; the service checks them, adds whether GitHub listed the key at upload, stores
// them with the attestation and serves them back with it. The signature covers the payload's exact
// bytes, so the service never needs, and never receives, a private key.

/** Who signed: a person's GitHub account id (laptop token), or the sandbox token's id. */
export const signer = z.union([
  z.object({ account: z.number().int().positive() }).strict(),
  z.object({ sandboxToken: z.string().min(1).max(100) }).strict(),
]);

/** What the library uploads with a signed attestation. */
export const attestationSignatureUpload = z
  .object({
    /** The armored `-----BEGIN SSH SIGNATURE-----` block `ssh-keygen -Y sign` wrote. */
    sshsig: z.string().min(1).max(20_000),
    /** `attestation@testnotary.dev`. */
    namespace: z.string().min(1).max(200),
    /** The signing key's public half, `type base64`. */
    publicKey: z.string().min(1).max(5_000),
    /** `SHA256:…`, as `ssh-keygen -l` prints it. */
    fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/),
    /** Where the key is trusted from: the account's GitHub signing keys, or `.testnotary/allowed_signers` on the base branch. */
    keySource: z.enum(["github", "allowed_signers"]),
    signer,
  })
  .strict();
export type AttestationSignatureUpload = z.infer<typeof attestationSignatureUpload>;

/** The signature fields as the service stores and serves them. */
export const attestationSignature = attestationSignatureUpload.extend({
  /**
   * Whether GitHub listed the key among the account's signing keys when the run was uploaded; null
   * when the service did not ask (an `allowed_signers` key) or GitHub could not be asked. History
   * only: it never decides a skip.
   */
  githubListed: z.boolean().nullable(),
  /** When the service asked GitHub; null when it did not. */
  githubCheckedAt: isoInstant.nullable(),
});
export type AttestationSignature = z.infer<typeof attestationSignature>;

/**
 * `GET /api/v1/tokens/sandbox` with a laptop token: the live sandbox tokens the account created,
 * newest first. `testnotary sandbox-key <token-name>` finds its token here; the values are never
 * shown again.
 */
export const sandboxTokensResponse = z.object({
  tokens: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      repository: z.object({ id: z.number(), fullName: z.string() }),
      expiresAt: z.string(),
    }),
  ),
});
export type SandboxTokensResponse = z.infer<typeof sandboxTokensResponse>;
