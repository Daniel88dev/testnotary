import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { git } from "./git.ts";
import type { FakeGitHub } from "./github/server.ts";
import type { FakeRepo } from "./github/state.ts";
import type { Machine } from "./machine.ts";
import { paths } from "./paths.ts";

export type Env = Record<string, string | undefined>;

export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd: string;
  /** Added to the base environment; `undefined` removes a variable. */
  env?: Env;
  input?: string;
  timeoutMs?: number;
  /**
   * The machine to run on (`world.machine()`): its HOME and keychain stub last across calls.
   * Without one, each call gets a fresh machine.
   */
  machine?: Machine;
}

/**
 * Runs a TypeScript entry point as its own Node process. Sources run directly through Node's type
 * stripping (no build step), so workspace packages must stay erasable-syntax TypeScript.
 */
export function runNode(entry: string, args: string[], options: RunOptions & { baseEnv: Record<string, string> }): Promise<ProcessResult> {
  const env: Record<string, string> = { ...options.baseEnv };
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", entry, ...args], {
      cwd: options.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 30_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, stdout, stderr });
    });
    child.stdin.end(options.input ?? "");
  });
}

/**
 * The environment every child starts from: nothing of the developer's or the CI runner's own (no
 * `CLAUDECODE`, no `GITHUB_ACTIONS`, no git config), so sandbox markers and agent labels appear
 * only when a test sets them.
 */
export function cleanEnv(home: string, serviceUrl: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    LANG: "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    TESTNOTARY_URL: serviceUrl,
  };
}

export interface RunActionOptions {
  /** The GitHub repo the workflow runs in (from `world.github.addRepo`). */
  repo: FakeRepo;
  /** `GITHUB_SHA`: on `pull_request`, the test merge commit (`fixture.testMerge`). */
  sha: string;
  /** The checked-out tree (`GITHUB_WORKSPACE`), usually the fixture repo's `dir`. */
  workspace: string;
  event?: string;
  ref?: string;
  actor?: string;
  /** Action inputs, e.g. `{ suite: "unit", mode: "verify" }`. */
  inputs?: Record<string, string>;
  env?: Env;
  /** A fork pull request: the runner gets no OIDC token (live behaviour 1). */
  fork?: boolean;
  /** `permissions: id-token: write` granted. Default true. */
  idToken?: boolean;
  /**
   * `permissions: checks: write` granted to the job's `GITHUB_TOKEN`. Default true, as the
   * snippet grants it. A fork pull request's token is read-only whatever this says.
   */
  checks?: boolean;
  enterpriseSlug?: string;
  /** Replaces the generated `GITHUB_EVENT_PATH` payload. */
  eventPayload?: unknown;
  /** Another entry point instead of the action's (harness tests only). */
  entry?: string;
}

export interface ActionResult extends ProcessResult {
  /** What the step wrote to `GITHUB_OUTPUT`. */
  outputs: Record<string, string>;
  /** What the step wrote to `GITHUB_STEP_SUMMARY`. */
  summary: string;
  /**
   * Every call the step made to `npx`, `pnpm` or `yarn`, as argv with the tool first. The runner's
   * PATH starts with stand-ins for the three (package-manager-stub.ts), so no real package
   * manager runs.
   */
  packageManagerCalls: string[][];
}

/**
 * Installs the library in a workspace the way `pnpm install` / `npm ci` would leave it for the
 * action to find: `node_modules/.bin/testnotary` (here a script running the library's source).
 * List `node_modules` in the fixture's `.gitignore` when the tree must stay clean.
 */
