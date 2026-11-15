import { execFile } from "node:child_process";

/** Runs git and returns its trimmed stdout, or `undefined` when git fails or isn't installed. */
export function tryGit(cwd: string, args: string[], env: Readonly<Record<string, string | undefined>>): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, env: { ...env, GIT_OPTIONAL_LOCKS: "0" } }, (error, stdout) => {
      resolve(error ? undefined : stdout.trim());
    });
  });
}

export interface Checkout {
  /** The repo's top level, or the directory itself outside a git repo. */
  root: string;
  commit: string | null;
  tree: string | null;
}

/** Where the checked-out tree is and which commit and tree `HEAD` names, as far as git can tell. */
export async function readCheckout(cwd: string, env: Readonly<Record<string, string | undefined>>): Promise<Checkout> {
  const root = (await tryGit(cwd, ["rev-parse", "--show-toplevel"], env)) ?? cwd;
  const commit = (await tryGit(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], env)) ?? null;
  const tree = commit ? ((await tryGit(root, ["rev-parse", "--verify", "--quiet", "HEAD^{tree}"], env)) ?? null) : null;
  return { root, commit, tree };
}
