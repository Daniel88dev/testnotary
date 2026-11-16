import type { TestsRan } from "./pr-line.ts";
import { command, type RunnerEnv } from "./runner.ts";
import { callService } from "./service.ts";
import { jobReportResponse, type JobReportRequest } from "./shared.ts";
import { ciEnvironment, type Verdict } from "./verify.ts";

// The job report: one call after the tests, with a fresh OIDC token and the same budget as the
// verification, sending the outcome, the test command's wall-clock duration, the runner's
// environment and what the job did in the end (its result, reason and detail, which differ from
// the service's answer when the action fell back on its own) against the verification id. A report that doesn't arrive only warns: the
// verification then shows "outcome unknown", and the step still exits with the tests' exit code.

/**
 * Sends the report. Answers whether it arrived and whether the service recorded a mismatch from it
 * (a failing report on an audit or a *would skip*, which sends the repo back to shadow mode).
 */
export async function sendJobReport(env: RunnerEnv, verdict: Verdict & { record: { id: string } }, tests: Omit<TestsRan, "mismatch">): Promise<{ sent: boolean; mismatch: boolean }> {
  const verificationId = verdict.record.id;
  const body: JobReportRequest = {
    outcome: tests.outcome,
    durationMs: Math.round(tests.durationMs),
    environment: ciEnvironment(env),
    result: verdict.result,
    reason: verdict.reason,
    detail: verdict.detail,
  };
  const answer = await callService(env, "POST", `/verifications/${encodeURIComponent(verificationId)}/report`, body);
  if (answer.kind === "answer" && answer.status === 201) {
    const parsed = jobReportResponse.safeParse(answer.body);
    if (parsed.success) return { sent: true, mismatch: parsed.data.mismatch !== null };
  }
  const why =
    answer.kind === "answer"
      ? `the service answered ${answer.status}`
      : answer.kind === "no_token"
        ? "the job has no OIDC token"
        : answer.kind === "timeout"
          ? "the service did not answer in time"
          : answer.kind === "not_json"
            ? `the service answered ${answer.status}`
            : "the service could not be reached";
  command("warning", `Testnotary: the job report did not reach the service (${why}); the verification shows "outcome unknown".`);
  return { sent: false, mismatch: false };
}
