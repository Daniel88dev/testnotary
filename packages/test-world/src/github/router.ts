import type { FakeGitHub } from "./server.ts";

export interface RouteContext {
  request: Request;
  url: URL;
  params: Record<string, string>;
  github: FakeGitHub;
}

export type RouteHandler = (context: RouteContext) => Response | Promise<Response>;

/** One fake endpoint. `path` uses `:name` segments, e.g. `/repos/:owner/:repo/git/commits/:sha`. */
export interface Route {
  method: string;
  path: string;
  handle: RouteHandler;
  /** Only requests this accepts are handled here (overrides). */
  when?: (request: Request) => boolean;
}

/** Whether a request carries a job's `GITHUB_TOKEN` (the action's calls), for `override`'s `when`. */
export function fromJob(request: Request): boolean {
  return /^(?:Bearer|token) ghs_job_/i.test(request.headers.get("authorization") ?? "");
}

export function route(method: string, path: string, handle: RouteHandler): Route {
  return { method, path, handle };
}

export function matchPath(pattern: string, pathname: string): Record<string, string> | undefined {
  const want = pattern.split("/");
  const got = pathname.replace(/\/+$/, "").split("/");
  if (want.length !== got.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    const segment = want[i]!;
    if (segment.startsWith(":")) params[segment.slice(1)] = decodeURIComponent(got[i]!);
    else if (segment !== got[i]) return undefined;
  }
  return params;
}

/** A JSON response with GitHub's REST headers. */
export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return Response.json(body, {
    status,
    headers: { "x-github-api-version-selected": "2022-11-28", ...headers },
  });
}

/** GitHub's own error body shape. */
export function githubError(status: number, message: string): Response {
  return json(status, { message, documentation_url: "https://docs.github.com/rest", status: String(status) });
}

export const notFound = () => githubError(404, "Not Found");
