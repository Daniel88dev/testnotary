// The retention job: one pass, then exit. The schedule runs it nightly from the service image
// (`node apps/web/dist/scripts/retention.mjs`, built from this file) with RETENTION_DATABASE_URL,
// the retention role, which ECS injects; the service never holds that URL. It decides by real time.
// What it deletes is in src/server/retention.ts. Prints one JSON line with the counts.
import postgres from "postgres";
import { retentionDatabase, runRetention } from "../src/server/retention.ts";

const url = process.env.RETENTION_DATABASE_URL;
if (!url) {
  process.stderr.write("RETENTION_DATABASE_URL is not set (the retention role's connection string)\n");
  process.exit(2);
}

const sql = postgres(url, { max: 1, connect_timeout: 10, onnotice: () => {} });
try {
  const at = new Date();
  const deleted = await runRetention(retentionDatabase(sql), at);
  process.stdout.write(`${JSON.stringify({ retention: "done", at: at.toISOString(), deleted })}\n`);
} catch (error) {
  // Drizzle wraps the database's error; its cause says what Postgres refused.
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  process.stderr.write(`retention failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
