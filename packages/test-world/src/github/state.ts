import type { FakeAccount, FakeInstallation } from "./app.ts";

/** A person's role on a repo, as GitHub's roles go. */
export type RepoPermission = "admin" | "maintain" | "write" | "triage" | "read" | "none";

export interface InstallationToken {
  installationId: number;
  /** ms since the epoch; GitHub's last an hour. */
  expiresAt: number;
}

/**
 * A job's `GITHUB_TOKEN`: it reaches only the workflow's own repo, with the workflow's
 * `permissions`. A fork pull request's token is read-only whatever the workflow asks.
 */
export interface JobToken {
  repoId: number;
  checks: "write" | "read";
}

/** A check run made through `POST /repos/{owner}/{repo}/check-runs`. */
export interface FakeCheckRun {
  id: number;
  repoId: number;
  name: string;
  headSha: string;
  status: string;
  conclusion: string | null;
  output: { title: string | null; summary: string | null };
  detailsUrl: string | null;
  /** The App that made it: `github-actions` (15368) for a `GITHUB_TOKEN`. */
  app: { slug: string; id: number };
}

/** An SSH signing key on a person's GitHub account (`GET /users/{login}/ssh_signing_keys`). */
export interface FakeSigningKey {
  id: number;
  accountId: number;
  /** `type base64`, as GitHub lists it (no comment). */
  key: string;
  title: string;
  createdAt: string;
}

/** A repo the fake GitHub knows, backed by a fixture repo's bare `origin`. */
export interface FakeRepo {
  /** GitHub's numeric repo id (what the OIDC `repository_id` claim carries). */
  id: number;
  owner: string;
  /** Numeric id of the owning account (`repository_owner_id`). */
  ownerId: number;
  name: string;
  fullName: string;
  visibility: "public" | "private";
  defaultBranch: string;
  /** The bare git repository GitHub "hosts". Only pushed commits are visible, as on GitHub. */
  gitDir: string;
}

/**
 * Everything the fake GitHub remembers. Endpoints read and change it; tests seed it through the
 * FakeGitHub methods. Grow it here (installations, users, collaborators, keys, check runs, …) as
 * tickets add endpoints.
 */
export class GitHubState {
  readonly repos = new Map<string, FakeRepo>();
  /** Installations of the Testnotary App, by installation id. */
  readonly installations = new Map<number, FakeInstallation>();
  /** GitHub accounts by lowercased login: people (device flow, `/user`) and organizations. */
  readonly accounts = new Map<string, FakeAccount>();
  /** Every user token (`ghu_…`) handed out by the device flow or the browser sign-in, and whose it is. */
  readonly userTokens = new Map<string, FakeAccount>();
  /** Installation access tokens (`ghs_…`) the App bought, by value. */
  readonly installationTokens = new Map<string, InstallationToken>();
  /**
   * Collaborator permissions set by tests, by repo id then account id. Anyone not listed reads
   * `read` on a public repo and `none` on a private one; the owner of a personal repo is admin.
   */
  readonly permissions = new Map<number, Map<number, RepoPermission>>();
  /** Every job's `GITHUB_TOKEN`, by value. */
  readonly jobTokens = new Map<string, JobToken>();
  /** Check runs, oldest first. */
  readonly checkRuns: FakeCheckRun[] = [];
  /**
   * SSH signing keys people added to their accounts, oldest first. A deleted key is gone from the
   * next request: authenticated reads saw the change within 2 s live, and there is no cache here.
   */
  readonly signingKeys: FakeSigningKey[] = [];
  private nextId = 1000;

  id(): number {
    return this.nextId++;
  }

  repo(owner: string, name: string): FakeRepo | undefined {
    return this.repos.get(`${owner}/${name}`.toLowerCase());
  }

  addRepo(repo: Omit<FakeRepo, "fullName">): FakeRepo {
    const stored = { ...repo, fullName: `${repo.owner}/${repo.name}` };
    this.repos.set(stored.fullName.toLowerCase(), stored);
    return stored;
  }

  /** Renames a repo in place (the `renamed` and `transferred` events). */
  moveRepo(repo: FakeRepo, owner: string, name: string): void {
    this.repos.delete(repo.fullName.toLowerCase());
    repo.owner = owner;
    repo.name = name;
    repo.fullName = `${owner}/${name}`;
    this.repos.set(repo.fullName.toLowerCase(), repo);
  }

  /** The account with this numeric id, if GitHub knows one. */
  accountById(id: number): FakeAccount | undefined {
    return [...this.accounts.values()].find((account) => account.id === id);
  }

  /** What `GET …/collaborators/{login}/permission` reports: `maintain` folds into `write`, `triage` into `read`. */
  permission(repo: FakeRepo, account: FakeAccount): "admin" | "write" | "read" | "none" {
    const set = this.explicitRole(repo, account);
    if (set === "maintain") return "write";
    if (set === "triage") return "read";
    if (set && set !== "none") return set;
    return repo.visibility === "public" ? "read" : "none";
  }

  /**
   * The role the person holds on the repo itself (what GitHub lists a repo under their
   * installations for): one set by a test, or admin on their own personal repo. `undefined` or
   * `none` means they only read it if it is public.
   */
  explicitRole(repo: FakeRepo, account: FakeAccount): RepoPermission | undefined {
    const set = this.permissions.get(repo.id)?.get(account.id);
    if (set) return set;
    return repo.owner.toLowerCase() === account.login.toLowerCase() ? "admin" : undefined;
  }

  /** The account with this login, made up (with a fresh id) the first time it is named. */
  account(login: string, type: FakeAccount["type"] = "User", id?: number): FakeAccount {
    const key = login.toLowerCase();
    let account = this.accounts.get(key);
    if (!account) {
      account = { login, id: id ?? this.id(), type };
      this.accounts.set(key, account);
    }
    return account;
  }
}
