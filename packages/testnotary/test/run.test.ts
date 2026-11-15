import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { FakeAccount, FakeRepo, FixtureRepo, Machine, ProcessResult } from "@testnotary/test-world";
import { useWorld } from "@testnotary/test-world/vitest";

const world = useWorld();

const PASSING = { suites: { test: { command: ["node", "-e", "process.exit(0)"] } } };
const FAILING = { suites: { test: { command: ["node", "-e", "process.exit(3)"] } } };

interface Developer {
  fixture: FixtureRepo;
  repo: FakeRepo;
  machine: Machine;
  user: FakeAccount;
  /** `testnotary run <args>` in the fixture repo, on the developer's machine. */
  run(args?: string[], env?: Record<string, string | undefined>): Promise<ProcessResult>;
  /** The laptop token `login` left in the machine's keychain. */
  token(): Promise<string>;
}

let repos = 0;

/**
 * A repo on the fake GitHub with the App installed, and a developer with write access signed in on
 * their laptop: the starting point of every attested run.
 */
async function developer(
  options: { config?: Record<string, unknown> | null; files?: Record<string, string>; permission?: "admin" | "write" | "read"; signedIn?: boolean } = {},
): Promise<Developer> {
  const n = ++repos;
  const fixture = await world.fixtureRepo({ config: options.config === undefined ? PASSING : options.config, files: options.files });
  const repo = await world.hostOnGitHub(fixture, { owner: `acme-${n}`, name: "widgets" });
  await world.github.installApp({ account: { login: `acme-${n}`, type: "Organization" }, repos: [repo] });
  const machine = await world.machine();
  const user = world.github.addUser({ login: `dev-${n}` });
  world.github.setPermission(repo, user, options.permission ?? "write");
  if (options.signedIn !== false) {
    world.github.deviceFlow.approveNext(user);
    const login = await world.runCli(["login"], { cwd: machine.home, machine });
    expect(login.exitCode).toBe(0);
  }
  return {
    fixture,
    repo,
    machine,
    user,
    run: (args = [], env) => world.runCli(["run", ...args], { cwd: fixture.dir, machine, env }),
    async token() {
      const [entry] = await machine.keychain();
      return entry!.secret;
    },
  };
}

/** The fixed summary line: the last line on stderr. */
function summary(result: ProcessResult): Record<string, string> {
  const last = result.stderr.trimEnd().split("\n").at(-1)!;
  expect(last).toMatch(/^outcome=\S* suite=\S* attested=\S* tree=\S* commit=\S* url=\S*$/);
  return Object.fromEntries(last.split(" ").map((pair) => pair.split("=", 2) as [string, string]));
}

async function storedRun(token: string, url: string) {
  const id = url.split("/").at(-1)!;
  const response = await fetch(`${world.service.url}/api/v1/runs/${id}`, { headers: { authorization: `Bearer ${token}` } });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    run: Record<string, unknown>;
    attestation: { id: string; format: string; payload: string } | null;
  };
}

/**
 * A suite whose command leaves a file behind (outside the repo) when it starts, to tell whether a
 * run got as far as starting it. `exitCode` is what the command then exits with.
 */
async function markedSuite(exitCode = 0) {
  const machine = await world.machine();
  const path = join(machine.home, `started-${++repos}`);
  const config = { suites: { test: { command: ["node", "-e", `require("node:fs").writeFileSync(${JSON.stringify(path)}, ""); process.exit(${exitCode})`] } } };
  return { config, started: () => existsSync(path) };
}

