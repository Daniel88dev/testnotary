import { hostname } from "node:os";
import { describe, expect, test } from "vitest";
import type { Machine } from "@testnotary/test-world";
import { useWorld } from "@testnotary/test-world/vitest";

const world = useWorld();

const TOKEN_NAME = /^(macOS|Linux) machine, \d{1,2} [A-Z][a-z]{2} \d{4}$/;

async function signedInMachine(login: string, options: { keychain?: "available" | "unavailable" } = {}) {
  const machine = await world.machine(options);
  const user = world.github.addUser({ login });
  world.github.deviceFlow.approveNext(user);
  const result = await world.runCli(["login"], { cwd: machine.home, machine });
  return { machine, user, result };
}

/** The one laptop token the machine's keychain holds. */
async function storedToken(machine: Machine): Promise<string> {
  const entries = await machine.keychain();
  expect(entries).toHaveLength(1);
  return entries[0]!.secret;
}

describe("testnotary login", () => {
  test("completes the device flow and keeps a laptop token in the keychain", async () => {
    const machine = await world.machine();
    const maria = world.github.addUser({ login: "maria-k" });
    world.github.deviceFlow.approveNext(maria, { pending: 2 });

    const result = await world.runCli(["login"], { cwd: machine.home, machine });

    expect(result.exitCode).toBe(0);
    const userCode = world.github.deviceFlow.issued.at(-1)!.userCode;
    expect(result.stderr).toContain(`testnotary: open https://github.com/login/device and enter ${userCode}\n`);
    expect(result.stderr).toMatch(/^testnotary: signed in as @maria-k \(laptop token "(macOS|Linux) machine, .+"\)$/m);
    const entries = await machine.keychain();
    expect(entries).toEqual([{ service: "testnotary", account: world.service.url, secret: expect.stringMatching(/^tnl_/) as string }]);
    expect(await machine.credentialsFile()).toBeUndefined();
  });

  test("links the terms and the privacy policy", async () => {
    const { result } = await signedInMachine("reader");

    expect(result.stderr).toMatch(/^testnotary: by signing in you agree to the Terms \(\S+\/terms\) and accept the Privacy policy \(\S+\/privacy\)$/m);
  });

  test("names the token after the OS and the date, never the host", async () => {
    const { machine } = await signedInMachine("namer");

    const whoami = await world.runCli(["whoami", "--json"], { cwd: machine.home, machine });

    const out = JSON.parse(whoami.stdout) as { token: { name: string } };
    expect(out.token.name).toMatch(TOKEN_NAME);
    expect(out.token.name).not.toContain(hostname());
  });

  test("falls back to a 0600 file when the keychain is unavailable", async () => {
    const { machine, result } = await signedInMachine("no-keychain", { keychain: "unavailable" });

    expect(result.exitCode).toBe(0);
    expect(await machine.keychain()).toEqual([]);
    const file = await machine.credentialsFile();
    expect(file?.mode).toBe(0o600);
    expect(file?.text).toMatch(/tnl_/);
    const whoami = await world.runCli(["whoami"], { cwd: machine.home, machine });
    expect(whoami).toMatchObject({ exitCode: 0, stdout: expect.stringMatching(/^@no-keychain · laptop token "/) as string });
  });

  test("the service keeps neither the laptop token nor the GitHub token, only the token's hash", async () => {
    const { machine } = await signedInMachine("hashed");
    const laptopToken = await storedToken(machine);
    const githubToken = world.github.deviceFlow.issued.at(-1)!.accessToken!;
    expect(githubToken).toMatch(/^ghu_/);

    const dump = await world.db.dump();

    expect(dump).not.toContain(laptopToken);
    expect(dump).not.toContain(laptopToken.slice(4));
    expect(dump).not.toContain(githubToken);
    expect(dump).not.toContain(githubToken.slice(4));
    // The token still works: the service recognises it by its hash.
    const whoami = await world.runCli(["whoami"], { cwd: machine.home, machine });
    expect(whoami.exitCode).toBe(0);
  });
});

describe("testnotary whoami and logout", () => {
  test("whoami prints the account, the token's name and its expiry", async () => {
    const { machine, user } = await signedInMachine("maria-w");

    const plain = await world.runCli(["whoami"], { cwd: machine.home, machine });
    const asJson = await world.runCli(["whoami", "--json"], { cwd: machine.home, machine });

    expect(plain.exitCode).toBe(0);
    expect(plain.stdout).toMatch(/^@maria-w · laptop token "(macOS|Linux) machine, [^"]+" · expires \d{1,2} [A-Z][a-z]{2} \d{4}\n$/);
    expect(JSON.parse(asJson.stdout)).toEqual({
      account: { id: user.id, login: "maria-w" },
      token: { id: expect.any(String) as string, kind: "laptop", name: expect.stringMatching(TOKEN_NAME) as string, expiresAt: expect.any(String) as string },
    });
    const { token } = JSON.parse(asJson.stdout) as { token: { expiresAt: string } };
    const days = (Date.parse(token.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89.9);
    expect(days).toBeLessThanOrEqual(90);
  });

  test("whoami without a token says how to sign in", async () => {
    const machine = await world.machine();

    const result = await world.runCli(["whoami", "--json"], { cwd: machine.home, machine });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ error: "not_signed_in" });
    expect(result.stderr).toContain("testnotary login");
  });

  test("logout drops the token locally and revokes it on the service", async () => {
    const { machine } = await signedInMachine("leaver");
    const token = await storedToken(machine);

    const result = await world.runCli(["logout"], { cwd: machine.home, machine });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toMatch(/^testnotary: signed out; laptop token ".+" revoked$/m);
    expect(await machine.keychain()).toEqual([]);
    const after = await fetch(`${world.service.url}/api/v1/whoami`, { headers: { authorization: `Bearer ${token}` } });
    expect(after.status).toBe(401);
    expect(await after.json()).toEqual({ error: "token_rejected" });
  });

  test("signing in again on the same machine replaces its laptop token", async () => {
    const { machine, user } = await signedInMachine("twice");
    const first = await storedToken(machine);

    world.github.deviceFlow.approveNext(user);
    const again = await world.runCli(["login"], { cwd: machine.home, machine });

    expect(again.exitCode).toBe(0);
    const second = await storedToken(machine);
    expect(second).not.toBe(first);
    const old = await fetch(`${world.service.url}/api/v1/whoami`, { headers: { authorization: `Bearer ${first}` } });
    expect(old.status).toBe(401);
  });
});

describe("testnotary login when GitHub says no", () => {
  test("a /user rejection for an IP allow list fails with a stable error and the Limits in v1 link", async () => {
    const machine = await world.machine();
    world.github.deviceFlow.approveNext(world.github.addUser({ login: "enterprise-dev" }));
    const restore = world.github.override("GET", "/user", () =>
      Response.json(
        {
          message:
            "Although you appear to have the correct authorization credentials, the `bigcorp` organization has an IP allow list enabled, and your IP address is not permitted to access this resource.",
          documentation_url: "https://docs.github.com/rest",
          status: "403",
        },
        { status: 403 },
      ),
    );

    const plain = await world.runCli(["login"], { cwd: machine.home, machine });
    world.github.deviceFlow.approveNext(world.github.addUser({ login: "enterprise-dev-2" }));
    const asJson = await world.runCli(["login", "--json"], { cwd: machine.home, machine });
    restore();

    expect(plain.exitCode).toBe(1);
    expect(plain.stderr).toMatch(/IP allow list/);
    expect(plain.stderr).toContain("https://testnotary.dev/docs/limits#github-enterprise");
    expect(asJson.exitCode).toBe(1);
    expect(JSON.parse(asJson.stdout)).toMatchObject({
      error: "github_denied",
      cause: "ip_allow_list",
      docsUrl: "https://testnotary.dev/docs/limits#github-enterprise",
    });
    expect(await machine.keychain()).toEqual([]);
  });

  test("a sign-in the person denies on GitHub fails without a token", async () => {
    const machine = await world.machine();
    world.github.deviceFlow.denyNext();

    const result = await world.runCli(["login", "--json"], { cwd: machine.home, machine });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ error: "access_denied" });
    expect(await machine.keychain()).toEqual([]);
  });

  test("slow_down makes login wait longer between polls", async () => {
    const machine = await world.machine();
    world.github.deviceFlow.interval = 1;
    try {
      world.github.deviceFlow.approveNext(world.github.addUser({ login: "patient" }), { slowDown: 1 });

      const result = await world.runCli(["login"], { cwd: machine.home, machine });

      expect(result.exitCode).toBe(0);
      const started = world.github.requestsTo("POST", "/login/device/code").at(-1)!.at;
      const polls = world.github.requestsTo("POST", "/login/oauth/access_token").filter((r) => r.at >= started).map((r) => r.at);
      // A slow_down, then the token: two polls, 1 s after the code and then 2 s apart, since
      // slow_down raised the interval (GitHub adds 5 s; the fake adds 1 s).
      expect(polls).toHaveLength(2);
      expect(polls[0]! - started).toBeGreaterThanOrEqual(950);
      expect(polls[1]! - polls[0]!).toBeGreaterThanOrEqual(1950);
    } finally {
      world.github.deviceFlow.interval = 0;
    }
  });

  test("login is refused inside an agent sandbox", async () => {
    const machine = await world.machine();
    const before = world.github.requestsTo("POST", "/login/device/code").length;

    const result = await world.runCli(["login", "--json"], { cwd: machine.home, machine, env: { CLAUDE_CODE_REMOTE: "true" } });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ error: "login_in_sandbox", marker: "CLAUDE_CODE_REMOTE" });
    expect(result.stderr).toMatch(/sandbox token/);
    expect(world.github.requestsTo("POST", "/login/device/code")).toHaveLength(before);
  });
});

