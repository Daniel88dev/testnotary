import type { z } from "zod";
import { API_V1 } from "./shared.ts";

// The library's calls to the Testnotary service.

const TIMEOUT_MS = 10_000;

export class ServiceUnreachable extends Error {}

export interface ServiceAnswer<T> {
  status: number;
  /** The body checked against the expected schema; undefined for any other status. */
  body: T | undefined;
  /** The raw body, for error answers. */
  raw: unknown;
}

export async function callService<T extends z.ZodType>(
  serviceUrl: string,
  path: string,
  schema: T,
  options: { method?: string; token?: string; body?: unknown; okStatus?: number; timeoutMs?: number } = {},
): Promise<ServiceAnswer<z.infer<T>>> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  let response: Response;
  try {
    response = await fetch(`${serviceUrl}${API_V1}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
    });
  } catch (error) {
    throw new ServiceUnreachable(error instanceof Error ? error.message : String(error));
  }
  let raw: unknown;
  try {
    raw = await response.json();
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") throw new ServiceUnreachable(error.message);
    raw = undefined;
  }
  if (response.status !== (options.okStatus ?? 200)) return { status: response.status, body: undefined, raw };
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ServiceUnreachable(`unexpected answer from ${path}: ${parsed.error.message}`);
  return { status: response.status, body: parsed.data, raw };
}
