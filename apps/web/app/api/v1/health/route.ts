import { sql } from "drizzle-orm";
import type { HealthResponse } from "@testnotary/protocol";
import { database } from "../../../../src/db/client.ts";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  let reachable = true;
  try {
    await database().execute(sql`select 1`);
  } catch {
    reachable = false;
  }
  const body: HealthResponse = reachable
    ? { status: "ok", database: "ok" }
    : { status: "unavailable", database: "unavailable" };
  return Response.json(body, { status: reachable ? 200 : 503, headers: { "cache-control": "no-store" } });
}
