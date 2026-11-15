import { expect, test } from "@testnotary/test-world/playwright";
import { installLibrary, type FakeAccount, type FakeRepo, type FixtureRepo, type Machine, type World } from "@testnotary/test-world";

// The Runs section and the run page: what a reviewer reaches from the PR line's link, signed out
// on a public repo, read-only. Every person and repo here is this file's own.

interface Developer {
  user: FakeAccount;
  fixture: FixtureRepo;
  repo: FakeRepo;
  machine: Machine;
  /** `testnotary run` on the developer's laptop: its `url=` (empty unless it attested) and exit code. */
  run(): Promise<{ url: string; exitCode: number; stderr: string }>;
}

/** A public repo installed on its owner's account, and its owner signed in on a laptop. */
async function developer(world: World, login: string, name: string, config: Record<string, unknown>, files: Record<string, string> = {}): Promise<Developer> {
  const user = world.github.addUser({ login });
  const fixture = await world.fixtureRepo({ config, files: { ".gitignore": "node_modules\n*.flag\n", ...files } });
  const repo = await world.hostOnGitHub(fixture, { owner: login, name, visibility: "public" });
  await world.github.installApp({ account: { login }, repos: [repo] });
  const machine = await world.machine();
  world.github.deviceFlow.approveNext(user);
  expect((await world.runCli(["login"], { cwd: machine.home, machine })).exitCode).toBe(0);
  return {
    user,
    fixture,
    repo,
    machine,
    async run() {
      const result = await world.runCli(["run"], { cwd: fixture.dir, machine });
      return { url: / url=(\S*)/.exec(result.stderr)?.[1] ?? "", exitCode: result.exitCode, stderr: result.stderr };
    },
  };
}

const PASSING = { suites: { unit: { command: ["node", "-e", "process.exit(0)"] } } };

test("the PR line's run link opens the run page signed out on a public repo", async ({ page, world }) => {
  const nell = await developer(world, "nell-runs", "lantern", PASSING, { "package.json": `${JSON.stringify({ name: "lantern", private: true, packageManager: "pnpm@10.34.9" })}\n` });
  await nell.fixture.branch("feature");
  await nell.fixture.commit("Add a", { "src/a.js": "export const a = 1;\n" });
  await nell.fixture.push();
  const attested = await nell.run();
  expect(attested.url, attested.stderr).not.toBe("");

  // CI on the pull request: shadow mode, so the step runs the tests and writes the PR line.
  const merge = await nell.fixture.testMerge({ base: "main", head: "feature" });
  const workspace = await nell.fixture.ciCheckout(merge.sha);
  await installLibrary(workspace);
  const ci = await world.runAction({ repo: nell.repo, sha: merge.sha, workspace, inputs: { suite: "unit" } });
  expect(ci.outputs).toMatchObject({ result: "would_skip" });
  const link = /\[[^\]]+\]\(([^)]+\/runs\/[^)]+)\)/.exec(ci.summary)?.[1];
  expect(link).toBe(attested.url);

  // A reviewer, signed out, follows it.
  expect((await page.context().cookies()).length).toBe(0);
  await page.goto(link!);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Passed");
  const run = page.getByRole("region", { name: "Run", exact: true });
  await expect(run).toContainText("node -e process.exit(0)");
  await expect(run).toContainText(merge.parents[1]);
  // The verification that used its attestation, linking the commit CI built.
  const used = page.getByRole("region", { name: "Verifications that used this attestation" });
  await expect(used.getByRole("link", { name: merge.sha.slice(0, 7) })).toHaveAttribute("href", `/nell-runs/lantern/commit/${merge.sha}`);
  await expect(used).toContainText("Would have skipped");
  // Read-only: no control on the page.
  await expect(page.getByRole("main").getByRole("button", { name: /Revoke|Block|Explain/ })).toHaveCount(0);
});
