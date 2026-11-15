import { serve, type HttpServer } from "./http.ts";

/**
 * A compromised Testnotary service, for signature mode's tests: it passes every request through to
 * the real one, then rewrites each verification it answers (`POST /api/v1/verifications`,
 * `GET /api/v1/verifications/<id>`) with `forge`, e.g. turning a fallback into a skip or swapping
 * the attestation's bytes. Point the action at it with `env: { TESTNOTARY_URL: url }`.
 */
export async function startCompromisedService<V extends Record<string, unknown>>(target: string, forge: (verification: V) => V): Promise<HttpServer> {
  return serve(async (request) => {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    for (const name of ["host", "content-length", "connection"]) headers.delete(name);
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
    const answer = await fetch(`${target}${url.pathname}${url.search}`, { method: request.method, headers, body });
    const text = await answer.text();
    const contentType = answer.headers.get("content-type") ?? "application/json";
    if (answer.status !== 200 || !/^\/api\/v1\/verifications(?:\/[^/]+)?$/.test(url.pathname)) {
      return new Response(text, { status: answer.status, headers: { "content-type": contentType } });
    }
    const { verification } = JSON.parse(text) as { verification: V };
    return Response.json({ verification: forge(verification) });
  });
}
