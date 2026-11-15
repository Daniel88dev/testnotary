import { readStoredToken } from "../credentials.ts";
import { UsageError, parseCommandArgs, type Command } from "../command.ts";
import { Output, shortDate } from "../output.ts";
import { EXIT } from "../report.ts";
import { callService, ServiceUnreachable } from "../service.ts";
import { resolveServiceUrl, whoamiResponse } from "../shared.ts";

export const whoami: Command = {
  name: "whoami",
  usage: "whoami [--json]",
  summary: "Print the account and the token this machine uses.",
  async run(args, context) {
    const { flags, positionals } = parseCommandArgs(args, []);
    if (positionals.length > 0) throw new UsageError("whoami takes no arguments");
    const out = new Output(flags.json);
    const env = context.env;
    const serviceUrl = resolveServiceUrl(env);
    // TESTNOTARY_TOKEN is the token every command uses when it is set, as it is in a sandbox.
    const token = env.TESTNOTARY_TOKEN || (await readStoredToken(serviceUrl, env));
    if (!token) return out.fail("not_signed_in", ["not signed in: run `testnotary login`, or set TESTNOTARY_TOKEN to a sandbox token"]);
    try {
      const answer = await callService(serviceUrl, "/whoami", whoamiResponse, { token });
      if (answer.status === 401) {
        return out.fail("token_rejected", ["the token was rejected (revoked or expired): run `testnotary login`"]);
      }
      if (!answer.body) return out.fail("service_error", [`the service answered ${answer.status}`]);
      const { account, token: info } = answer.body;
      out.answer(`@${account.login} · ${info.kind} token "${info.name}" · expires ${shortDate(new Date(info.expiresAt))}`, answer.body);
      return EXIT.passed;
    } catch (error) {
      if (error instanceof ServiceUnreachable) return out.fail("service_unreachable", [`the Testnotary service could not be reached: ${error.message}`]);
      throw error;
    }
  },
};
