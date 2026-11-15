import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Git with none of the developer's configuration (no global or system config, no signing, no
 * hooks) and a fixed identity, so fixture repos behave the same on every machine.
 */
export const gitEnv: Record<string, string> = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Fixture Author",
  GIT_AUTHOR_EMAIL: "author@fixture.test",
  GIT_COMMITTER_NAME: "Fixture Committer",
  GIT_COMMITTER_EMAIL: "committer@fixture.test",
  LANG: "C",
};

export async function git(cwd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  try {
    const { stdout } = await run("git", args, { cwd, env: { ...gitEnv, ...env }, maxBuffer: 1 << 26 });
    return stdout;
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr) : "";
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${stderr || String(error)}`);
  }
}

/** git that answers `undefined` instead of throwing (for lookups that may miss). */
export async function gitMaybe(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    return await git(cwd, args);
  } catch {
    return undefined;
  }
}

export interface CommitObject {
  sha: string;
  tree: string;
  parents: string[];
  author: { name: string; email: string; date: string };
  committer: { name: string; email: string; date: string };
  message: string;
}

/** Reads one commit object, or `undefined` when the repository does not have it. */
export async function readCommit(gitDir: string, sha: string): Promise<CommitObject | undefined> {
  if (!/^[0-9a-f]{4,40}$/i.test(sha)) return undefined;
  const type = await gitMaybe(gitDir, ["cat-file", "-t", sha]);
  if (type?.trim() !== "commit") return undefined;
  const full = (await git(gitDir, ["rev-parse", "--verify", `${sha}^{commit}`])).trim();
  const raw = await git(gitDir, ["cat-file", "commit", full]);
  const [header = "", ...rest] = raw.split("\n\n");
  const commit: CommitObject = {
    sha: full,
    tree: "",
    parents: [],
    author: { name: "", email: "", date: "" },
    committer: { name: "", email: "", date: "" },
    message: rest.join("\n\n"),
  };
  for (const line of header.split("\n")) {
    const [key, ...value] = line.split(" ");
    const text = value.join(" ");
    if (key === "tree") commit.tree = text;
    else if (key === "parent") commit.parents.push(text);
    else if (key === "author") commit.author = person(text);
    else if (key === "committer") commit.committer = person(text);
  }
  return commit;
}

function person(text: string): { name: string; email: string; date: string } {
  const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(text);
  if (!match) return { name: text, email: "", date: "" };
  return { name: match[1]!, email: match[2]!, date: new Date(Number(match[3]) * 1000).toISOString().replace(".000", "") };
}
