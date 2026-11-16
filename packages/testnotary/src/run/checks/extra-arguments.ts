import { displayArgv } from "../../suite-command.ts";
import type { RunCheck } from "../context.ts";

/**
 * `extra_arguments`: anything after `--` on the command line. The suite runs exactly the argv the
 * base config declares, so an argument that narrows it (a test file, `--grep`, `--only`) never
 * reaches the command.
 */
export const extraArguments: RunCheck = {
  name: "extra_arguments",
  async check(context) {
    if (context.extraArguments.length === 0) return undefined;
    return {
      refusal: "extra_arguments",
      lines: [
        `anything after -- is refused (${displayArgv(context.extraArguments)}): the suite runs exactly the command testnotary.json on ${context.base.ref} declares (${displayArgv(context.suite.command)})`,
        "to run less, declare another suite on the base branch and name it: testnotary run <suite>",
      ],
    };
  },
};
