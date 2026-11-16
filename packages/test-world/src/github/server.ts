import { randomBytes } from "node:crypto";
import { serve, type HttpServer } from "../http.ts";
import {
  deliver,
  installationPayload,
  newApp,
  repoPayload,
  type DeliverOptions,
  type FakeAccount,
  type FakeApp,
  type FakeInstallation,
  type WebhookDelivery,
} from "./app.ts";
import { OidcIssuer } from "./oidc.ts";
import { matchPath, notFound, type Route, type RouteHandler } from "./router.ts";
import { DeviceFlow } from "./device-flow.ts";
import { checkRoutes } from "./routes/checks.ts";
import { gitRoutes } from "./routes/git.ts";
import { installationRoutes } from "./routes/installation.ts";
import { loginRoutes } from "./routes/login.ts";
import { oidcRoutes } from "./routes/oidc.ts";
import { avatarRoutes } from "./routes/avatars.ts";
import { userAccessRoutes } from "./routes/user-access.ts";
import { signingKeyRoutes } from "./routes/signing-keys.ts";
import { GitHubState, type FakeCheckRun, type FakeRepo, type RepoPermission } from "./state.ts";
import { WebFlow } from "./web-flow.ts";

/** Every endpoint the fake serves. Add a file under routes/ and list it here. */
// `GET /user/installations` (user-access) must come before `GET /user/:id` (installation).
const routes: Route[] = [...gitRoutes, ...oidcRoutes, ...loginRoutes, ...userAccessRoutes, ...installationRoutes, ...avatarRoutes, ...checkRoutes, ...signingKeyRoutes];

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
  /** When it arrived, in ms since the epoch. */
  at: number;
}

export interface InstallAppOptions {
  /** The account installing the App. A login made up here gets a fresh id. */
  account: { login: string; id?: number; type?: FakeAccount["type"] };
  repos: FakeRepo[];
  /** The installation id GitHub assigns (a reinstall gets a new one). */
  id?: number;
}

export type RepositoryAction =
  | { action: "renamed"; name: string }
  | { action: "transferred"; owner: string }
  | { action: "privatized" }
  | { action: "publicized" }
  | { action: "deleted" };

export interface AddRepoOptions {
  owner?: string;
  name?: string;
  id?: number;
  ownerId?: number;
  visibility?: "public" | "private";
}

/**
 * One HTTP server playing GitHub: the REST API at its root and the Actions OIDC issuer under
 * `/oidc`. Its answers follow what live tests against GitHub recorded; each endpoint links the
 * GitHub docs page it follows, or says which behaviour it encodes.
 */
export class FakeGitHub {
  readonly state = new GitHubState();
  readonly oidc = new OidcIssuer(() => this.url);
  /** Every request received, in order, for asserting on what reached GitHub. */
  readonly requests: RecordedRequest[] = [];
  /** The Testnotary App: client id, webhook secret and webhook URL. */
  readonly app: FakeApp = newApp(this.state.id());
  /** The device flow behind `testnotary login`: plan approvals with `approveNext`. */
  readonly deviceFlow = new DeviceFlow(this.state.userTokens);
  /** The browser sign-in to the dashboard: plan who is signed in on GitHub with `approveNext`. */
  readonly webFlow = new WebFlow(this.state.userTokens);
  /** Every webhook delivered to the App, with the service's answer. */
  readonly deliveries: WebhookDelivery[] = [];
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
   * Gives a person a role on a repo (`admin`, `maintain`, `write`, `triage`, `read`, `none`). Without
   * one they read `read` on a public repo and `none` on a private one, and the owner of a
   * personal repo is admin. `none` takes a role away. The dashboard sees the same roles through the
   * person's user token (`GET /repos/{owner}/{repo}`, `GET /user/installations…`).
   */
  setPermission(repo: FakeRepo, account: FakeAccount, permission: RepoPermission): void {
    let roles = this.state.permissions.get(repo.id);
    if (!roles) {
      roles = new Map();
      this.state.permissions.set(repo.id, roles);
    }
    roles.set(account.id, permission);
  }

  /**
   * A job's `GITHUB_TOKEN` for `repo`. `checks: "write"` when the workflow grants `checks: write`
   * (the snippet does); a fork pull request's token is always read-only.
   */
  jobToken(repo: FakeRepo, options: { checks: "write" | "read" }): string {
    const value = `ghs_job_${randomBytes(18).toString("base64url")}`;
    this.state.jobTokens.set(value, { repoId: repo.id, checks: options.checks });
    return value;
  }

  /** The check runs made on a repo, oldest first. */
  checkRuns(repo: FakeRepo): FakeCheckRun[] {
    return this.state.checkRuns.filter((run) => run.repoId === repo.id);
  }

  /** A person on GitHub, who can sign in through the device flow or in the browser. */
  addUser(options: { login: string; id?: number }): FakeAccount {
    return this.state.account(options.login, "User", options.id);
  }

