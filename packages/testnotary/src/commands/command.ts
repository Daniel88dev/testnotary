/** One `testnotary <name>` command. It parses its own arguments and returns the exit code. */
export interface Command {
  /** One line for the usage text. */
  summary: string;
  run(args: string[]): Promise<number>;
}
