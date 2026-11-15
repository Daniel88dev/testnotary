// Output for the commands that are not runs (login, logout, whoami). Testnotary's own lines go to
// stderr through `say`; a command's answer goes to stdout; with `--json`, stdout carries exactly
// one object instead. A failure exits 1, the general error exit code (open decision 2), with a
// stable `error` code in the JSON.
import { EXIT, say } from "./report.ts";

export class Output {
  readonly json: boolean;

  constructor(json: boolean) {
    this.json = json;
  }

  /** A `testnotary:` line on stderr. */
  say(line: string): void {
    say(line);
  }

  /** The command's answer: a line for people on stdout, or the object with `--json`. */
  answer(line: string, object: unknown): void {
    process.stdout.write(`${this.json ? JSON.stringify(object) : line}\n`);
  }

  /** The `--json` object only; people already read the stderr lines. */
  result(object: unknown): void {
    if (this.json) process.stdout.write(`${JSON.stringify(object)}\n`);
  }

  /** A failure: its lines on stderr, `{ error, … }` on stdout with `--json`, and exit code 1. */
  fail(error: string, lines: string[], details: Record<string, unknown> = {}): number {
    for (const line of lines) say(line);
    this.result({ error, ...details });
    return EXIT.failed;
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `15 Nov 2026`, in local time. */
export function shortDate(date: Date): string {
  return `${date.getDate()} ${MONTHS[date.getMonth()]!} ${date.getFullYear()}`;
}
