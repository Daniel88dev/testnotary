import type { VerificationStep } from "../context.ts";

/**
 * The events whose `sha` (GitHub's `GITHUB_SHA`) is the code the job tests: a pull request's test
 * merge commit, a merge queue's group commit, and a push to the default branch. A push to it after
 * a merge, a re-run and "Update branch" are among these.
 */
export const VERIFIED_EVENTS = ["pull_request", "push", "merge_group"] as const;

/**
 * Only a verified event can skip. On `pull_request_target` the `sha` is the base branch's head while
 * the job may check out a fork's code; on `workflow_run`, `issue_comment`, `workflow_dispatch`,
 * `schedule` and the rest a job checks out whatever ref it likes. A push to another branch than the
 * default is checked against a first parent that is no base. Each is a recorded fallback, never a
 * skip. No code of its own: it reads `no_attestation`, its detail saying why.
 */
export const eventStep: VerificationStep = {
  name: "event",
  async decide(state) {
    if (state.event === "pull_request" || state.event === "merge_group") return undefined;
    if (state.event !== "push") return { reason: "no_attestation", detail: `event ${state.event} is not verified` };
    const branch = await state.sources.defaultBranch();
    if (branch !== undefined && state.ref === `refs/heads/${branch}`) return undefined;
    return { reason: "no_attestation", detail: `event push to ${state.ref || "an unnamed ref"} is not verified: only a push to the default branch is` };
  },
};
