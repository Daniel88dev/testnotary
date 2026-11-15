// What every CLI command looks like. Each command lives in its own file under `commands/` and is
// listed once in `commands/index.ts`.
import { parseArgs } from "node:util";

export interface CommandContext {
  /** Where the user ran `testnotary`. */
  cwd: string;
  /** The shell's environment. */
  env: Readonly<Record<string, string | undefined>>;
}

export interface Command {
  name: string;
  /** One line, without the leading `testnotary `, e.g. `exec <suite> [--json]`. */
  usage: string;
  /** One sentence for `--help`. */
  summary: string;
  /** Returns the process exit code. Throw `UsageError` for exit 64. */
  run(args: string[], context: CommandContext): Promise<number>;
}

/** A command line the command can't make sense of: exit 64 with the usage line. */
export class UsageError extends Error {}

export interface ParsedArgs<Flags extends string, Options extends string = never> {
  flags: Record<Flags, boolean>;
  /** Options that take a value (`--base main` or `--base=main`); undefined when not given. */
  options: Record<Options, string | undefined>;
  positionals: string[];
  /** Everything after a bare `--`, which `run` refuses as `extra_arguments`. */
  afterTerminator: string[];
}

/**
 * Parses a command's own arguments: boolean flags (`--json` is always accepted), options with a
 * value, and positionals. Unknown flags and a missing option value are usage errors.
 */
export function parseCommandArgs<Flags extends string, Options extends string = never>(
  args: string[],
  flags: readonly Flags[],
  options: readonly Options[] = [],
): ParsedArgs<Flags | "json", Options> {
  const names = [...new Set<Flags | "json">([...flags, "json"])];
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        ...Object.fromEntries(names.map((name) => [name, { type: "boolean" as const }])),
        ...Object.fromEntries(options.map((name) => [name, { type: "string" as const }])),
      },
      allowPositionals: true,
      strict: true,
      tokens: true,
    });
  } catch (error) {
    const unknown = /Unknown option '([^']+)'/.exec((error as Error).message);
    throw new UsageError(unknown ? `unknown option ${unknown[1]}` : (error as Error).message);
  }
  const terminator = parsed.tokens.find((token) => token.kind === "option-terminator");
  const afterTerminator = terminator ? args.slice(terminator.index + 1) : [];
  const positionals = parsed.positionals.slice(0, parsed.positionals.length - afterTerminator.length);
  const values = parsed.values as Record<string, boolean | string | undefined>;
  const result = Object.fromEntries(names.map((name) => [name, values[name] === true])) as Record<Flags | "json", boolean>;
  const optionValues = Object.fromEntries(options.map((name) => [name, typeof values[name] === "string" ? values[name] : undefined])) as Record<
    Options,
    string | undefined
  >;
  return { flags: result, options: optionValues, positionals, afterTerminator };
}