describe("laptop token renewal", () => {
  const DAY_MS = 86_400_000;
  const HOUR_MS = 3_600_000;

  async function whoami(machine: Machine) {
    const result = await world.runCli(["whoami", "--json"], { cwd: machine.home, machine });
    return { exitCode: result.exitCode, out: JSON.parse(result.stdout) as { token?: { expiresAt: string }; error?: string } };
  }

  test("each use within 90 days renews a laptop token for 90 days from that use", async () => {
    const { machine } = await signedInMachine("renewer");
    const signedIn = world.clock.now().getTime();
    try {
      world.clock.advance(60 * DAY_MS);
      const day60 = await whoami(machine);
      world.clock.advance(89 * DAY_MS);
      const day149 = await whoami(machine);

      expect(day60.exitCode).toBe(0);
      expect(Date.parse(day60.out.token!.expiresAt) - signedIn).toBe(150 * DAY_MS);
      // Day 149 is long past the first 90 days: the use on day 60 kept the token alive.
      expect(day149.exitCode).toBe(0);
      expect(Date.parse(day149.out.token!.expiresAt) - signedIn).toBe(239 * DAY_MS);
    } finally {
      world.clock.reset();
    }
  });

  test("a laptop token unused for 90 days is rejected", async () => {
    const { machine } = await signedInMachine("sleeper");
    try {
      world.clock.advance(90 * DAY_MS - HOUR_MS);
      const justBefore = await whoami(machine);
      world.clock.advance(90 * DAY_MS);
      const atExpiry = await whoami(machine);

      expect(justBefore.exitCode).toBe(0);
      expect(atExpiry.exitCode).toBe(1);
      expect(atExpiry.out).toMatchObject({ error: "token_rejected" });
    } finally {
      world.clock.reset();
    }
  });
});
