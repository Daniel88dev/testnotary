import { z } from "zod";
import { forgetToken, readStoredToken } from "../credentials.ts";
import { UsageError, parseCommandArgs, type Command } from "../command.ts";
import { Output } from "../output.ts";
import { EXIT } from "../report.ts";
import { callService, ServiceUnreachable } from "../service.ts";
import { resolveServiceUrl, tokenInfo } from "../shared.ts";

const revoked = z.object({ revoked: tokenInfo });

export const logout: Command = {
  name: "logout",
  usage: "logout [--json]",
  summary: "Revoke this machine's laptop token on the service and forget it here.",
  async run(args, context) {
    const { flags, positionals } = parseCommandArgs(args, []);
    if (positionals.length > 0) throw new UsageError("logout takes no arguments");
    const out = new Output(flags.json);
    const env = context.env;
    const serviceUrl = resolveServiceUrl(env);
    const token = await readStoredToken(serviceUrl, env);
    if (!token) {
      out.say("not signed in");
      out.result({ signedOut: true, revoked: null });
      return EXIT.passed;
    }
    try {
      const answer = await callService(serviceUrl, "/tokens/current", revoked, { method: "DELETE", token });
      if (answer.status === 401) {
        // Already revoked or expired: nothing left to revoke, so only forget it.
        await forgetToken(serviceUrl, env);
        out.say("signed out; the laptop token had already been revoked or had expired");
        out.result({ signedOut: true, revoked: null });
        return EXIT.passed;
      }
      if (!answer.body) return out.fail("service_error", [`the service answered ${answer.status}; the token is still kept here, try again`]);
      await forgetToken(serviceUrl, env);
      out.say(`signed out; laptop token "${answer.body.revoked.name}" revoked`);
      out.result({ signedOut: true, revoked: answer.body.revoked });
      return EXIT.passed;
    } catch (error) {
      if (error instanceof ServiceUnreachable) {
        // Keep the token so that a retry can still revoke it.
        return out.fail("service_unreachable", [`the Testnotary service could not be reached, so the token was not revoked and is still kept here: ${error.message}`]);
      }
      throw error;
    }
  },
};
