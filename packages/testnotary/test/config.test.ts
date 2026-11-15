import { describe, expect, test } from "vitest";
import { useWorld } from "@testnotary/test-world/vitest";

const world = useWorld();

const unit = { command: ["node", "-e", "console.log('ran')"] };

describe("testnotary.json through exec", () => {
  test.each([
    { name: "an unknown top-level key", config: { suites: { unit }, sutes: {} }, problem: 'testnotary.json: unknown key "sutes"' },
    { name: "an unknown suite key", config: { suites: { unit: { ...unit, cwd: "packages/a" } } }, problem: 'suites.unit: unknown key "cwd"' },
    { name: "an unknown env key", config: { env: { passs: ["A"] }, suites: { unit } }, problem: 'env: unknown key "passs"' },
    {
      name: "a TESTNOTARY_* name in env.pass",
      config: { env: { pass: ["TESTNOTARY_TOKEN"] }, suites: { unit } },
      problem: 'env.pass[0]: "TESTNOTARY_TOKEN" is reserved',
    },
    {
      name: "a TESTNOTARY_* name in env.set",
      config: { env: { set: { TESTNOTARY_URL: "http://example.test" } }, suites: { unit } },
      problem: 'env.set.TESTNOTARY_URL: "TESTNOTARY_URL" is reserved',
    },
    {
      name: "a TESTNOTARY_* name in a suite's env",
      config: { suites: { unit: { ...unit, env: { pass: ["TESTNOTARY_SANDBOX"] } } } },
      problem: 'suites.unit.env.pass[0]: "TESTNOTARY_SANDBOX" is reserved',
    },
    { name: "a command that is a string", config: { suites: { unit: { command: "npm test" } } }, problem: "suites.unit.command:" },
    { name: "an empty command", config: { suites: { unit: { command: [] } } }, problem: "suites.unit.command[0]: the command needs at least the program to run" },
    { name: "no suites", config: { suites: {} }, problem: "suites:" },
    { name: "a missing suites key", config: { env: {} }, problem: "suites:" },
    { name: "signatures other than required", config: { signatures: "optional", suites: { unit } }, problem: "signatures:" },
    { name: "a platform not in Node's spelling", config: { platforms: ["linux/x86_64"], suites: { unit } }, problem: 'platforms[0]: "linux/x86_64" is not a platform' },
    { name: "HOME in env.set", config: { env: { set: { HOME: "/tmp" } }, suites: { unit } }, problem: "env.set: HOME is part of the stripped environment" },
    { name: "PATH in env.pass", config: { env: { pass: ["PATH"] }, suites: { unit } }, problem: "env.pass: PATH is part of the stripped environment" },
    {
      name: "a name both passed and set",
      config: { env: { pass: ["NODE_ENV"] }, suites: { unit: { ...unit, env: { set: { NODE_ENV: "test" } } } } },
      problem: "suites.unit: NODE_ENV is both passed from the shell and set",
    },
  ])("$name is config_invalid with exit 2", async ({ config, problem }) => {
    const repo = await world.fixtureRepo({ config });

    const result = await world.runCli(["exec", "unit", "--json"], { cwd: repo.dir });

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "refused", refusal: "config_invalid", exitCode: null, attested: false });
    expect(result.stderr).toContain(`testnotary:   ${problem}`);
    expect(result.stderr).not.toContain("ran\n");
  });

  test("a config that isn't JSON is config_invalid", async () => {
    const repo = await world.fixtureRepo({ config: null, files: { "testnotary.json": "{ suites: " } });

    const result = await world.runCli(["exec", "unit"], { cwd: repo.dir });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("testnotary:   not valid JSON");
    expect(result.stderr.trimEnd().split("\n").at(-1)).toMatch(/^outcome=refused suite=unit attested=false /);
  });

  test("no testnotary.json in the checked-out tree is config_invalid", async () => {
    const repo = await world.fixtureRepo({ config: null });

    const result = await world.runCli(["exec", "unit", "--json"], { cwd: repo.dir });

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "refused", refusal: "config_invalid" });
    expect(result.stderr).toMatch(/^testnotary: no testnotary\.json in /m);
  });

  test("a suite the config doesn't declare is config_invalid and names the declared ones", async () => {
    const repo = await world.fixtureRepo({ config: { suites: { unit, e2e: unit } } });

    const result = await world.runCli(["exec", "integration", "--json"], { cwd: repo.dir });

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "refused", refusal: "config_invalid" });
    expect(result.stderr).toContain('testnotary: testnotary.json declares no suite "integration"; it declares: unit, e2e');
  });

  test("every documented key is accepted", async () => {
    const repo = await world.fixtureRepo({
      config: {
        $schema: "https://testnotary.dev/schema/v1.json",
        base: "main",
        platforms: ["linux/x64", "darwin"],
        env: { pass: ["DATABASE_URL"], set: { CI: "1", LANG: "en_US.UTF-8", NODE_ENV: "test" } },
        guarded: ["scripts/**"],
        nodeVersionFile: ".nvmrc",
        signatures: "required",
        suites: { unit: { ...unit, env: { pass: ["REDIS_URL"], set: { TZ: "Europe/Prague" } } } },
      },
    });

    const result = await world.runCli(["exec", "unit"], { cwd: repo.dir });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ran\n");
  });
});

describe("usage errors", () => {
  test.each([
    { name: "exec with no suite", args: ["exec"] },
    { name: "exec with two suites", args: ["exec", "unit", "e2e"] },
    { name: "exec with arguments after --", args: ["exec", "unit", "--", "--watch"] },
    { name: "an unknown flag", args: ["exec", "unit", "--watch"] },
    { name: "an unknown command", args: ["frobnicate"] },
    { name: "no command", args: [] },
  ])("$name exits 64 without running anything", async ({ args }) => {
    const repo = await world.fixtureRepo({ config: { suites: { unit } } });

    const result = await world.runCli(args, { cwd: repo.dir });

    expect(result.exitCode).toBe(64);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^testnotary: /);
    expect(result.stderr).toMatch(/usage/);
  });
});
