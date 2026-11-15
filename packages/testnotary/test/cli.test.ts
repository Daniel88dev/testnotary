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
});
