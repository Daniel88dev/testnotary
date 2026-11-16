import { expect, signIn, test } from "@testnotary/test-world/playwright";
import type { Page } from "@playwright/test";
import type { FakeAccount, FakeRepo, FixtureRepo, Machine, World } from "@testnotary/test-world";

// The Verifications section and the commit page: a reviewer reads what each CI job's decision
// rested on. Verifications are made the way CI makes them (the job's OIDC token against the API),
// and every person and repo here is this file's own.

const CI_ENVIRONMENT = { os: "Linux", arch: "X64", image: "ubuntu24", imageVersion: "20261110.1", node: "v24.11.0" };
const PASSING = { suites: { unit: { command: ["node", "-e", "process.exit(0)"] } } };

interface Story {
  world: World;
  user: FakeAccount;
  fixture: FixtureRepo;
  repo: FakeRepo;
  machine: Machine;
  /** `testnotary run` on the laptop; must attest. */
  attest(): Promise<void>;
  /** Pushes a branch off `main` with `files` committed and returns GitHub's test merge commit for its pull request. */
  pullRequest(branch: string, number: number, files: Record<string, string>): Promise<{ sha: string; tree: string; parents: [string, string] }>;
  /** A CI job on `sha` asks for a verification; `runId` is the Actions run (and job). */
  verify(sha: string, number: number, runId?: number): Promise<{ id: string; result: string; reason: string | null }>;
  report(sha: string, number: number, id: string, outcome: "passed" | "failed"): Promise<void>;
  enforce(): Promise<void>;
}

async function story(world: World, page: Page, login: string, name: string): Promise<Story> {
  const user = world.github.addUser({ login });
  const fixture = await world.fixtureRepo({ config: PASSING, files: { ".gitignore": "node_modules\n" } });
  const repo = await world.hostOnGitHub(fixture, { owner: login, name, visibility: "public" });
  await world.github.installApp({ account: { login }, repos: [repo] });
  const machine = await world.machine();
  world.github.deviceFlow.approveNext(user);
  expect((await world.runCli(["login"], { cwd: machine.home, machine })).exitCode).toBe(0);
  const token = (sha: string, number: number, runId?: number) =>
    world.github.oidc.tokenFor({ repo, sha, ref: `refs/pull/${number}/merge`, eventName: "pull_request", ...(runId ? { runId } : {}) }, "https://testnotary.dev");
  return {
    world,
    user,
    fixture,
    repo,
    machine,
    async attest() {
      const result = await world.runCli(["run"], { cwd: fixture.dir, machine });
      expect(result.stderr).toMatch(/attested=true/);
    },
    async pullRequest(branch, number, files) {
      await fixture.checkout("main");
      await fixture.branch(branch);
      await fixture.commit(`Change on ${branch}`, files);
      await fixture.push();
      return fixture.testMerge({ base: "main", head: branch, number });
    },
    async verify(sha, number, runId) {
      const response = await page.request.post("/api/v1/verifications", {
        headers: { authorization: `Bearer ${await token(sha, number, runId)}` },
        data: { suite: "unit", environment: CI_ENVIRONMENT },
      });
      expect(response.status()).toBe(200);
      return ((await response.json()) as { verification: { id: string; result: string; reason: string | null } }).verification;
    },
    async report(sha, number, id, outcome) {
      const response = await page.request.post(`/api/v1/verifications/${id}/report`, {
        headers: { authorization: `Bearer ${await token(sha, number)}` },
        data: { outcome, durationMs: 4200, environment: CI_ENVIRONMENT },
      });
      expect(response.status()).toBe(201);
    },
    async enforce() {
      await world.enforce(repo);
    },
  };
}