export async function installLibrary(workspace: string): Promise<void> {
  const bin = join(workspace, "node_modules", ".bin");
  await mkdir(bin, { recursive: true });
  const script = join(bin, "testnotary");
  await writeFile(script, `#!/bin/sh\nexec ${quote(process.execPath)} --disable-warning=ExperimentalWarning ${quote(paths.cli)} "$@"\n`);
  await chmod(script, 0o755);
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** `npx`, `pnpm` and `yarn` stand-ins in `dir`, each logging its argv to `log`. */
async function packageManagerStubs(dir: string, log: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(log, "");
  for (const tool of ["npx", "pnpm", "yarn"]) {
    const script = join(dir, tool);
    await writeFile(
      script,
      `#!/bin/sh\nexec ${quote(process.execPath)} --disable-warning=ExperimentalWarning ${quote(paths.packageManagerStub)} ${tool} ${quote(log)} "$@"\n`,
    );
    await chmod(script, 0o755);
  }
}

/** The pull request's head commit: the test merge commit's second parent, when it has one. */
async function pullRequestHead(repo: FakeRepo, sha: string): Promise<string | undefined> {
  try {
    return (await git(repo.gitDir, ["rev-parse", "--verify", `${sha}^2`])).trim();
  } catch {
    return undefined;
  }
}

/** Runs the action's entry point as a process inside a simulated runner. */
export async function runAction(
  options: RunActionOptions,
  world: { github: FakeGitHub; serviceUrl: string; tmp: string },
): Promise<ActionResult> {
  const { repo } = options;
  const event = options.event ?? "pull_request";
  const ref =
    options.ref ??
    (event === "pull_request"
      ? "refs/pull/1/merge"
      : event === "merge_group"
        ? `refs/heads/gh-readonly-queue/${repo.defaultBranch}/pr-1-${options.sha}`
        : `refs/heads/${repo.defaultBranch}`);
  const runner = await mkdtemp(join(world.tmp, "runner-"));
  const files = {
    output: join(runner, "output"),
    summary: join(runner, "summary"),
    env: join(runner, "env"),
    state: join(runner, "state"),
    path: join(runner, "path"),
    event: join(runner, "event.json"),
    packageManagers: join(runner, "package-managers.log"),
  };
  await Promise.all([files.output, files.summary, files.env, files.state, files.path].map((file) => writeFile(file, "")));
  await packageManagerStubs(join(runner, "bin"), files.packageManagers);
  const headSha = event === "pull_request" ? await pullRequestHead(repo, options.sha) : undefined;
  const payload = options.eventPayload ?? eventPayload(event, repo, options, headSha ?? options.sha);
  await writeFile(files.event, JSON.stringify(payload));
  const base = cleanEnv(join(runner, "home"), world.serviceUrl);

  const env: Record<string, string> = {
    ...base,
    PATH: `${join(runner, "bin")}:${base.PATH}`,
    CI: "true",
    GITHUB_ACTIONS: "true",
    RUNNER_OS: "Linux",
    RUNNER_ARCH: "X64",
    RUNNER_TEMP: runner,
    GITHUB_WORKSPACE: options.workspace,
    GITHUB_REPOSITORY: repo.fullName,
    GITHUB_REPOSITORY_ID: String(repo.id),
    GITHUB_REPOSITORY_OWNER: repo.owner,
    GITHUB_REPOSITORY_OWNER_ID: String(repo.ownerId),
    GITHUB_SHA: options.sha,
    GITHUB_REF: ref,
    GITHUB_EVENT_NAME: event,
    GITHUB_EVENT_PATH: files.event,
    GITHUB_ACTOR: options.actor ?? "octocat",
    GITHUB_RUN_ID: "1",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_JOB: "test",
    GITHUB_WORKFLOW: "CI",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_API_URL: world.github.url,
    GITHUB_OUTPUT: files.output,
    GITHUB_STEP_SUMMARY: files.summary,
    GITHUB_ENV: files.env,
    GITHUB_STATE: files.state,
    GITHUB_PATH: files.path,
  };
  // The runner evaluates the `github-token` input's default, `${{ github.token }}`: the job's
  // GITHUB_TOKEN, read-only on a fork pull request.
  env["INPUT_GITHUB-TOKEN"] = world.github.jobToken(repo, { checks: options.checks !== false && !options.fork ? "write" : "read" });
  for (const [name, value] of Object.entries(options.inputs ?? {})) {
    env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] = value;
  }
  if (!options.fork && options.idToken !== false) {
    const job = world.github.oidc.startJob({
      repo,
      sha: options.sha,
      ref,
      eventName: event,
      actor: options.actor,
      enterpriseSlug: options.enterpriseSlug,
    });
    env.ACTIONS_ID_TOKEN_REQUEST_URL = job.requestUrl;
    env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = job.requestToken;
  }

  const result = await runNode(options.entry ?? paths.actionEntry, [], {
    cwd: options.workspace,
    env: options.env,
    baseEnv: env,
  });
  return {
    ...result,
    outputs: parseCommandFile(await readFile(files.output, "utf8")),
    summary: await readFile(files.summary, "utf8"),
    packageManagerCalls: (await readFile(files.packageManagers, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]),
  };
}

function eventPayload(event: string, repo: FakeRepo, options: RunActionOptions, headSha: string): unknown {
  const repository = { id: repo.id, full_name: repo.fullName, name: repo.name, owner: { login: repo.owner, id: repo.ownerId }, private: repo.visibility === "private", default_branch: repo.defaultBranch };
  if (event !== "pull_request") return { repository };
  const head = options.fork ? { full_name: `fork-owner/${repo.name}`, fork: true } : repository;
  return {
    action: "synchronize",
    number: 1,
    pull_request: { number: 1, head: { ref: "feature", sha: headSha, repo: head }, base: { ref: repo.defaultBranch, repo: repository } },
    repository,
  };
}

/** Parses `name=value` lines and `name<<DELIMITER` blocks, as the runner does. */
export function parseCommandFile(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const heredoc = /^([^=<]+)<<(.+)$/.exec(line);
    if (heredoc) {
      const value: string[] = [];
      while (++i < lines.length && lines[i] !== heredoc[2]) value.push(lines[i]!);
      result[heredoc[1]!] = value.join("\n");
      continue;
    }
    const eq = line.indexOf("=");
    if (eq > 0) result[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return result;
}
