import { setTimeout as sleep } from "node:timers/promises";
import { storeToken, readStoredToken } from "../credentials.ts";
import { EXIT, Output, parseFlags, shortDate } from "../output.ts";
import { sandboxMarker } from "../sandbox.ts";
import { callService, ServiceUnreachable } from "../service.ts";
import { LINKS, deviceStartResponse, devicePollResponse, resolveServiceUrl, type DevicePollRequest, type GitHubDeniedCause } from "../shared.ts";
import type { Command } from "./command.ts";

/** "<OS> machine, <date>": the laptop token's default name, never the hostname. */
export function laptopTokenName(platform: NodeJS.Platform, date: Date): string {
  const os = platform === "darwin" ? "macOS" : platform === "linux" ? "Linux" : platform;
  return `${os} machine, ${shortDate(date)}`;
}

const DENIED_HELP: Record<GitHubDeniedCause, string> = {
  ip_allow_list: "Testnotary has no fixed IP addresses, so GitHub IP allow lists are not supported in v1.",
  conditional_access: "Your identity provider's conditional access policy blocks sign-ins through the Testnotary service.",
  unknown: "GitHub refused the sign-in through the Testnotary service.",
};

export const login: Command = {
  summary: "sign this machine in with GitHub and keep a laptop token",
  async run(args) {
    const { json, rest } = parseFlags(args);
    const out = new Output(json);
    if (rest.length > 0) {
      out.say(`login takes no arguments (got ${rest.join(" ")})`);
      return EXIT.usage;
    }
    const env = process.env;
    const marker = sandboxMarker(env);
    if (marker) {
      return out.fail(
        "login_in_sandbox",
        [`login is refused in an agent sandbox (${marker} is set): use a sandbox token instead, see ${LINKS.sandboxTokens}`],
        { marker, docsUrl: LINKS.sandboxTokens },
      );
    }
    const serviceUrl = resolveServiceUrl(env);
    out.say(`by signing in you agree to the Terms (${LINKS.terms}) and accept the Privacy policy (${LINKS.privacy})`);

    try {
      const started = await callService(serviceUrl, "/login/device", deviceStartResponse, { method: "POST" });
      if (!started.body) return serviceFailure(out, started.raw);
      const device = started.body;
      out.say(`open ${device.verificationUri} and enter ${device.userCode}`);

      const request: DevicePollRequest = { deviceCode: device.deviceCode, tokenName: laptopTokenName(process.platform, new Date()) };
      const previous = await readStoredToken(serviceUrl, env);
      if (previous) request.replaces = previous;

      let interval = device.interval;
      const deadline = Date.now() + device.expiresIn * 1000;
      while (Date.now() < deadline) {
        await sleep(interval * 1000);
        const polled = await callService(serviceUrl, "/login/poll", devicePollResponse, { method: "POST", body: request });
        if (!polled.body) return serviceFailure(out, polled.raw);
        const answer = polled.body;
        if (answer.status === "pending") {
          if (answer.slowDown) interval = answer.interval ?? interval + 5;
          continue;
        }
        if (answer.status === "failed") {
          if (answer.error === "github_denied") {
            const cause = answer.cause ?? "unknown";
            return out.fail(
              "github_denied",
              [`GitHub refused the sign-in: ${answer.message}`, `${DENIED_HELP[cause]} See ${LINKS.githubEnterpriseLimits}`],
              { cause, message: answer.message, docsUrl: LINKS.githubEnterpriseLimits },
            );
          }
          return out.fail(answer.error, [answer.message], { message: answer.message });
        }
        const storage = await storeToken(serviceUrl, answer.token, env);
        if (storage === "file") out.say("no usable keychain on this machine: the laptop token is in a file only you can read");
        out.say(`signed in as @${answer.account.login} (laptop token "${answer.tokenInfo.name}")`);
        out.result({ account: answer.account, token: answer.tokenInfo, storage });
        return EXIT.ok;
      }
      return out.fail("expired_token", ["The sign-in code expired before it was entered."]);
    } catch (error) {
      if (error instanceof ServiceUnreachable) {
        return out.fail("service_unreachable", [`the Testnotary service could not be reached: ${error.message}`]);
      }
      throw error;
    }
  },
};

function serviceFailure(out: Output, raw: unknown): number {
  const error = (raw as { error?: unknown } | undefined)?.error;
  const code = typeof error === "string" ? error : "service_error";
  const message = (raw as { message?: unknown } | undefined)?.message;
  return out.fail(code, [`the service could not start the sign-in (${code})${typeof message === "string" ? `: ${message}` : ""}`]);
}