test("the Verifications list filters by reason through the URL and shows shadow rows in their own words", async ({ page, world }) => {
  const s = await story(world, page, "tess-verify", "compass");
  // Shadow mode: one attested pull request (would have skipped), one with no attestation and one
  // changing a guarded file (both would have fallen back).
  const attested = await s.pullRequest("attested", 1, { "src/a.js": "export const a = 1;\n" });
  await s.attest();
  expect((await s.verify(attested.sha, 1)).result).toBe("would_skip");
  const unattested = await s.pullRequest("unattested", 2, { "src/b.js": "export const b = 2;\n" });
  expect(await s.verify(unattested.sha, 2)).toMatchObject({ result: "would_fall_back", reason: "no_attestation" });
  const guarded = await s.pullRequest("guarded", 3, { "package.json": '{"name":"compass"}\n' });
  expect(await s.verify(guarded.sha, 3)).toMatchObject({ result: "would_fall_back", reason: "guarded_file_changed" });
  // Enforce: the same unattested pull request now falls back for real.
  await s.enforce();
  expect(await s.verify(unattested.sha, 2)).toMatchObject({ result: "fallback", reason: "no_attestation" });

  await page.goto("/tess-verify/compass/verifications");
  await expect(page.getByRole("heading", { level: 1, name: "Verifications" })).toBeVisible();
  const rows = page.getByRole("table", { name: "Verifications" }).locator("tbody tr");
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText("Ran");
  await expect(rows.nth(1)).toContainText("Would have fallen back");
  await expect(rows.nth(1)).toContainText("Guarded file changed package.json");
  await expect(rows.nth(3)).toContainText("Would have skipped");
  await expect(rows.nth(3)).toContainText("on @tess-verify laptop");
  await expect(page.getByRole("table", { name: "Verifications" })).not.toContainText(/fallback/i);

  // Filtering by reason is a URL, the one Overview links.
  await page.goto("/tess-verify/compass/verifications?reason=no_attestation");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("Ran");
  await expect(rows.nth(1)).toContainText("Would have fallen back");
  await expect(rows).toContainText(["No attestation for this tree", "No attestation for this tree"]);
  await expect(page.getByRole("combobox", { name: "Fallback reason" })).toHaveValue(/reason=no_attestation/);

  // The result segments keep the reason; Shadow narrows to the "would have" rows.
  await page.getByRole("group", { name: "Result" }).getByRole("link", { name: /Shadow/ }).click();
  await expect(page).toHaveURL(/\/verifications\?result=shadow&reason=no_attestation$/);
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toContainText("Would have fallen back");

  // Choosing another reason navigates.
  await page.getByRole("combobox", { name: "Fallback reason" }).selectOption({ label: "Guarded file changed" });
  await expect(page).toHaveURL(/\/verifications\?result=shadow&reason=guarded_file_changed$/);
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toContainText("package.json");

  // A row opens its commit page.
  await rows.nth(0).getByRole("link", { name: guarded.sha.slice(0, 7) }).click();
  await expect(page).toHaveURL(new RegExp(`/tess-verify/compass/commit/${guarded.sha}$`));

  // The repo column lists the suite with its last result, linking the suite's verifications.
  await page.locator(".dash-nav a.suite", { hasText: "unit" }).click();
  await expect(page).toHaveURL(/\/tess-verify\/compass\/verifications\?suite=unit$/);
  await expect(rows).toHaveCount(4);
  await expect(page.locator(".dash-nav a.suite .dot.run")).toHaveCount(1);
  // Home shows when the repo was last verified.
  await signIn(page, world, s.user);
  const home = page.getByRole("table", { name: "Repositories" }).getByRole("row", { name: /tess-verify\/compass/ });
  await expect(home).toContainText("just now");
});