/** The bodies `run` sent to the service's run upload, from request number `from` on. */
function uploadsSince(from: number): Record<string, unknown>[] {
  return world.service.requests
    .slice(from)
    .filter((request) => request.method === "POST" && request.path === "/api/v1/runs")
    .map((request) => JSON.parse(request.text) as Record<string, unknown>);
}

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("testnotary run attests a pass", () => {
  test("a signed-in developer's passing run in a clean repo attests the head tree", async () => {
    const dev = await developer();

    const result = await dev.run();

    expect(result.exitCode).toBe(0);
    const tree = await dev.fixture.tree();
    const commit = await dev.fixture.revParse("HEAD");
    const line = summary(result);
    expect(line).toMatchObject({ outcome: "passed", suite: "test", attested: "true", tree, commit });
    expect(line.url).toMatch(new RegExp(`^${escaped(world.service.url)}/${dev.repo.owner}/widgets/runs/[0-9a-f-]{36}$`));
    const stored = await storedRun(await dev.token(), line.url!);
    expect(stored.run).toMatchObject({ outcome: "passed", suite: "test", tree, commit, command: PASSING.suites.test.command, exitCode: 0 });
    expect(stored.attestation).not.toBeNull();
  });

  test("--json reports the attestation and its run page", async () => {
    const dev = await developer();

    const result = await dev.run(["--json"]);

    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(out).toEqual({
      outcome: "passed",
      refusal: null,
      exitCode: 0,
      attested: true,
      attestationUrl: summary(result).url,
      tree: await dev.fixture.tree(),
      commit: await dev.fixture.revParse("HEAD"),
      durationMs: expect.any(Number) as number,
      warnings: [],
    });
  });

  test("the preflight names the account and the token the service saw", async () => {
    const dev = await developer();

    const result = await dev.run();

    expect(result.stderr).toMatch(new RegExp(`^testnotary: attesting as @${dev.user.login} with laptop token "[^"]+"$`, "m"));
  });

  test("an unpushed commit is fine: the attestation names the local head's tree", async () => {
    const dev = await developer();
    await dev.fixture.commit("Local work", { "src/feature.js": "export const answer = 42;\n" });

    const result = await dev.run();

    expect(result.exitCode).toBe(0);
    expect(summary(result)).toMatchObject({ attested: "true", tree: await dev.fixture.tree(), commit: await dev.fixture.revParse("HEAD") });
  });

  test("the suite may be left out only when the config declares exactly one", async () => {
    const two = await developer({ config: { suites: { unit: PASSING.suites.test, e2e: PASSING.suites.test } } });

    const unnamed = await two.run();
    const named = await two.run(["e2e"]);
    const undeclared = await two.run(["lint", "--json"]);

    expect(unnamed.exitCode).toBe(64);
    expect(unnamed.stderr).toContain("unit, e2e");
    expect(named.exitCode).toBe(0);
    expect(summary(named)).toMatchObject({ suite: "e2e", attested: "true" });
    expect(undeclared.exitCode).toBe(2);
    expect(JSON.parse(undeclared.stdout)).toMatchObject({ outcome: "refused", refusal: "config_invalid" });
  });
});

describe("what a run uploads", () => {
  test("a failing run is uploaded with outcome failed and no attestation", async () => {
    const dev = await developer({ config: FAILING });
    const mark = world.service.requests.length;

    const result = await dev.run(["--json"]);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "failed", exitCode: 3, attested: false, attestationUrl: null });
    expect(summary(result)).toMatchObject({ outcome: "failed", attested: "false", url: "" });
    const [upload] = uploadsSince(mark);
    expect(upload).toMatchObject({ outcome: "failed", exitCode: 3, suite: "test", tree: await dev.fixture.tree() });
    expect(upload).not.toHaveProperty("attestation");
  });

  test("a refused run uploads only its refusal code, tree and commit", async () => {
    const dev = await developer();
    await dev.fixture.write({ "notes.txt": "not committed\n" });
    const mark = world.service.requests.length;

    const result = await dev.run();

    expect(result.exitCode).toBe(2);
    expect(uploadsSince(mark)).toEqual([
      {
        repository: dev.repo.fullName,
        outcome: "refused",
        refusal: "dirty_tree",
        tree: await dev.fixture.tree(),
        commit: await dev.fixture.revParse("HEAD"),
      },
    ]);
  });
});

interface RefusalCase {
  name: string;
  refusal: string;
  /** Sets the scene and returns where to run and with what environment. */
  arrange(suite: Awaited<ReturnType<typeof markedSuite>>): Promise<{ cwd: string; machine: Machine; env?: Record<string, string | undefined> }>;
  /** A line of the explanation on stderr. */
  says: RegExp;
}

