import { z } from "zod";
import { forgetToken, readStoredToken } from "../credentials.ts";
import { EXIT, Output, parseFlags } from "../output.ts";
import { callService, ServiceUnreachable } from "../service.ts";
import { resolveServiceUrl, tokenInfo } from "../shared.ts";
import type { Command } from "./command.ts";

const revoked = z.object({ revoked: tokenInfo });

export const logout: Command = {
  summary: "revoke this machine's laptop token and forget it",
  async run(args) {
    const { json, rest } = parseFlags(args);
    const out = new Output(json);
    if (rest.length > 0) {
      out.say(`logout takes no arguments (got ${rest.join(" ")})`);
      return EXIT.usage;
    }
    const env = process.env;
    const serviceUrl = resolveServiceUrl(env);
    const token = await readStoredToken(serviceUrl, env);
    if (!token) {
      out.say("not signed in");
      out.result({ signedOut: true, revoked: null });
      return EXIT.ok;
    }
    try {
      const answer = await callService(serviceUrl, "/tokens/current", revoked, { method: "DELETE", token });
      if (answer.status === 401) {
        // Already revoked or expired: nothing left to revoke, so only forget it.
        await forgetToken(serviceUrl, env);
        out.say("signed out; the laptop token had already been revoked or had expired");
        out.result({ signedOut: true, revoked: null });
        return EXIT.ok;
      }
      if (!answer.body) return out.fail("service_error", [`the service answered ${answer.status}; the token is still kept here, try again`]);
      await forgetToken(serviceUrl, env);
      out.say(`signed out; laptop token "${answer.body.revoked.name}" revoked`);
      out.result({ signedOut: true, revoked: answer.body.revoked });
      return EXIT.ok;
    } catch (error) {
      if (error instanceof ServiceUnreachable) {
        // Keep the token so that a retry can still revoke it.
        return out.fail("service_unreachable", [`the Testnotary service could not be reached, so the token was not revoked and is still kept here: ${error.message}`]);
      }
      throw error;
    }
  },
};
