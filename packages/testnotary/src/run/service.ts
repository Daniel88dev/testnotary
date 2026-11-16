// A run's two calls to the service: the preflight before the command starts, and the one upload
// after it. Neither ever stops the tests from running unless the service says a clear no.
import { callService, ServiceUnreachable } from "../service.ts";
import { preflightResponse, runUploadResponse, SERVICE_REFUSALS, type PreflightResponse, type RunUpload, type ServiceRefusal } from "../shared.ts";
import type { RunToken } from "./context.ts";

const PREFLIGHT_TIMEOUT_MS = 3_000;
const UPLOAD_TIMEOUT_MS = 10_000;
/** A refused run's upload is a courtesy: it never holds the refusal up for long. */
const REFUSED_UPLOAD_TIMEOUT_MS = 3_000;

export type Preflight =
  /** The service will take this run's upload. */
  | { kind: "ok"; answer: PreflightResponse }
  /** A clear no: refuse before the start. */
  | { kind: "refused"; refusal: ServiceRefusal }
  /** No token was sent and the service wants one: the tests run, nothing is attested. */
  | { kind: "not_signed_in" }
  /**
   * No answer in time, or not one the library understands: the tests run, nothing is attested.
   * `answered`: the service did answer (an error), as against no answer at all.
   */
  | { kind: "unreachable"; reason: string; answered: boolean };

function serviceRefusal(status: number, raw: unknown): ServiceRefusal | undefined {
  const error = raw && typeof raw === "object" ? (raw as { error?: unknown }).error : undefined;
  const code = (Object.keys(SERVICE_REFUSALS) as ServiceRefusal[]).find((name) => name === error);
  return code && SERVICE_REFUSALS[code] === status ? code : undefined;
}

/**
 * Asks the service whether it will take this run, with a timeout of about 3 s. Without a token no
 * `Authorization` header is sent, so a vendor's proxy can attach one.
 */
export async function preflight(serviceUrl: string, token: RunToken | undefined, repository: string): Promise<Preflight> {
  try {
    const answer = await callService(serviceUrl, "/preflight", preflightResponse, {
      method: "POST",
      token: token?.value,
      body: { repository },
      timeoutMs: PREFLIGHT_TIMEOUT_MS,
    });
    if (answer.body) return { kind: "ok", answer: answer.body };
    const refusal = serviceRefusal(answer.status, answer.raw);
    if (refusal === "token_rejected" && !token) return { kind: "not_signed_in" };
    if (refusal) return { kind: "refused", refusal };
    return { kind: "unreachable", reason: `the service answered ${answer.status}${describe(answer.raw)}`, answered: true };
  } catch (error) {
    if (error instanceof ServiceUnreachable) return { kind: "unreachable", reason: error.message, answered: false };
    throw error;
  }
}

export type UploadResult = { kind: "stored"; runId: string; attestationId: string | null } | { kind: "failed"; reason: string };

/** The one upload after a run. A refused run's is cut short sooner; its result is only reported. */
export async function upload(serviceUrl: string, token: RunToken | undefined, record: RunUpload): Promise<UploadResult> {
  try {
    const answer = await callService(serviceUrl, "/runs", runUploadResponse, {
      method: "POST",
      token: token?.value,
      body: record,
      okStatus: 201,
      timeoutMs: record.outcome === "refused" ? REFUSED_UPLOAD_TIMEOUT_MS : UPLOAD_TIMEOUT_MS,
    });
    if (answer.body) return { kind: "stored", runId: answer.body.run.id, attestationId: answer.body.attestation?.id ?? null };
    return { kind: "failed", reason: `the service answered ${answer.status}${describe(answer.raw)}` };
  } catch (error) {
    if (error instanceof ServiceUnreachable) return { kind: "failed", reason: error.message };
    throw error;
  }
}

function describe(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "";
  const { error, message } = raw as { error?: unknown; message?: unknown };
  return typeof error === "string" ? ` (${error}${typeof message === "string" ? `: ${message}` : ""})` : "";
}
