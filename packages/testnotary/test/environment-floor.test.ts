import { describe, expect, test } from "vitest";
import { installedProject, type FakeRepo, type FixtureRepo, type InstallState, type Machine, type MachineOptions, type ProcessResult, type SystemOptions } from "@testnotary/test-world";
import { useWorld } from "@testnotary/test-world/vitest";

// The environment floor beyond the one-case-per-code table in refusals-and-warnings.test.ts: each
// package manager's install-state file read from fixtures, the run record's environment and *not
// pinned* flags, and what passes the floor. Node releases, machines and installed package managers
// are the test world's stand-ins: nothing is installed and no package manager ever runs.

const world = useWorld();

let repos = 0;

const PASSING = { suites: { test: { command: ["node", "-e", "process.exit(0)"] } } };
const NODE_24: SystemOptions = { node: "v24.11.0", lts: "Krypton" };

interface Developer {
  fixture: FixtureRepo;
  repo: FakeRepo;
  machine: Machine;
  /** `testnotary run --json` (or another command) in the fixture repo. */
  run(options?: { args?: string[]; env?: Record<string, string | undefined>; system?: SystemOptions }): Promise<ProcessResult>;
}

/** An installed repo and a developer with write access, signed in on a machine. */
async function developer(options: { config?: Record<string, unknown>; files?: Record<string, string>; machine?: MachineOptions } = {}): Promise<Developer> {
  const n = ++repos;
  const fixture = await world.fixtureRepo({ config: options.config ?? PASSING, files: options.files });
  const repo = await world.hostOnGitHub(fixture, { owner: `floor-${n}`, name: "widgets" });
  await world.github.installApp({ account: { login: `floor-${n}`, type: "Organization" }, repos: [repo] });
  const machine = await world.machine(options.machine);
  const user = world.github.addUser({ login: `floor-dev-${n}` });
  world.github.setPermission(repo, user, "write");
  world.github.deviceFlow.approveNext(user);
  expect((await world.runCli(["login"], { cwd: machine.home, machine })).exitCode).toBe(0);
  return {
    fixture,
    repo,
    machine,
    run: ({ args = ["run", "--json"], env, system = NODE_24 } = {}) => world.runCli(args, { cwd: fixture.dir, machine, env, system }),
  };
}

function uploadsSince(from: number): Record<string, unknown>[] {
  return world.service.requests
    .slice(from)
    .filter((request) => request.method === "POST" && request.path === "/api/v1/runs")
    .map((request) => JSON.parse(request.text) as Record<string, unknown>);
}

function outcome(result: ProcessResult): { outcome: string; refusal: string | null; attested: boolean } {
  return JSON.parse(result.stdout) as { outcome: string; refusal: string | null; attested: boolean };
}

/** Each format with the package manager the project pins and the machine's version of it. */
const FORMATS: { kind: InstallState; packageManager: string; machine: MachineOptions["packageManagers"]; state: RegExp }[] = [
  { kind: "npm", packageManager: "npm@11.6.0", machine: {}, state: /node_modules\/\.package-lock\.json/ },
  { kind: "pnpm", packageManager: "pnpm@10.34.9", machine: {}, state: /node_modules\/\.pnpm-workspace-state-v1\.json/ },
  { kind: "pnpm-10", packageManager: "pnpm@10.34.9", machine: {}, state: /node_modules\/\.pnpm-workspace-state-v1\.json/ },
  { kind: "yarn-berry", packageManager: "yarn@4.9.2", machine: { yarn: "4.9.2" }, state: /\.yarn\/install-state\.gz/ },
  { kind: "yarn-classic", packageManager: "yarn@1.22.22", machine: {}, state: /node_modules\/\.yarn-integrity/ },
];

