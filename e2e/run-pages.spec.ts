import { expect, signIn, test } from "@testnotary/test-world/playwright";
import { installLibrary, type FakeAccount, type FakeRepo, type FixtureRepo, type Machine, type World } from "@testnotary/test-world";

// The Runs section and the run page: what a reviewer reaches from the PR line's link, signed out
// on a public repo, read-only. Every person and repo here is this file's own.

interface Developer {
  user: FakeAccount;
  fixture: FixtureRepo;
  repo: FakeRepo;
  machine: Machine;
  /** `testnotary run` on the developer's laptop: its `url=` (empty unless it attested) and exit code. */
  run(): Promise<{ url: string; exitCode: number | null; stderr: string }>;
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
  await expect(page.getByLabel("Attestation payload")).toContainText(`"tree": "${merge.tree}"`);
  // Read-only: no control on the page.
  await expect(page.getByRole("main").getByRole("button", { name: /Revoke|Block|Explain/ })).toHaveCount(0);
});

test("the run page shows a run's reason, hashes, environment, token, unverified labels, warnings, not-pinned flags and env.set overrides", async ({ page, world }) => {
  const omar = await developer(world, "omar-runs", "beacon", PASSING);
  const token = await world.sandboxToken({ creator: omar.user, repo: omar.repo, name: "ci-agent-box" });
  const tree = "a".repeat(40);
  const commit = "b".repeat(40);
  const uploaded = await page.request.post("/api/v1/runs", {
    headers: { authorization: `Bearer ${token}` },
    data: {
      repository: "omar-runs/beacon",
      outcome: "failed",
      suite: "unit",
      tree,
      commit,
      command: ["node", "-e", "process.exit(1)"],
      exitCode: 1,
      startedAt: "2026-11-15T10:00:00.000Z",
      endedAt: "2026-11-15T10:00:02.500Z",
      durationMs: 2500,
      environment: { os: "linux", osVersion: "6.8.0", arch: "x64", node: "v24.11.0", packageManager: { name: "pnpm", version: "10.34.9" }, tz: "UTC", locale: "C.UTF-8" },
      session: { vendor: "Codex", id: "thread-7781", url: "https://example.test/sessions/7781" },
      passedEnv: ["DATABASE_URL"],
      guardedMatched: [],
      warnings: ["branch_behind_base"],
      notPinned: ["runtime"],
      baselineOverrides: ["TZ"],
    },
  });
  expect(uploaded.status()).toBe(201);
  const { run } = (await uploaded.json()) as { run: { id: string } };

  await page.goto(`/omar-runs/beacon/runs/${run.id}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Failed · exit 1");
  const facts = page.getByRole("region", { name: "Run", exact: true });
  await expect(facts).toContainText("The tests exited with code 1");
  await expect(facts).toContainText("node -e process.exit(1)");
  await expect(facts).toContainText(tree);
  await expect(facts).toContainText(commit);
  await expect(facts).toContainText("3 s");
  await expect(facts).toContainText("branch_behind_base");
  await expect(facts).toContainText("runtime not pinned");
  await expect(facts.locator("dt", { hasText: "env.set overrides" }).locator("+ dd")).toHaveText("TZ");
  const who = page.getByRole("region", { name: "Who and where" });
  await expect(who).toContainText("ci-agent-box sandbox token, created by @omar-runs");
  await expect(who).toContainText("Codex thread-7781 https://example.test/sessions/7781 unverified");
  await expect(who.getByRole("link")).toHaveCount(0);
  await expect(who).toContainText("linux 6.8.0");
  await expect(who).toContainText("pnpm 10.34.9");
  await expect(who).toContainText("UTC · C.UTF-8");
  await expect(page.getByRole("region", { name: "Verifications that used this attestation" })).toContainText("Only a passed run yields an attestation.");
});

test("the Runs list shows passed, failed and refused runs with refusal codes, flags a flaky suite and filters by outcome", async ({ page, world }) => {
  const flaky = { suites: { unit: { command: ["node", "-e", "process.exit(require('fs').existsSync('pass.flag') ? 0 : 1)"] } } };
  const pia = await developer(world, "pia-runs", "anchor", flaky);
  // The suite fails, then passes on the same tree (pass.flag is ignored, so the tree is unchanged).
  expect((await pia.run()).exitCode).toBe(1);
  await pia.fixture.write({ "pass.flag": "" });
  expect((await pia.run()).exitCode).toBe(0);
  // A dirty tree is refused before the tests start.
  await pia.fixture.write({ "src/wip.js": "export {};\n" });
  expect((await pia.run()).exitCode).toBe(2);

  await page.goto("/pia-runs/anchor/runs");
  await expect(page.getByRole("heading", { level: 1, name: "Runs" })).toBeVisible();
  await expect(page.getByText("1 passed, 1 failed, 1 refused. 1 suite failed and then passed on the same tree.")).toBeVisible();
  const rows = page.getByRole("table", { name: "Runs" }).locator("tbody tr");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("Refused");
  await expect(rows.nth(0)).toContainText("dirty_tree");
  await expect(rows.nth(0)).not.toContainText("Flaky suite");
  await expect(rows.nth(1)).toContainText("Passed");
  await expect(rows.nth(1)).toContainText("Flaky suite");
  await expect(rows.nth(1)).toContainText("@pia-runs laptop");
  await expect(rows.nth(2)).toContainText("Failed · exit 1");
  await expect(rows.nth(2)).toContainText("Flaky suite");

  // Filtering goes through the URL.
  await page.getByRole("group", { name: "Outcome" }).getByRole("link", { name: /Refused/ }).click();
  await expect(page).toHaveURL(/\/pia-runs\/anchor\/runs\?outcome=refused$/);
  await expect(rows).toHaveCount(1);
  await rows.nth(0).getByRole("link").first().click();
  await expect(page).toHaveURL(/\/pia-runs\/anchor\/runs\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("region", { name: "Run", exact: true })).toContainText("dirty_tree Uncommitted changes in the tree");
});

test("a deleted account's run reads deleted account on the Runs page and the run page", async ({ page, world }) => {
  const rhea = await developer(world, "rhea-runs", "harbor", PASSING);
  const attested = await rhea.run();
  expect(attested.url).not.toBe("");

  // Rhea deletes her account.
  await signIn(page, world, rhea.user);
  const rail = page.getByRole("navigation", { name: "Testnotary" });
  await rail.getByLabel("Account menu").click();
  await rail.getByRole("menuitem", { name: "Delete account" }).click();
  await page.getByRole("button", { name: "Delete account…" }).click();
  await page.getByRole("dialog", { name: "Delete your account?" }).getByRole("button", { name: "Delete my account" }).click();
  await expect(page.getByRole("status")).toContainText("Your account is deleted.");

  // Signed out, the repo's runs name the shared deleted account and never her login or id.
  await page.goto("/rhea-runs/harbor/runs");
  const row = page.getByRole("table", { name: "Runs" }).locator("tbody tr");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("deleted account");
  await expect(page.getByRole("main")).not.toContainText("@rhea-runs");
  await page.goto(attested.url);
  await expect(page.getByRole("region", { name: "Who and where" })).toContainText("deleted account");
  await expect(page.getByLabel("Attestation payload")).toContainText("(deleted account)");
  await expect(page.getByLabel("Attestation payload")).not.toContainText(String(rhea.user.id));
  // Nor does the page's HTML, the data the browser's components start from included.
  expect(await (await page.request.get(attested.url)).text()).not.toMatch(accountIdIn(rhea.user.id));
});

/** The payload's `"account": <id>` in a page's HTML, plain or inside the flight data's escaped JSON. */
function accountIdIn(id: number): RegExp {
  return new RegExp(`account\\\\?"\\s*:\\s*${id}\\b`);
}
