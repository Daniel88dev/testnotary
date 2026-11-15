import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { FakeAccount, FakeRepo, FixtureRepo, Machine, ProcessResult } from "@testnotary/test-world";
import { useWorld } from "@testnotary/test-world/vitest";

// `run` and `login` in a cloud agent sandbox: the sandbox markers, sandbox tokens, the request a
// vendor proxy can add a token to, and the agent session labels.

const world = useWorld();

interface Developer {
  fixture: FixtureRepo;
  repo: FakeRepo;
  machine: Machine;
  user: FakeAccount;
  /** Whether the suite's command started. */
  started(): boolean;
  /** `testnotary run --json <args>` in the fixture repo, on the developer's machine. */
  run(env?: Record<string, string | undefined>, options?: { rootFiles?: string[] }): Promise<ProcessResult>;
  /** The laptop token `login` left in the machine's keychain. */
  laptopToken(): Promise<string>;
}

let repos = 0;

/** An installed repo, and a developer with write access signed in on their laptop. */
async function developer(options: { exitCode?: number } = {}): Promise<Developer> {
  const n = ++repos;
  const machine = await world.machine();
  const mark = join(machine.home, `started-${n}`);
  const config = {
    suites: { test: { command: ["node", "-e", `require("node:fs").writeFileSync(${JSON.stringify(mark)}, ""); process.exit(${options.exitCode ?? 0})`] } },
  };
  const fixture = await world.fixtureRepo({ config });
  const repo = await world.hostOnGitHub(fixture, { owner: `sandbox-${n}`, name: "widgets" });
  await world.github.installApp({ account: { login: `sandbox-${n}`, type: "Organization" }, repos: [repo] });
  const user = world.github.addUser({ login: `agent-owner-${n}` });
  world.github.setPermission(repo, user, "write");
  world.github.deviceFlow.approveNext(user);
  expect((await world.runCli(["login"], { cwd: machine.home, machine })).exitCode).toBe(0);
  return {
    fixture,
    repo,
    machine,
    user,
    started: () => existsSync(mark),
    run: (env, runOptions) => world.runCli(["run", "--json"], { cwd: fixture.dir, machine, env, rootFiles: runOptions?.rootFiles }),
    async laptopToken() {
      const [entry] = await machine.keychain();
      return entry!.secret;
    },
  };
}

/** Every request a run sent to the service, from request number `from` on. */
function requestsSince(from: number) {
  return world.service.requests.slice(from).filter((request) => request.path.startsWith("/api/v1/"));
}

/** Each sandbox marker, as the environment (and files) a sandbox shows. */
const MARKERS: { marker: string; env?: Record<string, string>; rootFiles?: string[] }[] = [
  { marker: "CLAUDE_CODE_REMOTE", env: { CLAUDE_CODE_REMOTE: "true" } },
  { marker: "CURSOR_AGENT_SOCKET", env: { CURSOR_AGENT_SOCKET: "/tmp/cursor-agent.sock" } },
  { marker: "GITHUB_ACTIONS", env: { GITHUB_ACTIONS: "true" } },
  { marker: "/opt/.devin", rootFiles: ["/opt/.devin"] },
  { marker: "HOME=/home/jules", env: { HOME: "/home/jules", USER: "swebot" } },
  { marker: "TESTNOTARY_SANDBOX", env: { TESTNOTARY_SANDBOX: "1" } },
];

describe("a laptop token inside a sandbox", () => {
  test.each(MARKERS)("$marker: TESTNOTARY_TOKEN holding a tnl_ token refuses laptop_token_in_sandbox before the start", async ({ env, rootFiles }) => {
    const dev = await developer();
    const laptop = await dev.laptopToken();
    const mark = world.service.requests.length;

    const result = await dev.run({ ...env, TESTNOTARY_TOKEN: laptop }, { rootFiles });

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "refused", refusal: "laptop_token_in_sandbox", attested: false });
    expect(result.stderr).toMatch(/^testnotary: .*laptop token.*sandbox token/m);
    expect(dev.started()).toBe(false);
    // The person's laptop token never leaves the sandbox: no preflight, no refused-run upload.
    expect(requestsSince(mark)).toEqual([]);
  });

  test.each(MARKERS)("$marker: login is refused", async ({ marker, env, rootFiles }) => {
    const machine = await world.machine();

    const result = await world.runCli(["login", "--json"], { cwd: machine.home, machine, env, rootFiles });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ error: "login_in_sandbox", marker });
  });

  test.each(MARKERS)("$marker: the laptop token in the keychain is not used, and no Authorization header is sent", async ({ env, rootFiles }) => {
    const dev = await developer();
    const mark = world.service.requests.length;

    const result = await dev.run(env, { rootFiles });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "passed", attested: false, warnings: ["not_signed_in"] });
    expect(dev.started()).toBe(true);
    const sent = requestsSince(mark);
    expect(sent.map((request) => request.path)).toEqual(["/api/v1/preflight"]);
    expect(sent[0]!.headers).not.toHaveProperty("authorization");
  });

  test("outside a sandbox the same TESTNOTARY_TOKEN attests", async () => {
    const dev = await developer();

    const result = await dev.run({ TESTNOTARY_TOKEN: await dev.laptopToken() });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "passed", attested: true });
  });
});
