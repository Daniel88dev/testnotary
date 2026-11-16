import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");

export interface ScriptResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Runs a command as its own process; a non-zero exit is a result, not a throw. */
export function run(file: string, args: string[], options: { cwd?: string; env?: Record<string, string | undefined>; timeoutMs?: number } = {}): Promise<ScriptResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { cwd: options.cwd ?? repoRoot, env: { ...process.env, ...options.env }, timeout: options.timeoutMs ?? 120_000, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") return reject(error);
        resolve({ exitCode: error ? (error.code as number) : 0, stdout, stderr });
      },
    );
  });
}

/** Runs one of the release scripts (`scripts/release/<name>.ts`) the way the release job does. */
export function releaseScript(name: string, args: string[] = [], options: { cwd?: string; env?: Record<string, string | undefined> } = {}): Promise<ScriptResult> {
  return run(process.execPath, [join(repoRoot, "scripts/release", `${name}.ts`), ...args], options);
}

/** A temporary directory, removed by the returned cleanup. */
export async function scratch(prefix: string): Promise<{ dir: string; remove: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), `${prefix}-`));
  return { dir, remove: () => rm(dir, { recursive: true, force: true }) };
}
