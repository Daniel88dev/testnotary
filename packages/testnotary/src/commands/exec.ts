// `testnotary exec <suite>`: runs a declared suite exactly as CI will, without a service. It reads
// `testnotary.json` from the checked-out tree, fetches nothing, needs no token, uploads nothing and
// never attests. It checks only `config_invalid` and `command_not_found`.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { UsageError, parseCommandArgs, type Command } from "../command.ts";
import { readCheckout } from "../git.ts";
import { finish, say, type RunReport } from "../report.ts";
import { CONFIG_FILE, parseConfig, suiteFromConfig, suiteNames, type RefusalCode } from "../shared.ts";
import { displayArgv, runSuiteCommand } from "../suite-command.ts";

export const exec: Command = {
  name: "exec",
  usage: "exec <suite> [--json]",
  summary: "Run a suite from the checked-out testnotary.json in the stripped environment, without attesting.",
  async run(args, context) {
    const { flags, positionals, afterTerminator } = parseCommandArgs(args, []);
    if (afterTerminator.length > 0) throw new UsageError("exec takes no arguments after --; the suite's command is declared in testnotary.json");
    if (positionals.length !== 1) throw new UsageError(positionals.length === 0 ? "name the suite to run" : `unexpected argument ${JSON.stringify(positionals[1])}`);
    const suiteName = positionals[0]!;

    const checkout = await readCheckout(context.cwd, context.env);
    const report = (fields: Partial<RunReport> & Pick<RunReport, "outcome">): number =>
      finish(
        {
          suite: suiteName,
          refusal: null,
          exitCode: null,
          attested: false,
          attestationUrl: null,
          tree: checkout.tree,
          commit: checkout.commit,
          durationMs: 0,
          warnings: [],
          ...fields,
        },
        { json: flags.json },
      );
    const refuse = (refusal: RefusalCode, lines: string[]): number => {
      for (const line of lines) say(line);
      return report({ outcome: "refused", refusal });
    };

    let text: string;
    try {
      text = await readFile(join(checkout.root, CONFIG_FILE), "utf8");
    } catch {
      return refuse("config_invalid", [`no ${CONFIG_FILE} in ${checkout.root}; run \`testnotary init\` to write one`]);
    }
    const parsed = parseConfig(text);
    if (!parsed.ok) return refuse("config_invalid", [`${CONFIG_FILE} is not valid:`, ...parsed.problems.map((problem) => `  ${problem}`)]);
    const suite = suiteFromConfig(parsed.config, suiteName);
    if (!suite) {
      return refuse("config_invalid", [`${CONFIG_FILE} declares no suite ${JSON.stringify(suiteName)}; it declares: ${suiteNames(parsed.config).join(", ")}`]);
    }

    say(`exec ${suite.name}: ${displayArgv(suite.command)}`);
    const result = await runSuiteCommand({ suite, cwd: checkout.root, shell: context.env, stdoutToStderr: flags.json });
    if (result.kind === "command_not_found") {
      return refuse("command_not_found", [
        `${result.program} was not found${result.program.includes("/") ? "" : " on PATH"}; install it, or point the command at a package.json script`,
      ]);
    }
    const passed = result.exitCode === 0;
    say(passed ? `suite ${suite.name} passed; exec never attests` : `suite ${suite.name} failed with exit code ${result.exitCode}`);
    return report({ outcome: passed ? "passed" : "failed", exitCode: result.exitCode, durationMs: result.durationMs });
  },
};
