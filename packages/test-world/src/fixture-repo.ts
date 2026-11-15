import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { git } from "./git.ts";

/** The config a fixture repo's base branch carries unless the test says otherwise. */
export const DEFAULT_CONFIG = { suites: { test: { command: ["node", "--test"] } } };

export interface FixtureRepoOptions {
  /** `testnotary.json` on the base branch. `null` leaves it out. */
  config?: Record<string, unknown> | null;
  /** More files for the base commit: `package.json`, lockfiles, `.gitignore`, sources, … */
  files?: Record<string, string>;
  defaultBranch?: string;
}

/**
 * A git repo built for one test: a working clone (`dir`) with a bare `origin` (`remoteDir`) whose
 * default branch carries `testnotary.json`. `origin/HEAD` is set, as after a real clone. The fake
 * GitHub serves `remoteDir`, so only pushed commits are visible to it, as on GitHub.
 *
 * Install-state files (`node_modules/.pnpm/lock.yaml`, `node_modules/.package-lock.json`, …) and
 * other untracked or ignored files go in with `write()` after the commit; list them in a
 * `.gitignore` in `files` when they must not dirty the tree.
 */
export class FixtureRepo {
  private constructor(
    readonly dir: string,
    readonly remoteDir: string,
    readonly defaultBranch: string,
    private readonly root: string,
  ) {}

  static async create(options: FixtureRepoOptions = {}): Promise<FixtureRepo> {
    const root = await realpath(await mkdtemp(join(tmpdir(), "tnw-repo-")));
    const defaultBranch = options.defaultBranch ?? "main";
    const repo = new FixtureRepo(join(root, "work"), join(root, "origin.git"), defaultBranch, root);
    await mkdir(repo.dir);
    await git(root, ["init", "--quiet", "--bare", `--initial-branch=${defaultBranch}`, repo.remoteDir]);
    await git(repo.dir, ["init", "--quiet", `--initial-branch=${defaultBranch}`]);
    await git(repo.dir, ["remote", "add", "origin", repo.remoteDir]);
    const config = options.config === undefined ? DEFAULT_CONFIG : options.config;
    await repo.commit("Initial commit", {
      ...(config ? { "testnotary.json": `${JSON.stringify(config, null, 2)}\n` } : {}),
      ...options.files,
    });
    await repo.push(defaultBranch);
    await git(repo.dir, ["remote", "set-head", "origin", defaultBranch]);
    return repo;
  }

  /** Runs git in the working clone and returns stdout. */
  git(...args: string[]): Promise<string> {
    return git(this.dir, args);
  }

  /** Writes files into the working tree without committing. `null` deletes a file. */
  async write(files: Record<string, string | null>): Promise<void> {
    for (const [path, content] of Object.entries(files)) {
      const file = join(this.dir, path);
      if (content === null) {
        await rm(file, { force: true });
      } else {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, content);
      }
    }
  }

  /** Writes `files`, stages everything and commits on the current branch. Returns the commit. */
  async commit(message: string, files: Record<string, string | null> = {}): Promise<string> {
    await this.write(files);
    await this.git("add", "--all");
    await this.git("commit", "--quiet", "--allow-empty", "--no-verify", "-m", message);
    return this.revParse("HEAD");
  }

  /** Creates a branch (from `from`, default the current commit) and checks it out. */
  async branch(name: string, from = "HEAD"): Promise<void> {
    await this.git("checkout", "--quiet", "-b", name, from);
  }

  async checkout(ref: string): Promise<void> {
    await this.git("checkout", "--quiet", ref);
  }

  /** Pushes a branch (default: the current one) to origin, i.e. to the fake GitHub. */
  async push(branch?: string): Promise<void> {
    const name = branch ?? (await this.git("rev-parse", "--abbrev-ref", "HEAD")).trim();
    await this.git("push", "--quiet", "--force", "origin", `${name}:refs/heads/${name}`);
  }

  /**
   * The commit GitHub tests on `pull_request`: a merge of the pushed head into the pushed base,
   * stored at `refs/pull/<number>/merge` on origin and fetched into the clone. Its first parent is
   * the base tip and its second the head; GITHUB_SHA and the OIDC `sha` claim name it.
   * Throws when the branches conflict (GitHub then builds no merge ref and starts no run).
   */
  async testMerge(options: { base: string; head: string; number?: number }): Promise<{ sha: string; tree: string; parents: [string, string]; ref: string }> {
    const number = options.number ?? 1;
    const base = (await git(this.remoteDir, ["rev-parse", `refs/heads/${options.base}`])).trim();
    const head = (await git(this.remoteDir, ["rev-parse", `refs/heads/${options.head}`])).trim();
    const tree = (await git(this.remoteDir, ["merge-tree", "--write-tree", base, head])).split("\n")[0]!.trim();
    const sha = (
      await git(this.remoteDir, ["commit-tree", tree, "-p", base, "-p", head, "-m", `Merge ${head} into ${base}`], {
        GIT_COMMITTER_NAME: "GitHub",
        GIT_COMMITTER_EMAIL: "noreply@github.com",
      })
    ).trim();
    const ref = `refs/pull/${number}/merge`;
    await git(this.remoteDir, ["update-ref", ref, sha]);
    await this.git("fetch", "--quiet", "origin", `+${ref}:refs/remotes/origin/pull/${number}/merge`);
    return { sha, tree, parents: [base, head], ref };
  }

  async revParse(ref: string): Promise<string> {
    return (await this.git("rev-parse", "--verify", `${ref}^{commit}`)).trim();
  }

  /** The tree a commit points at: what an attestation covers. */
  async tree(ref = "HEAD"): Promise<string> {
    return (await this.git("rev-parse", "--verify", `${ref}^{tree}`)).trim();
  }

  async remove(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}
