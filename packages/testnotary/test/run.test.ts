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
});
