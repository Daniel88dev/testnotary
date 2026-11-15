// How commands talk: Testnotary's own lines go to stderr with a `testnotary:` prefix; a command's
// answer goes to stdout; with `--json`, stdout carries exactly one JSON object instead.

export const EXIT = {
  ok: 0,
  /** The general error exit code (open decision 2): the stable error code is in the JSON. */
  failed: 1,
  refused: 2,
  usage: 64,
  interrupted: 130,
} as const;

export class Output {
  readonly json: boolean;

  constructor(json: boolean) {
    this.json = json;
  }

  /** A `testnotary:` line on stderr. */
  say(line: string): void {
    process.stderr.write(`testnotary: ${line}\n`);
  }

  /** The command's answer: a line for people on stdout, or the object with `--json`. */
  answer(line: string, object: unknown): void {
    if (this.json) process.stdout.write(`${JSON.stringify(object)}\n`);
    else process.stdout.write(`${line}\n`);
  }

  /** The `--json` object only; people already read the stderr lines. */
  result(object: unknown): void {
    if (this.json) process.stdout.write(`${JSON.stringify(object)}\n`);
  }

  /** A failure: its lines on stderr, `{ error, … }` on stdout with `--json`, and exit code 1. */
  fail(error: string, lines: string[], details: Record<string, unknown> = {}): number {
    for (const line of lines) this.say(line);
    this.result({ error, ...details });
    return EXIT.failed;
  }
}

/** Splits a command's own arguments into `--json` and the rest. */
export function parseFlags(args: string[]): { json: boolean; rest: string[] } {
  const rest = args.filter((arg) => arg !== "--json");
  return { json: rest.length !== args.length, rest };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `15 Nov 2026`, in local time unless told otherwise. */
export function shortDate(date: Date, utc = false): string {
  const day = utc ? date.getUTCDate() : date.getDate();
  const month = utc ? date.getUTCMonth() : date.getMonth();
  const year = utc ? date.getUTCFullYear() : date.getFullYear();
  return `${day} ${MONTHS[month]!} ${year}`;
}
