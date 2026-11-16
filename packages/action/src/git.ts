import { execFile } from "node:child_process";

/** Git's trimmed stdout in the checkout, or undefined when it fails (no checkout, no such commit). */
export function git(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" }, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) =>
      resolve(error ? undefined : stdout.trim()),
    );
  });
}
