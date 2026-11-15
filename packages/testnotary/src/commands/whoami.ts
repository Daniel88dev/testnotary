import { readStoredToken } from "../credentials.ts";
import { EXIT, Output, parseFlags, shortDate } from "../output.ts";
import { callService, ServiceUnreachable } from "../service.ts";
import { resolveServiceUrl, whoamiResponse } from "../shared.ts";
import type { Command } from "./command.ts";

export const whoami: Command = {
  summary: "print the account and token this machine uses",
  async run(args) {
    const { json, rest } = parseFlags(args);
    const out = new Output(json);
    if (rest.length > 0) {
      out.say(`whoami takes no arguments (got ${rest.join(" ")})`);
      return EXIT.usage;
    }
    const env = process.env;
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
      return EXIT.ok;
    } catch (error) {
      if (error instanceof ServiceUnreachable) return out.fail("service_unreachable", [`the Testnotary service could not be reached: ${error.message}`]);
      throw error;
    }
  },
};
