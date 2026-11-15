import type { TestsRan } from "./pr-line.ts";
import { command, type RunnerEnv } from "./runner.ts";
import { callService } from "./service.ts";
import { jobReportResponse, type JobReportRequest } from "./shared.ts";
import { ciEnvironment } from "./verify.ts";

// The job report: one call after the tests, with a fresh OIDC token and the same budget as the
// verification, sending the outcome, the test command's wall-clock duration and the runner's
// environment against the verification id. A report that doesn't arrive only warns: the
// verification then shows "outcome unknown", and the step still exits with the tests' exit code.

export async function sendJobReport(env: RunnerEnv, verificationId: string, tests: TestsRan): Promise<boolean> {
  const body: JobReportRequest = { outcome: tests.outcome, durationMs: Math.round(tests.durationMs), environment: ciEnvironment(env) };
  const answer = await callService(env, "POST", `/verifications/${encodeURIComponent(verificationId)}/report`, body);
  if (answer.kind === "answer" && answer.status === 201 && jobReportResponse.safeParse(answer.body).success) return true;
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
  return false;
}
