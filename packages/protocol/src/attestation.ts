import { z } from "zod";

// The canonical attestation payload (open decision 4). The library builds it for a passed run and
// uploads its exact bytes; the service stores those bytes as they came and serves them back; the
// action and a signature (T-829) read the same bytes. Nobody ever rebuilds it from database
// columns, so a signature made over it stays valid as long as the row lives.
//
// Format `testnotary.attestation/v1`:
// - a JSON object with exactly the keys below, in exactly this order, nested objects included;
// - no whitespace anywhere, no trailing newline;
// - ASCII only: every character above U+007E is written as a lowercase `\uXXXX` escape (UTF-16
//   code units, so a character outside the BMP is two escapes), so the bytes are the same in any
//   encoding and through any JSON transport;
// - `endedAt` is the run's end in UTC, `YYYY-MM-DDTHH:MM:SS.mmmZ`. It doubles as the signing
//   time: the action's 24 h age counts from it, as the service's does from the end of the run.
//
// A new field or a different encoding is a new format string (`…/v2`), never a change to v1.
// `decodeAttestationPayload` accepts only text that is exactly what `encodeAttestationPayload`
// would write for the values it holds.

export const ATTESTATION_FORMAT_V1 = "testnotary.attestation/v1";
/** Every format this release can read, newest first. */
export const ATTESTATION_FORMATS = [ATTESTATION_FORMAT_V1] as const;
export type AttestationFormat = (typeof ATTESTATION_FORMATS)[number];

/** A git object id: SHA-1 (40 hex) or SHA-256 (64 hex), lowercase. */
export const objectId = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);
/** `Date.prototype.toISOString()`'s form, always UTC with milliseconds. */
export const isoInstant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

export const attestationPayloadV1 = z
  .object({
    format: z.literal(ATTESTATION_FORMAT_V1),
    /** GitHub's numeric repo id. */
    repository: z.number().int().positive(),
    suite: z.string().min(1),
    /** The suite's argv exactly as the base config declared it. */
    command: z.array(z.string()).min(1),
    /** The tree the run tested: what the attestation covers. */
    tree: objectId,
    /** The commit the run had checked out. Named, but only the tree decides. */
    commit: objectId,
    outcome: z.literal("passed"),
    /**
     * Who attests: the GitHub account (for a sandbox token, the account that created it) and the
     * token the run uploaded with.
     */
    attester: z
      .object({
        account: z.number().int().positive(),
        token: z.string().min(1),
        tokenKind: z.enum(["laptop", "sandbox"]),
      })
      .strict(),
    endedAt: isoInstant,
  })
  .strict();
export type AttestationPayloadV1 = z.infer<typeof attestationPayloadV1>;
export type AttestationPayload = AttestationPayloadV1;

/** The canonical text of a payload. Its UTF-8 (equally, ASCII) bytes are what is stored and signed. */
export function encodeAttestationPayload(payload: AttestationPayload): string {
  // Built key by key so the order is the format's, whatever order the caller's object has.
  const ordered = {
    format: payload.format,
    repository: payload.repository,
    suite: payload.suite,
    command: [...payload.command],
    tree: payload.tree,
    commit: payload.commit,
    outcome: payload.outcome,
    attester: { account: payload.attester.account, token: payload.attester.token, tokenKind: payload.attester.tokenKind },
    endedAt: payload.endedAt,
  };
  return JSON.stringify(ordered).replace(/[\u007f-￿]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/**
 * The payload in canonical text, or undefined when the text is not exactly a canonical payload of
 * a known format (other key order, whitespace, unescaped non-ASCII, unknown or missing keys).
 */
export function decodeAttestationPayload(text: string): AttestationPayload | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = attestationPayloadV1.safeParse(raw);
  if (!parsed.success) return undefined;
  return encodeAttestationPayload(parsed.data) === text ? parsed.data : undefined;
}
