import { serve, type HttpServer } from "../http.ts";
import { OidcIssuer } from "./oidc.ts";
import { matchPath, notFound, type Route, type RouteHandler } from "./router.ts";
import { gitRoutes } from "./routes/git.ts";
import { oidcRoutes } from "./routes/oidc.ts";
import { GitHubState, type FakeRepo } from "./state.ts";

/** Every endpoint the fake serves. Add a file under routes/ and list it here. */
const routes: Route[] = [...gitRoutes, ...oidcRoutes];

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
}

export interface AddRepoOptions {
  owner?: string;
  name?: string;
  id?: number;
  ownerId?: number;
  visibility?: "public" | "private";
}

/**
 * One HTTP server playing GitHub: the REST API at its root and the Actions OIDC issuer under
 * `/oidc`. Its answers follow what the live tests recorded (NOTES/github-behaviours.md and the
 * `research/live-github-tests` branch); cite the behaviour next to each endpoint that encodes one.
 */
export class FakeGitHub {
  readonly state = new GitHubState();
  readonly oidc = new OidcIssuer(() => this.url);
  /** Every request received, in order, for asserting on what reached GitHub. */
  readonly requests: RecordedRequest[] = [];
  private readonly overrides: Route[] = [];
  private server: HttpServer | undefined;

  static async start(): Promise<FakeGitHub> {
    const github = new FakeGitHub();
    github.server = await serve((request) => github.handle(request));
    return github;
  }

  /** Use as `GITHUB_API_URL`. */
  get url(): string {
    if (!this.server) throw new Error("the fake GitHub is not running");
    return this.server.url;
  }

  /** Makes a fixture repo's pushed history visible as `owner/name`. */
  addRepo(fixture: { remoteDir: string; defaultBranch: string }, options: AddRepoOptions = {}): FakeRepo {
    const id = options.id ?? this.state.id();
    return this.state.addRepo({
      id,
      owner: options.owner ?? "acme",
      ownerId: options.ownerId ?? this.state.id(),
      name: options.name ?? `repo-${id}`,
      visibility: options.visibility ?? "public",
      defaultBranch: fixture.defaultBranch,
      gitDir: fixture.remoteDir,
    });
  }

  /**
   * Answers one endpoint differently until the returned function is called, e.g. a 403 naming an
   * IP allow list, a 500, or a slow reply. Overrides win over the built-in routes; newest first.
   */
  override(method: string, path: string, handle: RouteHandler): () => void {
    const entry = { method, path, handle };
    this.overrides.unshift(entry);
    return () => {
      const index = this.overrides.indexOf(entry);
      if (index >= 0) this.overrides.splice(index, 1);
    };
  }

  /** Requests received for one method and path pattern (`:name` segments allowed). */
  requestsTo(method: string, path: string): RecordedRequest[] {
    return this.requests.filter((r) => r.method === method && matchPath(path, r.path));
  }

  async close(): Promise<void> {
    await this.server?.close();
    this.server = undefined;
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const text = request.method === "GET" || request.method === "HEAD" ? "" : await request.clone().text();
    this.requests.push({
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: Object.fromEntries(request.headers),
      body: parseBody(text),
    });
    for (const candidate of [...this.overrides, ...routes]) {
      if (candidate.method !== request.method) continue;
      const params = matchPath(candidate.path, url.pathname);
      if (params) return candidate.handle({ request, url, params, github: this });
    }
    return notFound();
  }
}

function parseBody(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
