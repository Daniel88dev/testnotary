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
}
