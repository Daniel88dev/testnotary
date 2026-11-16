import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { FakeRepo, FixtureRepo, Machine, ProcessResult } from "@testnotary/test-world";
import { useWorld } from "@testnotary/test-world/vitest";

// `testnotary check [suite]`: every refusal check and the service preflight, without starting the
// command or uploading anything. Exits 0 or 2.

const world = useWorld();

let repos = 0;

interface Scene {
  fixture: FixtureRepo;
  repo: FakeRepo;
  machine: Machine;
  login: string;
  /** Whether the suite's command started. */
  started(): boolean;
  /** `testnotary check <args>` in the fixture repo. */
  check(args?: string[], env?: Record<string, string | undefined>): Promise<ProcessResult>;
  token(): Promise<string>;
}

/** An installed repo whose suite leaves a marker when its command starts, and a developer signed in with write access. */
async function scene(options: { command?: string[]; files?: Record<string, string>; permission?: "write" | "read"; signedIn?: boolean } = {}): Promise<Scene> {
  const n = ++repos;
  const machine = await world.machine();
  const marker = join(machine.home, `started-${n}`);
  const command = options.command ?? ["node", "-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "")`];
  const fixture = await world.fixtureRepo({ config: { suites: { unit: { command } } }, files: options.files });
  const repo = await world.hostOnGitHub(fixture, { owner: `check-${n}`, name: "widgets" });
  await world.github.installApp({ account: { login: `check-${n}`, type: "Organization" }, repos: [repo] });
  const user = world.github.addUser({ login: `check-dev-${n}` });
  world.github.setPermission(repo, user, options.permission ?? "write");
  if (options.signedIn !== false) {
    world.github.deviceFlow.approveNext(user);
    expect((await world.runCli(["login"], { cwd: machine.home, machine })).exitCode).toBe(0);
  }
  return {
    fixture,
    repo,
    machine,
    login: user.login,
    started: () => existsSync(marker),
    check: (args = [], env) => world.runCli(["check", ...args], { cwd: fixture.dir, machine, env }),
    async token() {
      const [entry] = await machine.keychain();
      return entry!.secret;
    },
  };
}

function requestsSince(from: number): string[] {
  return world.service.requests.slice(from).map((request) => `${request.method} ${request.path}`);
}

describe("testnotary check", () => {
  test("in a repo a run would attest, it asks the service, starts nothing, uploads nothing and exits 0", async () => {
    const s = await scene();
    const mark = world.service.requests.length;

    const result = await s.check(["--json"]);

    expect(result.exitCode).toBe(0);
    expect(s.started()).toBe(false);
    expect(requestsSince(mark)).toEqual(["POST /api/v1/preflight"]);
    expect(JSON.parse(result.stdout)).toEqual({
      suite: "unit",
      refusal: null,
      attestable: true,
      tree: await s.fixture.tree(),
      commit: await s.fixture.revParse("HEAD"),
      warnings: [],
    });
    expect(result.stderr).toMatch(new RegExp(`^testnotary: check unit: no refusal; a run would attest as @${s.login} with laptop token "[^"]+"$`, "m"));
  });

  test("without --json it prints only testnotary: lines on stderr, and nothing on stdout", async () => {
    const s = await scene();

    const result = await s.check();

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    for (const line of result.stderr.trimEnd().split("\n")) expect(line).toMatch(/^testnotary: /);
  });

  test("not signed in, it exits 0 with the warning, and says a run would not be attested", async () => {
    const s = await scene({ signedIn: false });

    const result = await s.check(["--json"]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ refusal: null, attestable: false, warnings: ["not_signed_in"] });
    expect(result.stderr).toMatch(/^testnotary: check unit: no refusal; a run would not be attested \(not_signed_in\)$/m);
  });

  const refusals: {
    refusal: string;
    name: string;
    arrange(): Promise<{ s: Scene; args?: string[]; env?: Record<string, string> }>;
  }[] = [
    { refusal: "extra_arguments", name: "arguments after --", arrange: async () => ({ s: await scene(), args: ["--", "--grep", "cart"] }) },
    {
      refusal: "history_dependent_command",
      name: "--changed in the command",
      arrange: async () => ({ s: await scene({ command: ["npx", "vitest", "run", "--changed"] }), env: { PATH: "/usr/bin:/bin" } }),
    },
    {
      refusal: "dirty_tree",
      name: "an untracked file",
      async arrange() {
        const s = await scene();
        await s.fixture.write({ "notes.txt": "x\n" });
        return { s };
      },
    },
    { refusal: "command_not_found", name: "a program not on PATH", arrange: async () => ({ s: await scene({ command: ["no-such-runner-81fa"] }) }) },
    { refusal: "config_invalid", name: "an undeclared suite", arrange: async () => ({ s: await scene(), args: ["lint"] }) },
    { refusal: "no_write_access", name: "read access only (the preflight's clear no)", arrange: async () => ({ s: await scene({ permission: "read" }) }) },
    {
      refusal: "laptop_token_in_sandbox",
      name: "a laptop token in a sandbox",
      async arrange() {
        const s = await scene();
        return { s, env: { TESTNOTARY_SANDBOX: "1", TESTNOTARY_TOKEN: await s.token() } };
      },
    },
  ];

  test.each(refusals)("$refusal: $name refuses with exit 2, without starting the command or uploading a run", async ({ refusal, arrange }) => {
    const { s, args = [], env } = await arrange();
    const mark = world.service.requests.length;

    const result = await s.check(["--json", ...args], env);

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ refusal, attestable: false });
    expect(result.stderr).toMatch(new RegExp(`^testnotary: check \\S+: a run would be refused \\(${refusal}\\)$`, "m"));
    expect(s.started()).toBe(false);
    expect(requestsSince(mark)).not.toContain("POST /api/v1/runs");
  });

  test("the suite may be left out only when the config declares one; several and none named is a usage error", async () => {
    const s = await scene();
    await s.fixture.commit("Two suites", { "testnotary.json": JSON.stringify({ suites: { unit: { command: ["node"] }, e2e: { command: ["node"] } } }) });
    await s.fixture.push("main");

    const result = await s.check();

    expect(result.exitCode).toBe(64);
    expect(result.stderr).toContain("unit, e2e");
  });
});