describe("install state, read from each package manager's own file", () => {
  test.each(FORMATS)("$kind: an install that matches the lockfile attests", async ({ kind, packageManager, machine }) => {
    const project = installedProject(kind, { packageManager });
    const dev = await developer({ files: project.files, machine: { packageManagers: machine } });
    await dev.fixture.write(project.installed(dev.fixture.dir));

    const result = await dev.run();

    expect(result.exitCode, result.stderr).toBe(0);
    expect(outcome(result)).toMatchObject({ outcome: "passed", attested: true });
    expect(await dev.machine.packageManagerCalls()).toEqual([]);
  });

  test.each(FORMATS)("$kind: a lockfile changed since the install refuses install_stale before the start", async ({ kind, packageManager, machine }) => {
    const project = installedProject(kind, { packageManager });
    const dev = await developer({ files: project.files, machine: { packageManagers: machine } });
    await dev.fixture.write(project.installed(dev.fixture.dir));
    await dev.fixture.commit("Bump left-pad", project.bumped);

    const result = await dev.run();

    expect(result.exitCode).toBe(2);
    expect(outcome(result)).toMatchObject({ outcome: "refused", refusal: "install_stale" });
    expect(result.stderr).toContain(`the installed dependencies don't match ${project.lockfile}`);
    expect(await dev.machine.packageManagerCalls()).toEqual([]);
  });

  test.each(FORMATS)("$kind: no install-state file refuses install_stale, naming the file", async ({ kind, packageManager, machine, state }) => {
    const project = installedProject(kind, { packageManager });
    const dev = await developer({ files: project.files, machine: { packageManagers: machine } });

    const result = await dev.run();

    expect(outcome(result)).toMatchObject({ outcome: "refused", refusal: "install_stale" });
    expect(result.stderr).toMatch(new RegExp(`${state.source}[^\\n]* is missing`));
  });

  test.each(FORMATS)("$kind: an unreadable install-state file refuses install_stale", async ({ kind, packageManager, machine }) => {
    const project = installedProject(kind, { packageManager });
    const dev = await developer({ files: project.files, machine: { packageManagers: machine } });
    const installed = project.installed(dev.fixture.dir);
    const garbled = Object.fromEntries(Object.keys(installed).map((path) => [path, "\u0000not what the package manager wrote"]));
    await dev.fixture.write(garbled);

    const result = await dev.run();

    expect(outcome(result)).toMatchObject({ outcome: "refused", refusal: "install_stale" });
  });

  test("npm: a package installed on top of the lockfile (npm install --no-save) is stale", async () => {
    const project = installedProject("npm");
    const dev = await developer({ files: project.files });
    const installed = project.installed(dev.fixture.dir);
    const hidden = JSON.parse(installed["node_modules/.package-lock.json"] as string) as { packages: Record<string, unknown> };
    hidden.packages["node_modules/is-odd"] = { version: "3.0.1", resolved: "https://registry.npmjs.org/is-odd/-/is-odd-3.0.1.tgz" };
    await dev.fixture.write({ ...installed, "node_modules/.package-lock.json": JSON.stringify(hidden) });

    const result = await dev.run();

    expect(outcome(result)).toMatchObject({ refusal: "install_stale" });
    expect(result.stderr).toContain("node_modules/is-odd is installed but not in package-lock.json");
  });

  test("Yarn classic: an install made under another Node (modules ABI) is stale, as Yarn itself judges it", async () => {
    const project = installedProject("yarn-classic");
    const dev = await developer({ files: project.files });
    const installed = project.installed(dev.fixture.dir);
    const integrity = JSON.parse(installed["node_modules/.yarn-integrity"] as string) as { systemParams: string };
    integrity.systemParams = `${process.platform}-${process.arch}-1`;
    await dev.fixture.write({ ...installed, "node_modules/.yarn-integrity": JSON.stringify(integrity) });

    const result = await dev.run();

    expect(outcome(result)).toMatchObject({ refusal: "install_stale" });
    expect(result.stderr).toMatch(/the install was made for \S+-1, and this machine and Node are/);
  });
});

