import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "acorn";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { useWorld } from "@testnotary/test-world/vitest";
import { repoRoot, run, scratch } from "./scripts.ts";

// The library as npm users get it: `pnpm pack` of packages/testnotary (its prepack builds), the
// tarball installed into an empty project, and the `testnotary` bin run from there.

const world = useWorld();

let out: { dir: string; remove: () => Promise<void> };
let tarball: string;
let project: string;
let installedCli: string;

const manifest = JSON.parse(await readFile(join(repoRoot, "packages/testnotary/package.json"), "utf8")) as { version: string };

beforeAll(async () => {
  out = await scratch("testnotary-pack");
  const packed = await run("pnpm", ["pack", "--pack-destination", out.dir], { cwd: join(repoRoot, "packages/testnotary") });
  expect(packed.exitCode, packed.stderr).toBe(0);
  tarball = join(out.dir, (await readdir(out.dir)).find((name) => name.endsWith(".tgz"))!);
  project = join(out.dir, "project");
  await run("mkdir", ["-p", project]);
  await writeFile(join(project, "package.json"), `${JSON.stringify({ name: "consumer", private: true })}\n`);
  const installed = await run("npm", ["install", "--offline", "--no-audit", "--no-fund", "--ignore-scripts", tarball], { cwd: project });
  expect(installed.exitCode, installed.stderr).toBe(0);
  installedCli = join(project, "node_modules/testnotary/dist/cli.js");
}, 180_000);

afterAll(async () => {
  await out?.remove();
});

describe("the packed library", () => {
  test("holds the built CLI, its notices, the license and the manifest, and no TypeScript", async () => {
    const listed = await run("tar", ["-tzf", tarball]);
    expect(listed.stdout.trim().split("\n").sort()).toEqual(["package/LICENSE", "package/dist/cli.js", "package/dist/licenses.txt", "package/package.json"]);
  });

  test("its manifest names the repo for provenance and declares the Node floor, with no workspace references", async () => {
    const packed = await readFile(join(project, "node_modules/testnotary/package.json"), "utf8");
    expect(JSON.parse(packed)).toMatchObject({
      name: "testnotary",
      license: "MIT",
      bin: { testnotary: "./dist/cli.js" },
      engines: { node: ">=20" },
      repository: { type: "git", url: "git+https://github.com/Daniel88dev/testnotary.git", directory: "packages/testnotary" },
    });
    expect(packed).not.toContain("workspace:");
  });

  test("the installed `testnotary` bin runs and prints the package's version", async () => {
    const result = await run(join(project, "node_modules/.bin/testnotary"), ["--version"], { cwd: project });
    expect(result).toMatchObject({ exitCode: 0, stdout: `testnotary ${manifest.version}\n` });
  });

  test("runs with Node's type stripping off: no TypeScript at runtime", async () => {
    const result = await run(process.execPath, ["--no-experimental-strip-types", installedCli, "--help"], { cwd: project });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^usage:/);
  });

  test("the bundle is Node 20 syntax (ES2023) and calls no API newer than Node 20", async () => {
    const code = await readFile(installedCli, "utf8");
    expect(() => parse(code, { ecmaVersion: 2023, sourceType: "module", allowHashBang: true })).not.toThrow();
    for (const newer of ["getBuiltinModule", "withResolvers", "Object.groupBy", "Map.groupBy", "Array.fromAsync", "RegExp.escape", "globSync", "node:sqlite"]) {
      expect(code, newer).not.toContain(newer);
    }
  });

  test("the built CLI talks to the service it is pointed at: login through the installed package against the world", async () => {
    const user = world.github.addUser({ login: "packed-library-user" });
    const machine = await world.machine();
    world.github.deviceFlow.approveNext(user);
    const result = await world.runCli(["login"], { cwd: machine.home, machine, cli: installedCli });
    expect(result.stderr).not.toMatch(/error/i);
    expect(result.exitCode).toBe(0);
  });
});

describe("the license", () => {
  test("the root LICENSE is the MIT license with the maintainer as copyright holder, and the package ships the same text", async () => {
    const root = await readFile(join(repoRoot, "LICENSE"), "utf8");
    expect(root).toMatch(/^MIT License\n\nCopyright \(c\) 2026 Daniel Hrynusiw\n\nPermission is hereby granted, free of charge,/);
    expect(root).toContain('THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND');
    expect(await readFile(join(repoRoot, "packages/testnotary/LICENSE"), "utf8")).toBe(root);
    expect(await readFile(join(project, "node_modules/testnotary/LICENSE"), "utf8")).toBe(root);
  });

  test("every package.json in the repo says MIT", async () => {
    const manifests = ["package.json", ...(await workspaceManifests())];
    for (const path of manifests) {
      expect((JSON.parse(await readFile(join(repoRoot, path), "utf8")) as { license?: string }).license, path).toBe("MIT");
    }
  });
});

describe("TESTNOTARY_URL", () => {
  test("is built into neither help nor docs: the CLI's help, the README, action.yml and the web app's pages never mention it", async () => {
    const help = await run(process.execPath, [installedCli, "--help"], { cwd: project });
    expect(help.stdout).not.toContain("TESTNOTARY_URL");
    const files = ["README.md", "action.yml", ...(await filesUnder(["apps/web/app", "apps/web/content", "apps/web/src/docs", "apps/web/public"]))];
    for (const file of files) {
      expect(await readFile(join(repoRoot, file), "utf8"), file).not.toContain("TESTNOTARY_URL");
    }
  });

  test("the built CLI defaults to the hosted service", async () => {
    expect(await readFile(installedCli, "utf8")).toContain('"https://testnotary.dev"');
  });
});

async function workspaceManifests(): Promise<string[]> {
  const found: string[] = [];
  for (const parent of ["packages", "apps"]) {
    for (const name of await readdir(join(repoRoot, parent))) found.push(`${parent}/${name}/package.json`);
  }
  return found;
}

async function filesUnder(dirs: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const dir of dirs) {
    for (const entry of await readdir(join(repoRoot, dir), { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && !/\.(woff2?|png|jpe?g|ico|webp|svg)$/.test(entry.name)) files.push(join(entry.parentPath, entry.name).slice(repoRoot.length + 1));
    }
  }
  return files;
}
