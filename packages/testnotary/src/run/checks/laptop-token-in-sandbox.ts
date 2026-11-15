import { LINKS } from "../../shared.ts";
import { sandboxMarker } from "../../sandbox.ts";
import type { Env, RunCheck, RunToken } from "../context.ts";

/** The sandbox marker present when `token` is a laptop token, or undefined. */
export function laptopTokenMarker(token: RunToken | undefined, env: Env): string | undefined {
  return token?.value.startsWith("tnl_") ? sandboxMarker(env) : undefined;
}

/**
 * `laptop_token_in_sandbox`: `TESTNOTARY_TOKEN` holds a laptop token (`tnl_`) while a sandbox
 * marker is present. A person's own token never attests for an agent, and there is no override.
 * The run is not uploaded either, so the token never reaches the service from the sandbox.
 * (`chooseToken` already leaves the stored laptop token alone inside a sandbox.)
 */
export const laptopTokenInSandbox: RunCheck = {
  name: "laptop_token_in_sandbox",
  async check(context) {
    const marker = laptopTokenMarker(context.token, context.env);
    if (!marker) return undefined;
    return {
      refusal: "laptop_token_in_sandbox",
      lines: [
        `TESTNOTARY_TOKEN holds a laptop token, and this is an agent sandbox (${marker} is set)`,
        `a laptop token never attests from a sandbox: create a sandbox token for the repo in the dashboard and set it as TESTNOTARY_TOKEN instead, see ${LINKS.sandboxTokens}`,
      ],
      upload: false,
    };
  },
};
