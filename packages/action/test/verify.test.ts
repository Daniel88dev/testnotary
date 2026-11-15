import { describe, expect, test } from "vitest";
import type { FakeAccount, FakeRepo, FixtureRepo, Machine } from "@testnotary/test-world";
import { useWorld } from "@testnotary/test-world/vitest";

// The gate job: the action in `mode: verify` asks the service whether an attestation names the
// tree CI builds, and answers with `skip` and `verification`. Each story starts on a laptop that
// attests with `testnotary run`, as a repo meets the product.

const world = useWorld();

const PASSING = { suites: { test: { command: ["node", "-e", "process.exit(0)"] } } };

interface Story {
  fixture: FixtureRepo;
  repo: FakeRepo;
  user: FakeAccount;
  machine: Machine;
  /** `testnotary run <args>` in the fixture repo, on the developer's laptop; must attest. */
  attest(args?: string[]): Promise<void>;
  /** The action in a gate job: `mode: verify`, on a simulated runner. */
  gate(options: { sha: string; event?: string; suite?: string }): ReturnType<typeof world.runAction>;
}

let repos = 0;

/** An installed repo, and a developer with write access signed in on their laptop. */
async function story(options: { config?: Record<string, unknown> } = {}): Promise<Story> {
  const n = ++repos;
  const fixture = await world.fixtureRepo({ config: options.config ?? PASSING });
  const repo = await world.hostOnGitHub(fixture, { owner: `acme-${n}`, name: "widgets" });
  await world.github.installApp({ account: { login: `acme-${n}`, type: "Organization" }, repos: [repo] });
  const user = world.github.addUser({ login: `dev-${n}` });
  world.github.setPermission(repo, user, "write");
  const machine = await world.machine();
  world.github.deviceFlow.approveNext(user);
  expect((await world.runCli(["login"], { cwd: machine.home, machine })).exitCode).toBe(0);
  return {
    fixture,
    repo,
    user,
    machine,
    async attest(args = []) {
      const result = await world.runCli(["run", ...args], { cwd: fixture.dir, machine });
      expect(result.stderr).toMatch(/attested=true/);
      expect(result.exitCode).toBe(0);
    },
    gate: ({ sha, event, suite }) =>
      world.runAction({ repo, sha, event, workspace: fixture.dir, inputs: { suite: suite ?? "test", mode: "verify" } }),
  };
}

/** A feature branch with one change, pushed, so a pull request can be opened from it. */
async function featureBranch(s: Story, files: Record<string, string> = { "src/a.js": "export const a = 1;\n" }) {
  await s.fixture.branch("feature");
  await s.fixture.commit("Add a", files);
  await s.fixture.push();
}

/** Switches the repo to enforce mode, as an admin's setting change would (the toggle comes later). */
async function enforce(repo: FakeRepo) {
  const sql = world.db.connect("app");
  await sql`insert into repo_setting_changes (repo_id, mode, audit_one_in, sandbox_audit_one_in, changed_by, reason)
            values (${repo.id}, 'enforce', 10, 5, null, 'test')`;
}

describe("the gate job", () => {
  test("a pull_request merge commit with the tree a laptop attested skips in enforce mode", async () => {
    const s = await story();
    await featureBranch(s);
    await s.attest();
    const merge = await s.fixture.testMerge({ base: "main", head: "feature" });
    await enforce(s.repo);

    const result = await s.gate({ sha: merge.sha });

    expect(result.exitCode).toBe(0);
    expect(result.outputs).toMatchObject({ result: "skip", skip: "true", ran: "false", reason: "" });
    expect(result.outputs.verification).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("the same pull request in shadow mode would skip, and does not skip", async () => {
    const s = await story();
    await featureBranch(s);
    await s.attest();
    const merge = await s.fixture.testMerge({ base: "main", head: "feature" });

    const result = await s.gate({ sha: merge.sha });

    expect(result.exitCode).toBe(0);
    expect(result.outputs).toMatchObject({ result: "would_skip", skip: "false", reason: "" });
    expect(result.outputs.verification).toMatch(/^[0-9a-f-]{36}$/);
  });
});
