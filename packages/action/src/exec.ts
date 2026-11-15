import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TestsRan } from "./pr-line.ts";
import type { RunnerEnv } from "./runner.ts";
import { CONFIG_FILE, parseConfig, suiteNames, type JobOutcome } from "./shared.ts";

// Running the suite on the runner: always through the repo's own installed library
// (`testnotary exec`), which applies the stripped environment. The action never runs the suite's
// command itself, so when the library can't be found the step fails with a setup error instead.

/** How the workspace's package manager runs a locally installed bin, per `packageManager` in `package.json`. */
export function libraryCommand(workspace: string): { tool: string; argv: string[] } {
  const name = packageManagerName(workspace);
  if (name === "yarn") return { tool: "yarn", argv: ["yarn", "testnotary"] };
  if (name === "pnpm") return { tool: "pnpm", argv: ["pnpm", "exec", "testnotary"] };
  // npm, a package manager the action doesn't know, or none named.
  return { tool: "npx", argv: ["npx", "--no-install", "testnotary"] };
}

function packageManagerName(workspace: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(workspace, "package.json"), "utf8")) as { packageManager?: unknown };
    return typeof pkg.packageManager === "string" ? pkg.packageManager.split("@")[0]?.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The suite `exec` runs: the one the job named, else the one its verification found, else the
 * checked-out config's only suite. Undefined when none of these names one.
 */
export function suiteToRun(workspace: string, named: string | null, verified: string | null | undefined): string | undefined {
  if (named) return named;
  if (verified) return verified;
  try {
    const parsed = parseConfig(readFileSync(join(workspace, CONFIG_FILE), "utf8"));
    if (!parsed.ok) return undefined;
    const names = suiteNames(parsed.config);
    return names.length === 1 ? names[0] : undefined;
  } catch {
    return undefined;
  }
}

export type ExecResult = ({ kind: "ran" } & TestsRan) | { kind: "library_not_found"; command: string };

/** Runs `testnotary exec <suite> --json` through the package manager, after checking the library answers. */
export async function execSuite(env: RunnerEnv, workspace: string, suite: string): Promise<ExecResult> {
  const { argv } = libraryCommand(workspace);
  const childEnv = libraryEnv(env);
  const probe = await spawnCollect(argv, ["--version"], workspace, childEnv, "ignore");
  if (probe.exitCode !== 0 || !/(^|\n)testnotary \S+/.test(probe.stdout)) return { kind: "library_not_found", command: argv.join(" ") };

  const started = Date.now();
  const run = await spawnCollect(argv, ["exec", suite, "--json"], workspace, childEnv, "inherit");
  const report = lastJsonObject(run.stdout);
  const exitCode = typeof report?.exitCode === "number" ? report.exitCode : (run.exitCode ?? 1);
  const outcome: JobOutcome =
    report?.outcome === "passed" || report?.outcome === "failed" || report?.outcome === "refused" ? report.outcome : exitCode === 0 ? "passed" : "failed";
  const durationMs = typeof report?.durationMs === "number" ? report.durationMs : Date.now() - started;
  return { kind: "ran", outcome, exitCode: outcome === "refused" ? (run.exitCode ?? 2) : exitCode, durationMs };
}

/**
 * The environment the package manager and the library start with: the step's own, minus the
 * action's inputs (the GitHub token among them) and the runner's OIDC request credentials. The
 * library strips the rest before the tests start.
 */
function libraryEnv(env: RunnerEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || name.startsWith("INPUT_") || name.startsWith("ACTIONS_ID_TOKEN_REQUEST_")) continue;
    result[name] = value;
  }
  return result;
}

function spawnCollect(
  argv: string[],
  args: string[],
  cwd: string,
  env: Record<string, string>,
  stderr: "ignore" | "inherit",
): Promise<{ exitCode: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(argv[0]!, [...argv.slice(1), ...args], { cwd, env, stdio: ["ignore", "pipe", stderr] });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.on("error", () => resolve({ exitCode: null, stdout }));
    child.on("close", (exitCode) => resolve({ exitCode, stdout }));
  });
}

/** The `--json` object `exec` prints last on stdout, if it printed one. */
function lastJsonObject(text: string): Record<string, unknown> | undefined {
  const lines = text.trimEnd().split("\n").reverse();
  for (const line of lines) {
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === "object" && "outcome" in value) return value as Record<string, unknown>;
    } catch {
      // not the report line
    }
  }
  return undefined;
}