  /**
   * The person adds an SSH signing key to their account (Settings › SSH and GPG keys, as a signing
   * key). `publicKey` is a `.pub` line; GitHub keeps only its type and base64. Returns its id.
   */
  addSigningKey(account: FakeAccount, publicKey: string, title = "laptop"): number {
    const [type, data] = publicKey.trim().split(/\s+/);
    const id = this.state.id();
    this.state.signingKeys.push({ id, accountId: account.id, key: `${type} ${data}`, title, createdAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") });
    return id;
  }

  /** The person deletes a signing key: it is gone from the very next `ssh_signing_keys` read. */
  removeSigningKey(id: number): void {
    const index = this.state.signingKeys.findIndex((key) => key.id === id);
    if (index >= 0) this.state.signingKeys.splice(index, 1);
  }

  /** Where the App's avatars come from: avatars.githubusercontent.com in production. */
  get avatarsUrl(): string {
    return `${this.url}/avatars`;
  }

  /**
   * The account installs the App on some of its repos: GitHub records the installation and sends
   * `installation` `created` with the repos. Returns the installation and the delivery.
   */
  async installApp(options: InstallAppOptions): Promise<{ installation: FakeInstallation; delivery: WebhookDelivery }> {
    const account = this.state.account(options.account.login, options.account.type ?? "User", options.account.id);
    const installation: FakeInstallation = {
      id: options.id ?? this.state.id(),
      account,
      repoIds: new Set(options.repos.map((repo) => repo.id)),
      suspended: false,
    };
    this.state.installations.set(installation.id, installation);
    const delivery = await this.installationEvent(installation, "created", options.repos);
    return { installation, delivery };
  }

  /** The account uninstalls the App: `installation` `deleted`. */
  uninstallApp(installation: FakeInstallation): Promise<WebhookDelivery> {
    this.state.installations.delete(installation.id);
    return this.installationEvent(installation, "deleted", this.installationRepos(installation));
  }

  /** An owner suspends or unsuspends the installation: `installation` `suspend` / `unsuspend`. */
  setSuspended(installation: FakeInstallation, suspended: boolean): Promise<WebhookDelivery> {
    installation.suspended = suspended;
    return this.installationEvent(installation, suspended ? "suspend" : "unsuspend", undefined);
  }

  /** The account gives the App more repos: `installation_repositories` `added`. */
  addInstallationRepos(installation: FakeInstallation, repos: FakeRepo[]): Promise<WebhookDelivery> {
    for (const repo of repos) installation.repoIds.add(repo.id);
    return this.deliverWebhook("installation_repositories", {
      action: "added",
      installation: installationPayload(this.app, installation),
      repository_selection: "selected",
      repositories_added: repos.map(repoPayload),
      repositories_removed: [],
      sender: this.sender(installation),
    });
  }

  /** The account takes repos away from the App: `installation_repositories` `removed`. */
  removeInstallationRepos(installation: FakeInstallation, repos: FakeRepo[]): Promise<WebhookDelivery> {
    for (const repo of repos) installation.repoIds.delete(repo.id);
    return this.deliverWebhook("installation_repositories", {
      action: "removed",
      installation: installationPayload(this.app, installation),
      repository_selection: "selected",
      repositories_added: [],
      repositories_removed: repos.map(repoPayload),
      sender: this.sender(installation),
    });
  }

  /** Something happens to an installed repo: a `repository` event. */
  repositoryEvent(installation: FakeInstallation, repo: FakeRepo, change: RepositoryAction): Promise<WebhookDelivery> {
    let changes: Record<string, unknown> | undefined;
    if (change.action === "renamed") {
      changes = { repository: { name: { from: repo.name } } };
      this.state.moveRepo(repo, repo.owner, change.name);
    } else if (change.action === "transferred") {
      changes = { owner: { from: { user: { login: repo.owner, id: repo.ownerId, type: "Organization" } } } };
      this.state.moveRepo(repo, change.owner, repo.name);
      installation.repoIds.delete(repo.id);
    } else if (change.action === "privatized" || change.action === "publicized") {
      repo.visibility = change.action === "privatized" ? "private" : "public";
    } else {
      this.state.repos.delete(repo.fullName.toLowerCase());
      installation.repoIds.delete(repo.id);
    }
    return this.deliverWebhook("repository", {
      action: change.action,
      ...(changes ? { changes } : {}),
      repository: {
        ...repoPayload(repo),
        visibility: repo.visibility,
        owner: { login: repo.owner, id: repo.ownerId },
        default_branch: repo.defaultBranch,
      },
      installation: { id: installation.id, node_id: `MDIz${installation.id}` },
      sender: this.sender(installation),
    });
  }

  /** Sends one webhook as GitHub would, signed with the App's secret unless told otherwise. */
  async deliverWebhook(event: string, payload: Record<string, unknown>, options?: DeliverOptions): Promise<WebhookDelivery> {
    const delivery = await deliver(this.app, event, payload, options);
    this.deliveries.push(delivery);
    return delivery;
  }

  private installationEvent(installation: FakeInstallation, action: string, repos: FakeRepo[] | undefined): Promise<WebhookDelivery> {
    return this.deliverWebhook("installation", {
      action,
      installation: installationPayload(this.app, installation),
      ...(repos ? { repositories: repos.map(repoPayload) } : {}),
      sender: this.sender(installation),
    });
  }

  private installationRepos(installation: FakeInstallation): FakeRepo[] {
    return [...this.state.repos.values()].filter((repo) => installation.repoIds.has(repo.id));
  }

  private sender(installation: FakeInstallation) {
    const account = installation.account;
    return account.type === "User" ? { login: account.login, id: account.id, type: "User" } : { login: "octocat", id: 1, type: "User" };
  }

  /**
   * Answers one endpoint differently until the returned function is called, e.g. a 403 naming an
   * IP allow list, a 500, or a slow reply. Overrides win over the built-in routes; newest first.
   * With `when`, only the requests it accepts are answered so (say, only the action's, made with a
   * job's `GITHUB_TOKEN`: see `fromJob`); the rest get the usual answer.
   */
  override(method: string, path: string, handle: RouteHandler, options: { when?: (request: Request) => boolean } = {}): () => void {
    const when = options.when;
    const entry: Route = { method, path, handle, ...(when ? { when } : {}) };
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
      at: Date.now(),
    });
    for (const candidate of [...this.overrides, ...routes]) {
      if (candidate.method !== request.method || (candidate.when && !candidate.when(request))) continue;
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
