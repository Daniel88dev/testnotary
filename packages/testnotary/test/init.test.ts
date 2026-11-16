import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseConfig } from "@testnotary/core";
import { useWorld } from "@testnotary/test-world/vitest";

const world = useWorld();

function manifest(fields: Record<string, unknown>): string {
  return `${JSON.stringify({ name: "shop", private: true, ...fields }, null, 2)}\n`;
}

async function read(dir: string, path: string): Promise<string> {
  return readFile(join(dir, path), "utf8");
}

describe("testnotary init --yes", () => {
  test("writes testnotary.json with one suite test that runs scripts.test through the pinned package manager", async () => {
    const repo = await world.fixtureRepo({
      config: null,
      files: { "package.json": manifest({ packageManager: "pnpm@10.34.9", scripts: { test: "vitest run" } }) },
    });

    const result = await world.runCli(["init", "--yes"], { cwd: repo.dir });

    expect(result.exitCode).toBe(0);
    const text = await read(repo.dir, "testnotary.json");
    const parsed = parseConfig(text);
    expect(parsed).toEqual({
      ok: true,
      config: { $schema: "https://testnotary.dev/schema/v1.json", suites: { test: { command: ["pnpm", "run", "test"] } } },
    });
  });

  test.each([
    { lockfile: "yarn.lock", command: ["yarn", "test"] },
    { lockfile: "package-lock.json", command: ["npm", "test"] },
    { lockfile: "pnpm-lock.yaml", command: ["pnpm", "run", "test"] },
    { lockfile: null, command: ["npm", "test"] },
  ])("with no pin, the lockfile $lockfile names the package manager", async ({ lockfile, command }) => {
    const repo = await world.fixtureRepo({
      config: null,
      files: { "package.json": manifest({ scripts: { test: "node --test" } }), ...(lockfile ? { [lockfile]: "" } : {}) },
    });

    const result = await world.runCli(["init", "--yes"], { cwd: repo.dir });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(await read(repo.dir, "testnotary.json"))).toMatchObject({ suites: { test: { command } } });
  });

  test("run from a subdirectory, it writes at the repo's top level", async () => {
    const repo = await world.fixtureRepo({
      config: null,
      files: { "package.json": manifest({ scripts: { test: "node --test" } }), "src/index.js": "" },
    });

    const result = await world.runCli(["init", "--yes"], { cwd: join(repo.dir, "src") });

    expect(result.exitCode).toBe(0);
    expect(parseConfig(await read(repo.dir, "testnotary.json")).ok).toBe(true);
  });

  test.each([
    { case: "no package.json", files: {} as Record<string, string>, says: "no package.json" },
    { case: "no scripts.test", files: { "package.json": manifest({ scripts: { build: "tsc" } }) }, says: "scripts.test" },
    { case: "a Bun pin", files: { "package.json": manifest({ packageManager: "bun@1.2.0", scripts: { test: "bun test" } }) }, says: "bun" },
  ])("with $case it writes nothing, says why and exits 1", async ({ files, says }) => {
    const repo = await world.fixtureRepo({ config: null, files });

    const result = await world.runCli(["init", "--yes"], { cwd: repo.dir });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(says);
    expect(await repo.git("status", "--porcelain", "--untracked-files=all")).toBe("");
  });

  test("an existing testnotary.json is left as it is", async () => {
    const existing = `${JSON.stringify({ suites: { unit: { command: ["node", "--test"] } } }, null, 2)}\n`;
    const repo = await world.fixtureRepo({
      config: null,
      files: { "package.json": manifest({ scripts: { test: "vitest run" } }), "testnotary.json": existing },
    });

    const result = await world.runCli(["init", "--yes"], { cwd: repo.dir });

    expect(result.exitCode).toBe(0);
    expect(await read(repo.dir, "testnotary.json")).toBe(existing);
    expect(result.stderr).toContain("testnotary.json already exists");
  });
});
