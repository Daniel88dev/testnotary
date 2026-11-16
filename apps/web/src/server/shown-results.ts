import { sql, type SQL } from "drizzle-orm";
import type { FallbackReason, VerificationResult } from "@testnotary/core";
import { verifications } from "../db/schema.ts";

// What a job did, as the dashboard counts it. The service records its answer on the verification;
// the action may still fall back on its own afterwards (the signature check fails, or the job's
// checkout is not the verified tree), and its job report then says what it did instead. Every
// reader counts a job by its latest report's result, reason and detail when that report carries
// them, and by the service's answer otherwise (no report yet, or one from an older action).

/** One column of the verification's latest job report, as SQL on `verifications`. */
function latestReport(column: "result" | "reason" | "detail"): SQL {
  return sql`(select r.${sql.raw(column)} from job_reports r where r.verification_id = ${verifications.id} order by r.seq desc limit 1)`;
}

/** The job's result as SQL, for filters and groupings over `verifications`. */
export const shownResult: SQL<string> = sql<string>`coalesce(${latestReport("result")}, ${verifications.result})`;

/** The job's fallback reason as SQL: its report's when the report carries a result. */
export const shownReason: SQL<string | null> = sql<string | null>`case when ${latestReport("result")} is null then ${verifications.reason} else ${latestReport("reason")} end`;

/** The same rule in code, for a verification row and its latest report already read. */
export function shownOutcome(
  verification: { result: string; reason: string | null; detail: string | null },
  report: { result: string | null; reason: string | null; detail: string | null } | undefined,
): { result: VerificationResult; reason: FallbackReason | null; detail: string | null } {
  const own = report?.result ? report : verification;
  return { result: own.result as VerificationResult, reason: own.reason as FallbackReason | null, detail: own.detail };
}
