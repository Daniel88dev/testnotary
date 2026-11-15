import type { z } from "zod";
import { GitHubNotConfigured, GitHubUnavailable } from "./github.ts";

// Small helpers every API route shares. Error bodies are `{ error, message? }` (protocol `apiError`).

export function apiError(status: number, error: string, message?: string): Response {
  return Response.json(message ? { error, message } : { error }, { status, headers: { "cache-control": "no-store" } });
}

export function ok(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

/** The request's JSON body checked against a schema, or the 400 to answer with. */
export async function readBody<T extends z.ZodType>(request: Request, schema: T): Promise<{ body: z.infer<T> } | { response: Response }> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { response: apiError(400, "bad_request", "The body is not JSON.") };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { response: apiError(400, "bad_request", parsed.error.message) };
  return { body: parsed.data };
}

/** Turns GitHub being down or the service missing a GitHub setting into a 502 or 503. */
export async function withGitHubErrors(handle: () => Promise<Response>): Promise<Response> {
  try {
    return await handle();
  } catch (error) {
    if (error instanceof GitHubUnavailable) return apiError(502, "github_unavailable", error.message);
    if (error instanceof GitHubNotConfigured) return apiError(503, "not_configured");
    throw error;
  }
}
