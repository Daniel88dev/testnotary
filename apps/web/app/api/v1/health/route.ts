import { sql } from "drizzle-orm";
import type { HealthResponse } from "@testnotary/protocol";
import { database } from "../../../../src/db/client.ts";
import { reportError } from "../../../../src/server/errors.ts";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  let reachable = true;
  try {
    await database().execute(sql`select 1`);
  } catch (error) {
    reachable = false;
    // Without its database the service cannot verify anything, so every CI job runs its tests.
    // Sentry's deduplication keeps a long outage, polled by the health check, to a few events.
    reportError(error, { check: "database" });
  }
  const body: HealthResponse = reachable
    ? { status: "ok", database: "ok" }
    : { status: "unavailable", database: "unavailable" };
  return Response.json(body, { status: reachable ? 200 : 503, headers: { "cache-control": "no-store" } });
}