test("the commit page shows the matched attestation from another commit, the attester beside the commit author, gates and the CI log", async ({ page, world }) => {
  const s = await story(world, page, "ugo-verify", "sextant");
  const merge = await s.pullRequest("feature", 1, { "src/a.js": "export const a = 1;\n" });
  await s.attest();
  const verification = await s.verify(merge.sha, 1, 4242);
  expect(verification.result).toBe("would_skip");

  await page.goto(`/ugo-verify/sextant/commit/${merge.sha}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(merge.sha.slice(0, 7));
  const block = page.getByRole("region", { name: /^unit/ });
  await expect(block).toContainText("Would have skipped");
  const facts = block.getByRole("definition");
  const fact = (term: string) => block.locator("dt", { hasText: term }).locator("+ dd");
  await expect(facts.first()).toBeVisible();
  await expect(fact("Attested by")).toContainText('@ugo-verify laptop token "');
  await expect(fact("Commit author")).toHaveText("Fixture Author (pull request head)");
  await expect(fact("Matched by tree")).toContainText(merge.tree.slice(0, 7));
  await expect(fact("Matched by tree")).toContainText(`from commit ${merge.parents[1].slice(0, 7)}, not this one`);
  await expect(block.getByRole("link", { name: merge.parents[1].slice(0, 7) })).toHaveCount(0);
  await expect(block.getByRole("list", { name: "Gates" }).getByRole("listitem").last()).toContainText("shadow mode");
  await expect(block.getByRole("link", { name: "CI log" })).toHaveAttribute("href", /\/ugo-verify\/sextant\/actions\/runs\/4242\/job\/4242$/);
  // Environments appear only for an audit or a mismatch.
  await expect(block.getByRole("table", { name: "Environments side by side" })).toHaveCount(0);
  // The attestation, its own fields.
  await expect(page.getByLabel("Attestation payload")).toContainText(`"commit": "${merge.parents[1]}"`);
  await expect(block.getByRole("link", { name: "Open the run" })).toHaveAttribute("href", /\/ugo-verify\/sextant\/runs\/[0-9a-f-]{36}$/);
});

test("for an audit and a mismatch the commit page shows both environments side by side, base moved and the explain slot", async ({ page, world }) => {
  const s = await story(world, page, "vera-verify", "astrolabe");
  // The feature adds a.js; main later gets the same a.js on its own, so the merge's tree still
  // equals the attested tree while the base CI merges into has a commit the attested one lacks.
  const first = await s.pullRequest("feature", 1, { "src/a.js": "export const a = 1;\n" });
  await s.attest();
  await s.enforce();
  await world.audits.force(s.repo);
  const audit = await s.verify(first.sha, 1);
  expect(audit.result).toBe("audit");
  await s.report(first.sha, 1, audit.id, "passed");

  await page.goto(`/vera-verify/astrolabe/commit/${first.sha}`);
  const block = page.getByRole("region", { name: /^unit/ });
  await expect(block).toContainText("Audited");
  const environments = block.getByRole("table", { name: "Environments side by side" });
  await expect(environments).toBeVisible();
  await expect(environments.locator("thead")).toContainText("The attested run");
  await expect(environments.locator("thead")).toContainText("CI runner");
  await expect(environments).toContainText("Linux");
  await expect(environments).toContainText("v24.11.0");
  await expect(environments).toContainText("ubuntu24 20261110.1");
  await expect(block).toContainText("Base unchanged");
  await expect(block).toContainText("CI test job passed in 4 s");

  // Main moves with the same change; a re-built merge of the same tree is audited and fails.
  await s.fixture.checkout("main");
  await s.fixture.commit("Add a on main too", { "src/a.js": "export const a = 1;\n" });
  await s.fixture.push();
  const second = await s.fixture.testMerge({ base: "main", head: "feature", number: 1 });
  expect(second.tree).toBe(first.tree);
  await s.enforce();
  const failing = await s.verify(second.sha, 1);
  expect(failing.result).toBe("audit");
  await s.report(second.sha, 1, failing.id, "failed");

  await page.goto(`/vera-verify/astrolabe/commit/${second.sha}`);
  const mismatch = page.getByRole("region", { name: /^unit/ });
  await expect(mismatch).toContainText("Mismatch");
  await expect(mismatch).toContainText("Base moved");
  await expect(mismatch.getByRole("table", { name: "Environments side by side" })).toBeVisible();
  await expect(mismatch).toContainText("CI test job failed in 4 s");
  // Signed out on a public repo, the explain slot is hidden; the Mismatches page is where it lives.
  await expect(mismatch.getByRole("link", { name: /Explain/ })).toHaveCount(0);
  // An admin sees it.
  await signIn(page, world, s.user);
  await page.goto(`/vera-verify/astrolabe/commit/${second.sha}`);
  await expect(page.getByRole("region", { name: /^unit/ }).getByRole("link", { name: "Explain mismatch" })).toHaveAttribute(
    "href",
    /\/vera-verify\/astrolabe\/mismatches#mismatch-[0-9a-f-]{36}$/,
  );
});
