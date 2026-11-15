import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";

// The runner's file commands and inputs, as @actions/core reads and writes them, without the
// dependency.

export type RunnerEnv = Readonly<Record<string, string | undefined>>;

/** An action input (`INPUT_<NAME>`), trimmed; empty when not given. */
export function input(env: RunnerEnv, name: string): string {
  return (env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();
}

/** Writes step outputs to `GITHUB_OUTPUT`, each in the delimited form so any value is safe. */
export function setOutputs(env: RunnerEnv, outputs: Record<string, string>): void {
  const file = env.GITHUB_OUTPUT;
  if (!file) return;
  let text = "";
  for (const [name, value] of Object.entries(outputs)) {
    const delimiter = `ghadelimiter_${randomBytes(8).toString("hex")}`;
    text += `${name}<<${delimiter}\n${value}\n${delimiter}\n`;
  }
  appendFileSync(file, text);
}

/** Appends Markdown to the job summary (`GITHUB_STEP_SUMMARY`). */
export function appendSummary(env: RunnerEnv, markdown: string): void {
  const file = env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, markdown.endsWith("\n") ? markdown : `${markdown}\n`);
}

/** A workflow command on stdout, e.g. `::warning::…`. */
export function command(name: "notice" | "warning" | "error", message: string): void {
  const escaped = message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  process.stdout.write(`::${name}::${escaped}\n`);
}
