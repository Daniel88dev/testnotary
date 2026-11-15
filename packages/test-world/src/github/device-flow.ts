import { randomBytes } from "node:crypto";
import type { FakeAccount } from "./app.ts";

// GitHub's OAuth device flow for the App (NOTES/github-behaviours.md §11): a device code, then
// polling for the user token. Nobody types the code into a browser in tests; instead a test plans
// what happens to the next device code: who approves it, after how many pending polls and
// slow_downs, or that the person denies it.

export interface DevicePlan {
  /** Who approves the code. Absent: the code stays pending until it expires. */
  user?: FakeAccount;
  deny?: boolean;
  /** Polls answered `authorization_pending` before the outcome. */
  pending: number;
  /** Polls answered `slow_down` (each raising the interval) before the pending ones. */
  slowDown: number;
}

export interface IssuedDeviceCode {
  deviceCode: string;
  /** What the person enters at github.com/login/device, e.g. `8F3C-21DA`. */
  userCode: string;
  clientId: string;
  interval: number;
  expiresAt: number;
  plan: DevicePlan | undefined;
  /** The `ghu_` token handed out once the code was approved. */
  accessToken?: string;
}

export type PollAnswer = Record<string, string | number>;

export class DeviceFlow {
  /** Seconds between polls GitHub asks for. GitHub says 5; the fake says 0 so tests run fast. */
  interval = 0;
  /** Seconds a `slow_down` adds. GitHub adds 5; the fake adds 1. */
  slowDownSeconds = 1;
  /** Lifetime of a device code: 900 s on GitHub. */
  expiresIn = 900;
  /** Every device code handed out, oldest first. */
  readonly issued: IssuedDeviceCode[] = [];
  /** User tokens (`ghu_…`) handed out, and whose they are. */
  readonly userTokens = new Map<string, FakeAccount>();
  private readonly plans: DevicePlan[] = [];

  /** The next device code is approved by `user`, after `pending` and `slowDown` polls. */
  approveNext(user: FakeAccount, options: { pending?: number; slowDown?: number } = {}): void {
    this.plans.push({ user, pending: options.pending ?? 0, slowDown: options.slowDown ?? 0 });
  }

  /** The person denies the next device code on GitHub (`access_denied`). */
  denyNext(options: { pending?: number } = {}): void {
    this.plans.push({ deny: true, pending: options.pending ?? 0, slowDown: 0 });
  }

  start(clientId: string): IssuedDeviceCode {
    const code: IssuedDeviceCode = {
      deviceCode: randomBytes(20).toString("hex"),
      userCode: `${hex(2)}-${hex(2)}`,
      clientId,
      interval: this.interval,
      expiresAt: Date.now() + this.expiresIn * 1000,
      plan: this.plans.shift(),
    };
    this.issued.push(code);
    return code;
  }

  /** One poll of `login/oauth/access_token`. GitHub answers 200 with `error` while not done. */
  poll(clientId: string, deviceCode: string): PollAnswer {
    const code = this.issued.find((candidate) => candidate.deviceCode === deviceCode && candidate.clientId === clientId);
    if (!code || code.accessToken) return oauthError("incorrect_device_code", "The device_code provided is not valid.");
    if (Date.now() > code.expiresAt) return oauthError("expired_token", "The device_code has expired.");
    const plan = code.plan;
    if (!plan) return oauthError("authorization_pending", "The authorization request is still pending.");
    if (plan.slowDown > 0) {
      plan.slowDown--;
      code.interval += this.slowDownSeconds;
      return { ...oauthError("slow_down", "Too many requests have been made in the same timeframe."), interval: code.interval };
    }
    if (plan.pending > 0) {
      plan.pending--;
      return oauthError("authorization_pending", "The authorization request is still pending.");
    }
    if (plan.deny || !plan.user) return oauthError("access_denied", "The authorization request was denied.");
    code.accessToken = `ghu_${randomBytes(18).toString("base64url")}`;
    this.userTokens.set(code.accessToken, plan.user);
    return {
      access_token: code.accessToken,
      expires_in: 28_800,
      refresh_token: `ghr_${randomBytes(30).toString("base64url")}`,
      refresh_token_expires_in: 15_897_600,
      token_type: "bearer",
      scope: "",
    };
  }
}

function hex(bytes: number): string {
  return randomBytes(bytes).toString("hex").toUpperCase();
}

function oauthError(error: string, description: string): PollAnswer {
  return {
    error,
    error_description: description,
    error_uri: "https://docs.github.com/developers/apps/authorizing-oauth-apps#error-codes-for-the-device-flow",
  };
}
