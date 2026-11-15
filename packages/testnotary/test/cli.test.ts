import { describe, expect, test } from "vitest";
import { useWorld } from "@testnotary/test-world/vitest";
import pkg from "../package.json" with { type: "json" };

const world = useWorld();

describe("testnotary as a process", () => {
  test("--version prints the package version", async () => {
    const repo = await world.fixtureRepo();

    const result = await world.runCli(["--version"], { cwd: repo.dir });

    expect(result).toMatchObject({ exitCode: 0, stdout: `testnotary ${pkg.version}\n`, stderr: "" });
  });

  test("an unknown command is a usage error that lists the commands", async () => {
    const repo = await world.fixtureRepo();

    const result = await world.runCli(["frobnicate"], { cwd: repo.dir });

    expect(result.exitCode).toBe(64);
    expect(result.stderr).toContain('testnotary: unknown command "frobnicate"');
    expect(result.stderr).toMatch(/^ {2}login\s/m);
  });
});
