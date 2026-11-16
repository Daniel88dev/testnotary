import { test as base, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { createWorld, type FakeAccount, type FakeInstallation, type FakeRepo, type FixtureRepo, type World } from "@testnotary/test-world";
import { signIn } from "@testnotary/test-world/playwright";

// Retention and the repo lifecycle as people see them. This file's world is its own: the retention
// job deletes by age across the whole database, and the shared world's other specs keep theirs.
// The service (`next dev`) keeps real time, so the job runs at a moment 91 days on instead.

const DAY_MS = 86_400_000;
const CI_ENVIRONMENT = { os: "Linux", arch: "X64", image: "ubuntu24", imageVersion: "20261110.1", node: "v24.11.0" };

const test = base.extend<object, { world: World }>({
  world: [
    // eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring pattern.
    async ({}, use) => {
      const world = await createWorld({ service: "next" });
      await use(world);
      await world.close();
    },
    { scope: "worker", timeout: 180_000 },
  ],
  baseURL: async ({ world }, use) => {
    await use(world.service.url);
  },
});

interface Story {
  user: FakeAccount;
  fixture: FixtureRepo;
  repo: FakeRepo;
  installation: FakeInstallation;
  /** A pull request off main with one change, attested on the laptop; returns GitHub's test merge commit. */
  attestedPullRequest(branch: string, number: number): Promise<{ sha: string; tree: string }>;
  /** A CI job on the pull request's merge commit asks for a verification. */
  verify(sha: string, number: number): Promise<{ id: string; result: string }>;
  report(sha: string, number: number, id: string, outcome: "passed" | "failed"): Promise<void>;
}

async function story(world: World, page: Page, login: string, name: string, visibility: "public" | "private" = "public"): Promise<Story> {
  const user = world.github.addUser({ login });
  const fixture = await world.fixtureRepo({ config: { suites: { unit: { command: ["node", "-e", "process.exit(0)"] } } } });
  const repo = await world.hostOnGitHub(fixture, { owner: login, name, visibility });
  const { installation } = await world.github.installApp({ account: { login }, repos: [repo] });
  const machine = await world.machine();
  world.github.deviceFlow.approveNext(user);
  expect((await world.runCli(["login"], { cwd: machine.home, machine })).exitCode).toBe(0);
  const token = (sha: string, number: number) =>
    world.github.oidc.tokenFor({ repo, sha, ref: `refs/pull/${number}/merge`, eventName: "pull_request" }, "https://testnotary.dev");
  return {
    user,
    fixture,
    repo,
    installation,
    async attestedPullRequest(branch, number) {
      await fixture.checkout("main");
      await fixture.branch(branch);
      await fixture.commit(`Change on ${branch}`, { [`src/${branch}.js`]: `export const n = ${number};\n` });
      await fixture.push();
      expect((await world.runCli(["run"], { cwd: fixture.dir, machine })).stderr).toMatch(/attested=true/);
      return fixture.testMerge({ base: "main", head: branch, number });
    },
    async verify(sha, number) {
      const response = await page.request.post("/api/v1/verifications", {
        headers: { authorization: `Bearer ${await token(sha, number)}` },
        data: { suite: "unit", environment: CI_ENVIRONMENT },
      });
      expect(response.status()).toBe(200);
      return ((await response.json()) as { verification: { id: string; result: string } }).verification;
    },
    async report(sha, number, id, outcome) {
      const response = await page.request.post(`/api/v1/verifications/${id}/report`, {
        headers: { authorization: `Bearer ${await token(sha, number)}` },
        data: { outcome, durationMs: 4200, environment: CI_ENVIRONMENT },
      });
      expect(response.status()).toBe(201);
    },
  };
}

test("retention prunes a mismatch's runs and verifications, and the mismatch and its explanation still render in full", async ({ page, world }) => {
  const s = await story(world, page, "rowan-retain", "abacus");
  const pull = await s.attestedPullRequest("feature", 1);
  const shadow = await s.verify(pull.sha, 1);
  expect(shadow.result).toBe("would_skip");
  await s.report(pull.sha, 1, shadow.id, "failed");
  expect(await world.explainMismatch({ admin: s.user, repo: s.repo, verification: shadow.id, cause: "flaky_test", note: "The clock test races." })).toBe(true);

  await world.runRetentionJob({ at: new Date(Date.now() + 91 * DAY_MS) });

  // Signed out on the public repo: the runs are gone.
  await page.goto("/rowan-retain/abacus/runs");
  await expect(page.getByText("No runs yet.")).toBeVisible();
  // The mismatch shows its account, its payload, both environments and its explanation from its own copies.
  await page.goto("/rowan-retain/abacus/mismatches");
  const article = page.getByRole("region", { name: "Explained" }).getByRole("article");
  await expect(article).toHaveCount(1);
  await expect(article).toContainText(pull.sha.slice(0, 7));
  await expect(article).toContainText("@rowan-retain laptop");
  await expect(article).toContainText("A shadow comparison: CI would have skipped");
  await expect(article).toContainText("Failed in 4 s");
  await expect(article).toContainText("Flaky test, explained by @rowan-retain");
  await expect(article).toContainText("The clock test races.");
  await expect(article.getByRole("table", { name: "Environments side by side" })).toContainText("ubuntu24 20261110.1");
  await expect(article.getByRole("table", { name: "Environments side by side" })).toContainText(process.platform);
  await expect(article.getByLabel("Attestation payload")).toContainText(`"tree": "${pull.tree}"`);
  await expect(article.getByLabel("Attestation payload")).toContainText('"suite": "unit"');
  // The rows it came from are gone, and it says so instead of linking to a page that isn't there.
  await expect(article).toContainText("Attested run");
  await expect(article).toContainText("deleted after 90 days");
  await expect(article.getByRole("link", { name: /^[0-9a-f]{8}$/ })).toHaveCount(0);
});

test("uninstalling hides the repo at once, and a reinstall brings its history back in shadow mode", async ({ page, world }) => {
  const s = await story(world, page, "sana-leave", "kiln");
  expect(await world.changeRepoSettings({ admin: s.user, repo: s.repo, mode: "enforce" })).toMatchObject({ ok: true });
  await s.attestedPullRequest("feature", 1);
  await signIn(page, world, s.user);
  const row = page.getByRole("table", { name: "Repositories" }).getByRole("row", { name: /sana-leave\/kiln/ });
  await expect(row).toContainText("Enforcing");

  await world.github.uninstallApp(s.installation);

  await page.goto("/sana-leave/kiln/runs");
  await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { level: 1, name: "Repositories" })).toBeVisible();
  await expect(page.getByRole("row", { name: /sana-leave\/kiln/ })).toHaveCount(0);

  await world.github.installApp({ account: { login: "sana-leave" }, repos: [s.repo] });

  await page.goto("/dashboard");
  await expect(row).toContainText("Shadow");
  await page.goto("/sana-leave/kiln/runs");
  await expect(page.getByRole("table", { name: "Runs" }).locator("tbody tr")).toHaveCount(1);
});

test("a private repo turned public shows its retained history signed out, and turned private again it is not found", async ({ page, world }) => {
  const s = await story(world, page, "tova-vis", "quarry", "private");
  await s.attestedPullRequest("feature", 1);

  await page.goto("/tova-vis/quarry/runs");
  await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();

  await world.github.repositoryEvent(s.installation, s.repo, { action: "publicized" });
  await page.goto("/tova-vis/quarry/runs");
  await expect(page.getByRole("table", { name: "Runs" }).locator("tbody tr")).toHaveCount(1);

  await world.github.repositoryEvent(s.installation, s.repo, { action: "privatized" });
  await page.goto("/tova-vis/quarry/runs");
  await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
});