describe("no package-manager command runs", () => {
  test("run and check in a pinned pnpm repo: the version comes from files, the install from its state file, and no package manager starts", async () => {
    const project = installedProject("pnpm", { packageManager: "pnpm@10.34.9" });
    const dev = await developer({ files: project.files });
    await dev.fixture.write(project.installed(dev.fixture.dir));
    const mark = world.service.requests.length;

    const checked = await dev.run({ args: ["check", "--json"] });
    const ran = await dev.run();

    expect(checked.exitCode, checked.stderr).toBe(0);
    expect(outcome(ran)).toMatchObject({ outcome: "passed", attested: true });
    // The machine's npm, pnpm and yarn record every start, `--version` included.
    expect(await dev.machine.packageManagerCalls()).toEqual([]);
    const [upload] = uploadsSince(mark);
    expect((upload!.environment as { packageManager: unknown }).packageManager).toEqual({ name: "pnpm", version: "10.34.9" });
  });

  test("the stand-ins do record a start, so the check above would see one", async () => {
    const dev = await developer({ config: { suites: { test: { command: ["pnpm", "--version"] } } } });

    const result = await dev.run();

    expect(outcome(result)).toMatchObject({ outcome: "failed" });
    expect(await dev.machine.packageManagerCalls()).toEqual([["pnpm", "--version"]]);
  });
});

describe("the package manager a run uses, read without running it", () => {
  test("started through pnpm, the run takes pnpm's version from npm_config_user_agent", async () => {
    const dev = await developer({ files: { "package.json": `${JSON.stringify({ name: "widgets", packageManager: "pnpm@9.15.0" })}\n` }, machine: { packageManagers: { pnpm: "8.15.9" } } });
    const mark = world.service.requests.length;

    const result = await dev.run({ env: { npm_config_user_agent: "pnpm/9.15.0 npm/? node/v24.11.0 linux x64" } });

    expect(outcome(result)).toMatchObject({ outcome: "passed", attested: true });
    const [upload] = uploadsSince(mark);
    expect((upload!.environment as { packageManager: unknown }).packageManager).toEqual({ name: "pnpm", version: "9.15.0" });
  });

  test("pnpm 10 on PATH runs the version packageManager pins, so a pin to another pnpm matches", async () => {
    const dev = await developer({ files: { "package.json": `${JSON.stringify({ name: "widgets", packageManager: "pnpm@9.15.0" })}\n` } });

    const result = await dev.run();

    expect(outcome(result)).toMatchObject({ outcome: "passed", attested: true });
  });

  test("…unless manage-package-manager-versions is off in .npmrc", async () => {
    const dev = await developer({
      files: { "package.json": `${JSON.stringify({ name: "widgets", packageManager: "pnpm@9.15.0" })}\n`, ".npmrc": "manage-package-manager-versions=false\n" },
    });

    const result = await dev.run();

    expect(outcome(result)).toMatchObject({ refusal: "package_manager_mismatch" });
    expect(result.stderr).toMatch(/pins pnpm@9\.15\.0, but this run would use pnpm 10\.34\.9/);
  });

  test("Yarn runs the release yarnPath names, whatever Yarn is on PATH", async () => {
    const dev = await developer({
      files: {
        "package.json": `${JSON.stringify({ name: "widgets", packageManager: "yarn@4.9.2" })}\n`,
        ".yarnrc.yml": "yarnPath: .yarn/releases/yarn-4.9.2.cjs\n",
        ".yarn/releases/yarn-4.9.2.cjs": "// the Yarn release a repo commits\n",
      },
    });

    const result = await dev.run();

    expect(outcome(result)).toMatchObject({ outcome: "passed", attested: true });
  });

  test("devEngines.packageManager's range admits the installed version", async () => {
    const dev = await developer({ files: { "package.json": `${JSON.stringify({ name: "widgets", devEngines: { packageManager: { name: "npm", version: ">=11 <12" } } })}\n` } });
    const mark = world.service.requests.length;

    const result = await dev.run();

    expect(outcome(result)).toMatchObject({ outcome: "passed", attested: true });
    expect(uploadsSince(mark)[0]!.notPinned).toEqual(["runtime"]);
  });
});

