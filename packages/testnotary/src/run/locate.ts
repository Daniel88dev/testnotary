// Finding what a run tests and how: the repo and its `HEAD`, `origin`, the base branch, the base's
// `testnotary.json` and the suite. Refuses with `not_a_git_repo`, `no_remote`,
// `no_config_on_base` or `config_invalid`.
import { UsageError } from "../command.ts";
import { tryGit } from "../git.ts";
import { CONFIG_FILE, parseConfig, suiteFromConfig, suiteNames, type Suite, type TestnotaryConfig } from "../shared.ts";
import type { Env, Refusal, RunContext } from "./context.ts";

const FETCH_TIMEOUT_MS = 20_000;

export interface LocateInput {
  cwd: string;
  env: Env;
  /** The suite named on the command line, if any. */
  suite: string | undefined;
  /** `--base`, which wins over the config's `base`. */
  base: string | undefined;
}

export type Located = Pick<RunContext, "root" | "checkout" | "origin" | "base" | "config" | "suite">;

/** A refusal, with whatever of the repo was found by then (a refused run reports tree and commit). */
export type LocateRefusal = Refusal & { partial: { repository?: string; checkout?: { commit: string; tree: string } } };

/** `owner/name` from a github.com remote URL (HTTPS, SSH or scp-style), or undefined. */
export function githubRepository(url: string): string | undefined {
  const patterns = [
    /^(?:https?|git|ssh):\/\/(?:[^@/]+@)?(?:www\.)?github\.com(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
    /^(?:[^@/]+@)?github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(url.trim());
    if (match && /^[A-Za-z0-9-]+$/.test(match[1]!) && /^[A-Za-z0-9._-]+$/.test(match[2]!)) return `${match[1]}/${match[2]}`;
  }
  return undefined;
}

export async function locate(input: LocateInput): Promise<{ located: Located } | { refused: LocateRefusal }> {
  const { env } = input;
  const root = await tryGit(input.cwd, ["rev-parse", "--show-toplevel"], env);
  if (root === undefined) {
    return refuse("not_a_git_repo", ["not inside a git repository: run testnotary in a clone of the repo you want to attest"], {});
  }
  const commit = await tryGit(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], env);
  const tree = commit && (await tryGit(root, ["rev-parse", "--verify", "--quiet", "HEAD^{tree}"], env));
  if (!commit || !tree) return refuse("not_a_git_repo", ["the repository has no commits yet: commit what you want to test first"], {});
  const checkout = { commit, tree };

  // The raw URL as configured: `git remote get-url` would apply `insteadOf` rewrites.
  const url = await tryGit(root, ["config", "--get", "remote.origin.url"], env);
  if (!url) {
    return refuse("no_remote", ["the repository has no remote named origin: add the GitHub repo as origin (git remote add origin <url>)"], { checkout });
  }
  const repository = githubRepository(url);
  const origin = { url, repository };
  const partial = { checkout, ...(repository ? { repository } : {}) };

  let branch = input.base ?? (await defaultBranch(root, env));
  if (!branch) {
    return refuse(
      "no_config_on_base",
      ["can't tell origin's default branch (no origin/HEAD, and origin didn't answer): pass --base <branch>, or run git remote set-head origin --auto"],
      partial,
    );
  }
  let fetched = await fetchBase(root, branch, env);
  let read = await readBaseConfig(root, branch, env);
  if (read.kind === "config" && input.base === undefined && read.config.base && read.config.base !== branch) {
    // The default branch's config names another base: that branch's config is the one that counts.
    branch = read.config.base;
    fetched = await fetchBase(root, branch, env);
    read = await readBaseConfig(root, branch, env);
  }
  if (read.kind === "missing") {
    return refuse(
      "no_config_on_base",
      [`origin/${branch} has no ${CONFIG_FILE}: merge the setup pull request that adds it first (testnotary init writes one)`],
      partial,
    );
  }
  if (read.kind === "invalid") {
    return refuse("config_invalid", [`${CONFIG_FILE} on origin/${branch} is not valid:`, ...read.problems.map((problem) => `  ${problem}`)], partial);
  }
  const config = read.config;
  const suite = chooseSuite(config, input.suite, branch);
  if ("refusal" in suite) return { refused: { ...suite, partial } };
  return { located: { root, checkout, origin, base: { branch, ref: `origin/${branch}`, fetched }, config, suite } };
}

function refuse(refusal: LocateRefusal["refusal"], lines: string[], partial: LocateRefusal["partial"]): { refused: LocateRefusal } {
  return { refused: { refusal, lines, partial } };
}

/** `origin/HEAD`, falling back to asking origin (`ls-remote --symref`). */
async function defaultBranch(root: string, env: Env): Promise<string | undefined> {
  const local = await tryGit(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], env);
  if (local?.startsWith("origin/")) return local.slice("origin/".length);
  const remote = await tryGit(root, ["ls-remote", "--symref", "origin", "HEAD"], env, FETCH_TIMEOUT_MS);
  return /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(remote ?? "")?.[1];
}

/** Fetches the base into `origin/<branch>`. False when the fetch failed (offline): the last fetched ref is used. */
async function fetchBase(root: string, branch: string, env: Env): Promise<boolean> {
  const result = await tryGit(root, ["fetch", "--quiet", "--no-tags", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], env, FETCH_TIMEOUT_MS);
  return result !== undefined;
}

type BaseConfig = { kind: "config"; config: TestnotaryConfig } | { kind: "missing" } | { kind: "invalid"; problems: string[] };

async function readBaseConfig(root: string, branch: string, env: Env): Promise<BaseConfig> {
  const text = await tryGit(root, ["show", `refs/remotes/origin/${branch}:${CONFIG_FILE}`], env);
  if (text === undefined) return { kind: "missing" };
  const parsed = parseConfig(text);
  return parsed.ok ? { kind: "config", config: parsed.config } : { kind: "invalid", problems: parsed.problems };
}

/** The named suite, or the only one; several and none named is a usage error. */
function chooseSuite(config: TestnotaryConfig, name: string | undefined, branch: string): Suite | Refusal {
  const names = suiteNames(config);
  if (name === undefined) {
    if (names.length === 1) return suiteFromConfig(config, names[0]!)!;
    throw new UsageError(`name the suite to run; ${CONFIG_FILE} on origin/${branch} declares: ${names.join(", ")}`);
  }
  const suite = suiteFromConfig(config, name);
  if (suite) return suite;
  return {
    refusal: "config_invalid",
    lines: [`${CONFIG_FILE} on origin/${branch} declares no suite ${JSON.stringify(name)}; it declares: ${names.join(", ")}`],
  };
}
