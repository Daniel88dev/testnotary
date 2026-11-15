// Spawning a suite's declared argv in the stripped environment. Shared by `exec` and `run`.
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, rm, stat } from "node:fs/promises";
import { constants as osConstants, tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { strippedEnvironment, type Suite } from "./shared.ts";

export interface SuiteCommandOptions {
  suite: Suite;
  /** The checked-out tree; the command runs here. */
  cwd: string;
  /** The shell's environment, which the stripped environment is built from. */
  shell: Readonly<Record<string, string | undefined>>;
  /** With `--json`, the child's stdout goes to stderr so stdout carries only the object. */
  stdoutToStderr: boolean;
}

export type SuiteCommandResult =
  | { kind: "command_not_found"; program: string }
  | { kind: "exited"; exitCode: number; durationMs: number };

const FORWARDED_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

/**
 * Spawns the suite's argv with no shell, in the stripped environment with a fresh scratch `HOME`
 * that is deleted afterwards. Output passes through untouched. A program that can't be found on
 * `PATH` (or at its path) is reported before anything starts. A child killed by a signal reports
 * 128 + the signal number, as shells do.
 */
export async function runSuiteCommand(options: SuiteCommandOptions): Promise<SuiteCommandResult> {
  const [program, ...args] = options.suite.command as [string, ...string[]];
  if (!(await findProgram(program, options.cwd, options.shell.PATH))) return { kind: "command_not_found", program };

  const home = await mkdtemp(join(tmpdir(), "testnotary-home-"));
  try {
    const env = strippedEnvironment(options.shell, { home, env: options.suite.env });
    const started = performance.now();
    const child = spawn(program, args, {
      cwd: options.cwd,
      env,
      shell: false,
      stdio: ["inherit", options.stdoutToStderr ? 2 : "inherit", "inherit"],
    });
    const forward = (signal: NodeJS.Signals) => child.kill(signal);
    for (const signal of FORWARDED_SIGNALS) process.on(signal, forward);
    try {
      return await new Promise<SuiteCommandResult>((resolvePromise, reject) => {
        child.on("error", (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT" || error.code === "EACCES") resolvePromise({ kind: "command_not_found", program });
          else reject(error);
        });
        child.on("close", (code, signal) => {
          const exitCode = code ?? 128 + (signal ? (osConstants.signals[signal] ?? 0) : 0);
          resolvePromise({ kind: "exited", exitCode, durationMs: Math.round(performance.now() - started) });
        });
      });
    } finally {
      for (const signal of FORWARDED_SIGNALS) process.off(signal, forward);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

/** Whether `program` resolves to an executable file: as a path when it has a slash, else on `PATH`. */
async function findProgram(program: string, cwd: string, path: string | undefined): Promise<boolean> {
  if (program.includes("/")) return isExecutableFile(isAbsolute(program) ? program : resolve(cwd, program));
  for (const dir of (path ?? "").split(delimiter)) {
    if (dir === "") continue;
    if (await isExecutableFile(join(resolve(cwd, dir), program))) return true;
  }
  return false;
}

async function isExecutableFile(file: string): Promise<boolean> {
  try {
    await access(file, fsConstants.X_OK);
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}
