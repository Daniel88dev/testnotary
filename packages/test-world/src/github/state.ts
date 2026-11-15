import type { FakeAccount, FakeInstallation } from "./app.ts";

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