const refusals: RefusalCase[] = [
  {
    name: "a modified tracked file",
    refusal: "dirty_tree",
    async arrange(suite) {
      const dev = await developer({ config: suite.config, files: { "src/a.js": "1\n" } });
      await dev.fixture.write({ "src/a.js": "2\n" });
      return { cwd: dev.fixture.dir, machine: dev.machine };
    },
    says: /src\/a\.js[\s\S]*commit them/,
  },
  {
    name: "an untracked file that isn't ignored",
    refusal: "dirty_tree",
    async arrange(suite) {
      const dev = await developer({ config: suite.config, files: { ".gitignore": "build/\n" } });
      await dev.fixture.write({ "scratch.txt": "x\n" });
      return { cwd: dev.fixture.dir, machine: dev.machine };
    },
    says: /\?\? scratch\.txt/,
  },
  {
    name: "a base branch without testnotary.json, even with one committed locally",
    refusal: "no_config_on_base",
    async arrange(suite) {
      const dev = await developer({ config: null });
      await dev.fixture.commit("Add the config, not pushed", { "testnotary.json": JSON.stringify(suite.config) });
      return { cwd: dev.fixture.dir, machine: dev.machine };
    },
    says: /origin\/main has no testnotary\.json/,
  },
  {
    name: "a directory outside any git repo",
    refusal: "not_a_git_repo",
    async arrange() {
      const machine = await world.machine();
      return { cwd: machine.home, machine };
    },
    says: /not inside a git repository/,
  },
  {
    name: "a repo with no origin",
    refusal: "no_remote",
    async arrange(suite) {
      const dev = await developer({ config: suite.config });
      await dev.fixture.git("remote", "remove", "origin");
      return { cwd: dev.fixture.dir, machine: dev.machine };
    },
    says: /no remote named origin/,
  },
  {
    name: "a repo the App is not installed on",
    refusal: "repo_not_installed",
    async arrange(suite) {
      const dev = await developer({ config: suite.config });
      const other = await world.fixtureRepo({ config: suite.config });
      await world.hostOnGitHub(other, { owner: dev.repo.owner, name: "not-installed" });
      return { cwd: other.dir, machine: dev.machine };
    },
    says: /App is not installed on .+\/not-installed/,
  },
  {
    name: "a repo the App was removed from",
    refusal: "repo_not_installed",
    async arrange(suite) {
      const dev = await developer({ config: suite.config });
      const installation = [...world.github.state.installations.values()].find((candidate) => candidate.repoIds.has(dev.repo.id))!;
      await world.github.uninstallApp(installation);
      return { cwd: dev.fixture.dir, machine: dev.machine };
    },
    says: /App is not installed/,
  },
  {
    name: "an account that can only read the repo",
    refusal: "no_write_access",
    async arrange(suite) {
      const dev = await developer({ config: suite.config, permission: "read" });
      return { cwd: dev.fixture.dir, machine: dev.machine };
    },
    says: /can't write to/,
  },
  {
    name: "a revoked token",
    refusal: "token_rejected",
    async arrange(suite) {
      const dev = await developer({ config: suite.config });
      const token = await dev.token();
      expect((await world.runCli(["logout"], { cwd: dev.machine.home, machine: dev.machine })).exitCode).toBe(0);
      return { cwd: dev.fixture.dir, machine: dev.machine, env: { TESTNOTARY_TOKEN: token } };
    },
    says: /rejected TESTNOTARY_TOKEN/,
  },
];

describe("refusals before the command starts", () => {
  test.each(refusals)("$refusal: $name", async (scenario) => {
    const suite = await markedSuite();
    const { cwd, machine, env } = await scenario.arrange(suite);

    const result = await world.runCli(["run", "--json"], { cwd, machine, env });

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "refused", refusal: scenario.refusal, exitCode: null, attested: false });
    expect(summary(result)).toMatchObject({ outcome: "refused", attested: "false" });
    expect(result.stderr).toMatch(scenario.says);
    expect(suite.started()).toBe(false);
  });

  test("an ignored untracked file is not a dirty tree", async () => {
    const dev = await developer({ files: { ".gitignore": "build/\n" } });
    await dev.fixture.write({ "build/out.js": "x\n" });

    const result = await dev.run();

    expect(result.exitCode).toBe(0);
    expect(summary(result)).toMatchObject({ outcome: "passed", attested: "true" });
  });
});

describe("when the service can't say", () => {
  test("with the service unreachable the tests run, exit with their result and nothing is attested", async () => {
    const suite = await markedSuite(3);
    const dev = await developer({ config: suite.config });
    const mark = world.service.requests.length;

    const result = await dev.run(["--json"], { TESTNOTARY_URL: "http://127.0.0.1:9", TESTNOTARY_TOKEN: await dev.token() });

    expect(suite.started()).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "failed", exitCode: 3, attested: false, warnings: ["service_unreachable"] });
    expect(result.stderr).toMatch(/^testnotary: the Testnotary service could not be reached .*nothing will be attested$/m);
    expect(uploadsSince(mark)).toEqual([]);
  });

  test("an unreachable service doesn't hold a passing run up or attest it", async () => {
    const dev = await developer();

    const result = await dev.run(["--json"], { TESTNOTARY_URL: "http://127.0.0.1:9" });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "passed", attested: false, attestationUrl: null });
  });

  test("without a token the tests run with a warning on how to sign in, and nothing is attested", async () => {
    const suite = await markedSuite(0);
    const dev = await developer({ config: suite.config, signedIn: false });
    const mark = world.service.requests.length;

    const result = await dev.run(["--json"]);

    expect(suite.started()).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "passed", attested: false, warnings: ["not_signed_in"] });
    expect(result.stderr).toMatch(/^testnotary: not signed in: .*testnotary login.*sandbox token/m);
    const preflight = world.service.requests.slice(mark).find((request) => request.path === "/api/v1/preflight");
    expect(preflight?.headers).not.toHaveProperty("authorization");
    expect(uploadsSince(mark)).toEqual([]);
  });
});
