import type { DevicePollRequest, DevicePollResponse, DeviceStartResponse, GitHubDeniedCause } from "@testnotary/protocol";
import { database } from "../db/client.ts";
import { fetchUser, GitHubUnavailable, pollDeviceCode, requestDeviceCode } from "./github.ts";
import { authenticateToken, issueLaptopToken, rememberAccount, revokeToken } from "./tokens.ts";

// `testnotary login` on the service side: the device flow with the App's client id, then the
// `ghu_` token is swapped for a laptop token at once. The GitHub token is used for one `GET /user`
// and then dropped: it is never stored, logged or returned.

export async function startLogin(): Promise<DeviceStartResponse> {
  return requestDeviceCode();
}

export async function pollLogin(request: DevicePollRequest): Promise<DevicePollResponse> {
  let poll;
  try {
    poll = await pollDeviceCode(request.deviceCode);
  } catch (error) {
    if (error instanceof GitHubUnavailable) return failed("github_unavailable", `GitHub could not be reached: ${error.message}`);
    throw error;
  }
  if (poll.kind === "pending") return { status: "pending", slowDown: poll.slowDown, ...(poll.interval !== undefined ? { interval: poll.interval } : {}) };
  if (poll.kind === "ended") {
    return failed(poll.error, poll.error === "expired_token" ? "The sign-in code expired before it was entered." : "The sign-in was denied on GitHub.");
  }
  if (poll.kind === "error") return failed("github_unavailable", `GitHub refused the sign-in: ${poll.message}`);

  let user;
  try {
    user = await fetchUser(poll.accessToken);
  } catch (error) {
    if (error instanceof GitHubUnavailable) return failed("github_unavailable", `GitHub could not be reached: ${error.message}`);
    throw error;
  }
  if (user.kind === "denied") {
    return { status: "failed", error: "github_denied", cause: deniedCause(user.message), message: user.message };
  }

  const account = { id: user.id, login: user.login };
  return database().transaction(async (tx) => {
    await rememberAccount(tx, account);
    // One laptop token per machine: the one this machine held before is revoked.
    if (request.replaces) {
      const previous = await authenticateToken(tx, request.replaces);
      if (previous?.token.kind === "laptop") await revokeToken(tx, previous.token.id, "replaced");
    }
    const issued = await issueLaptopToken(tx, account, request.tokenName);
    return { status: "signed_in", token: issued.value, account, tokenInfo: issued.info };
  });
}

/** Why GitHub refused the person's token from the service's address, judged by its message. */
function deniedCause(message: string): GitHubDeniedCause {
  if (/IP allow list/i.test(message)) return "ip_allow_list";
  if (/conditional access|identity provider|\bIdP\b/i.test(message)) return "conditional_access";
  return "unknown";
}

function failed(error: "expired_token" | "access_denied" | "github_unavailable", message: string): DevicePollResponse {
  return { status: "failed", error, message };
}
