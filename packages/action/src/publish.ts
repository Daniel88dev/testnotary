import { readFileSync } from "node:fs";
import { escape, type JobPresentation } from "./pr-line.ts";
import { appendSummary, command, input, type RunnerEnv } from "./runner.ts";

// Where the PR line goes: always the job summary; with `checks: write`, also a never-required
// check run `Testnotary / <suite>` made with the job's GITHUB_TOKEN, the line as its title. A
// check run that can't be made never fails the step.

const CHECK_RUN_BUDGET_MS = 10_000;

/** `Testnotary / <suite>`, or `Testnotary` when the job never learned its suite. */
export function checkName(suite: string | null): string {
  return suite ? `Testnotary / ${suite}` : "Testnotary";
}

/** Writes the job summary: the line as a heading, then the details. */
export function writeSummary(env: RunnerEnv, suite: string | null, presentation: JobPresentation): void {
  appendSummary(env, `### ${escape(checkName(suite))}\n\n**${escape(presentation.line)}**\n\n${presentation.details}\n`);
}

/**
 * Makes the check run. On `pull_request` it goes on the pull request's head commit, which is what
 * GitHub shows in the PR's checks list; elsewhere on `GITHUB_SHA`.
 */
export async function createCheckRun(env: RunnerEnv, suite: string | null, presentation: JobPresentation): Promise<void> {
  const token = input(env, "github-token");
  const repository = env.GITHUB_REPOSITORY;
  const sha = headSha(env);
  if (!token || !repository || !sha) {
    process.stdout.write("Testnotary: no check run: the step has no GITHUB_TOKEN\n");
    return;
  }
  let response: Response;
  try {
    response = await fetch(`${(env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "")}/repos/${repository}/check-runs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({
        name: checkName(suite),
        head_sha: sha,
        status: "completed",
        conclusion: presentation.conclusion,
        output: { title: presentation.line, summary: presentation.details },
      }),
      signal: AbortSignal.timeout(CHECK_RUN_BUDGET_MS),
    });
  } catch (error) {
    command("warning", `Testnotary: the check run could not be made (${error instanceof Error ? error.message : String(error)}); the job summary has the line.`);
    return;
  }
  if (response.status === 403) {
    // A fork pull request's token is read-only, and a workflow may not grant `checks: write`.
    process.stdout.write("Testnotary: no check run: the job's GITHUB_TOKEN lacks checks: write\n");
    return;
  }
  if (!response.ok) command("warning", `Testnotary: GitHub answered ${response.status} to the check run; the job summary has the line.`);
}

function headSha(env: RunnerEnv): string | undefined {
  if (env.GITHUB_EVENT_NAME === "pull_request" && env.GITHUB_EVENT_PATH) {
    try {
      const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")) as { pull_request?: { head?: { sha?: unknown } } };
      const sha = event.pull_request?.head?.sha;
      if (typeof sha === "string" && sha) return sha;
    } catch {
      // fall through to GITHUB_SHA
    }
  }
  return env.GITHUB_SHA;
}
