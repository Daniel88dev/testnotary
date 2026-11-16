// `testnotary check [suite]`: everything `run` does before it starts the command (every refusal
// check, the warnings and the service preflight), then it stops. It starts nothing and uploads
// nothing. Exits 0 when nothing would refuse a run, 2 when something would.
import { UsageError, parseCommandArgs, type Command } from "../command.ts";
import { EXIT, say } from "../report.ts";
import { prepareRun } from "../run/prepare.ts";
import { resolveServiceUrl, type RefusalCode } from "../shared.ts";
import { commandNotFoundLine, findProgram } from "../suite-command.ts";

/** The `--json` object: what a run would meet, without its outcome (nothing ran). */
interface CheckReport {
  suite: string;
  refusal: RefusalCode | null;
  /** Whether a passing run would be attested: no refusal, and the service said yes. */
  attestable: boolean;
  tree: string | null;
  commit: string | null;
  warnings: string[];
}

export const check: Command = {
  name: "check",
  usage: "check [suite] [--base <branch>] [--json]",
  summary: "Run every refusal check and the service preflight, without running the suite.",
  async run(args, context) {
    const { flags, options, positionals, afterTerminator } = parseCommandArgs(args, [], ["base"]);
    if (positionals.length > 1) throw new UsageError(`unexpected argument ${JSON.stringify(positionals[1])}`);

    const prepared = await prepareRun({
      cwd: context.cwd,
      env: context.env,
      serviceUrl: resolveServiceUrl(context.env),
      suite: positionals[0],
      base: options.base,
      extraArguments: afterTerminator,
    });

    if (prepared.kind === "refused") {
      for (const line of prepared.lines) say(line);
      return end(
        {
          suite: prepared.suite ?? "",
          refusal: prepared.refusal,
          attestable: false,
          tree: prepared.checkout?.tree ?? null,
          commit: prepared.checkout?.commit ?? null,
          warnings: prepared.notes.warnings,
        },
        flags.json,
      );
    }

    const { context: run, preflight } = prepared;
    const report: CheckReport = {
      suite: run.suite.name,
      refusal: null,
      attestable: preflight.kind === "ok",
      tree: run.checkout.tree,
      commit: run.checkout.commit,
      warnings: run.notes.warnings,
    };
    // `run` finds this out as it starts the command; `check` looks the program up the same way.
    const program = run.suite.command[0]!;
    if (!(await findProgram(program, run.root, run.env.PATH))) {
      say(commandNotFoundLine(program));
      return end({ ...report, refusal: "command_not_found", attestable: false }, flags.json);
    }
    return end(report, flags.json, preflight.kind === "ok" ? preflight.answer : undefined);
  },
};

function end(report: CheckReport, json: boolean, attester?: { account: { login: string }; token: { kind: string; name: string } }): number {
  const name = report.suite || "(no suite)";
  if (report.refusal) {
    say(`check ${name}: a run would be refused (${report.refusal})`);
  } else if (attester) {
    say(`check ${name}: no refusal; a run would attest as @${attester.account.login} with ${attester.token.kind} token "${attester.token.name}"`);
  } else {
    say(`check ${name}: no refusal; a run would not be attested (${report.warnings.join(", ")})`);
  }
  if (json) process.stdout.write(`${JSON.stringify(report)}\n`);
  return report.refusal ? EXIT.refused : EXIT.passed;
}
