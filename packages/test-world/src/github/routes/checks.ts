import { githubError, json, route } from "../router.ts";

// Check runs the action makes with the job's `GITHUB_TOKEN` (NOTES/github-behaviours.md §9):
// `POST /repos/{owner}/{repo}/check-runs` needs `checks: write`; a fork pull request's token is
// read-only, so it gets 403 "Resource not accessible by integration". The run is filed under the
// `github-actions` App (id 15368). GitHub's display name (`<workflow> / … (<event>)`) is UI and
// not modelled.

function bearer(request: Request): string | undefined {
  return /^(?:Bearer|token) (\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
}

export const checkRoutes = [
  route("POST", "/repos/:owner/:repo/check-runs", async ({ request, params, github }) => {
    const value = bearer(request);
    const token = value ? github.state.jobTokens.get(value) : undefined;
    if (!token) return githubError(401, "Bad credentials");
    const repo = github.state.repo(params.owner!, params.repo!);
    if (!repo || repo.id !== token.repoId) return githubError(404, "Not Found");
    if (token.checks !== "write") return githubError(403, "Resource not accessible by integration");
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (typeof body?.name !== "string" || typeof body.head_sha !== "string") {
      return json(422, { message: "Invalid request.", errors: ["name and head_sha are required"], status: "422" });
    }
    const output = (body.output ?? {}) as Record<string, unknown>;
    const run = {
      id: github.state.id(),
      repoId: repo.id,
      name: body.name,
      headSha: body.head_sha,
      status: typeof body.status === "string" ? body.status : "queued",
      conclusion: typeof body.conclusion === "string" ? body.conclusion : null,
      output: {
        title: typeof output.title === "string" ? output.title : null,
        summary: typeof output.summary === "string" ? output.summary : null,
      },
      detailsUrl: typeof body.details_url === "string" ? body.details_url : null,
      app: { slug: "github-actions", id: 15368 },
    };
    github.state.checkRuns.push(run);
    return json(201, {
      id: run.id,
      name: run.name,
      head_sha: run.headSha,
      status: run.status,
      conclusion: run.conclusion,
      output: run.output,
      details_url: run.detailsUrl,
      app: run.app,
    });
  }),
];