describe("what the uploaded run records about its environment", () => {
  test("a moving Node alias and an unpinned package manager are recorded as not pinned", async () => {
    const dev = await developer({ files: { ".nvmrc": "lts/*\n", "package.json": '{ "name": "widgets" }\n' } });
    const mark = world.service.requests.length;

    const result = await dev.run({ system: { node: "v24.11.0", lts: "Krypton", platform: "linux", arch: "arm64" } });

    expect(outcome(result)).toMatchObject({ outcome: "passed", attested: true });
    const [upload] = uploadsSince(mark);
    expect(upload!.notPinned).toEqual(["runtime", "package_manager"]);
    expect(upload!.environment).toMatchObject({ os: "linux", arch: "arm64", node: "v24.11.0", packageManager: null, tz: "UTC", locale: "C.UTF-8" });
  });

  test.each([
    ["node in .node-version", { ".node-version": "node\n" }],
    ["latest in .nvmrc", { ".nvmrc": "latest\n" }],
    ["an open range in engines.node", { "package.json": `${JSON.stringify({ name: "widgets", packageManager: "npm@11.6.0", engines: { node: ">=20" } })}\n` }],
    ["no Node version anywhere", {}],
  ])("%s: runtime not pinned", async (_name, files) => {
    const dev = await developer({ files });
    const mark = world.service.requests.length;

    const result = await dev.run();

    expect(outcome(result)).toMatchObject({ outcome: "passed", attested: true });
    expect(uploadsSince(mark)[0]!.notPinned).toContain("runtime");
  });

  test("Node and the package manager both pinned: nothing is flagged, and the package manager and version are recorded", async () => {
    const dev = await developer({ files: { ".nvmrc": "v24.11\n", "package.json": `${JSON.stringify({ name: "widgets", packageManager: "npm@11.6.0" })}\n` } });
    const mark = world.service.requests.length;

    const result = await dev.run();

    expect(outcome(result)).toMatchObject({ outcome: "passed", attested: true });
    const [upload] = uploadsSince(mark);
    expect(upload!.notPinned).toEqual([]);
    expect((upload!.environment as { packageManager: unknown }).packageManager).toEqual({ name: "npm", version: "11.6.0" });
  });
});

describe("what passes the floor", () => {
  test.each([
    ["24 in .nvmrc", { ".nvmrc": "24\n" }, NODE_24],
    ["lts/krypton in .nvmrc, on Node 24 LTS", { ".nvmrc": "lts/krypton\n" }, NODE_24],
    ["nodejs 24.11.0 in .tool-versions, beside other tools", { ".tool-versions": "python 3.12.1\nnodejs 24.11.0\n" }, NODE_24],
    ["^24 in volta.node", { "package.json": `${JSON.stringify({ name: "widgets", volta: { node: "^24" } })}\n` }, NODE_24],
    ["devEngines.runtime naming node", { "package.json": `${JSON.stringify({ name: "widgets", devEngines: { runtime: [{ name: "node", version: "~24.11" }] } })}\n` }, NODE_24],
  ] as const)("%s", async (_name, files, system) => {
    const dev = await developer({ files });

    const result = await dev.run({ system });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(outcome(result)).toMatchObject({ outcome: "passed", attested: true });
  });

  test("a bare OS in platforms allows every architecture", async () => {
    const dev = await developer({ config: { ...PASSING, platforms: ["darwin/arm64", "linux"] } });

    const result = await dev.run({ system: { ...NODE_24, platform: "linux", arch: "arm64" } });

    expect(outcome(result)).toMatchObject({ outcome: "passed", attested: true });
  });

  test("check refuses as run would: runtime_mismatch before anything starts", async () => {
    const dev = await developer({ files: { ".nvmrc": "22\n" } });
    const mark = world.service.requests.length;

    const result = await dev.run({ args: ["check", "--json"] });

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ refusal: "runtime_mismatch", attestable: false });
    expect(uploadsSince(mark)).toEqual([]);
  });
});
