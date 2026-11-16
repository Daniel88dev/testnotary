import { expect, signIn, test } from "@testnotary/test-world/playwright";
import type { Page } from "@playwright/test";
import type { FakeAccount, FakeRepo, FixtureRepo, World } from "@testnotary/test-world";

// A repo admin moves a repo from shadow to enforce on evidence, with its warnings, and handles a
// mismatch: explains it, then switches enforce back on. Verifications and reports are made the
// way CI makes them (the job's OIDC token against the API); every person and repo is this file's own.

const CI_ENVIRONMENT = { os: "Linux", arch: "X64", image: "ubuntu24", imageVersion: "20261110.1", node: "v24.11.0" };

interface Story {
  user: FakeAccount;
  fixture: FixtureRepo;
  repo: FakeRepo;
  /** A pull request off main with one change, attested on the laptop; returns GitHub's test merge commit. */
  attestedPullRequest(branch: string, number: number): Promise<{ sha: string }>;
  /** A CI job on the pull request's merge commit asks for a verification. */
  verify(sha: string, number: number): Promise<{ id: string; result: string }>;
  report(sha: string, number: number, id: string, outcome: "passed" | "failed"): Promise<void>;
}

async function story(world: World, page: Page, login: string, name: string, config: Record<string, unknown> = {}): Promise<Story> {
  const user = world.github.addUser({ login });
  const fixture = await world.fixtureRepo({ config: { suites: { unit: { command: ["node", "-e", "process.exit(0)"] } }, ...config } });
  const repo = await world.hostOnGitHub(fixture, { owner: login, name, visibility: "public" });
  await world.github.installApp({ account: { login }, repos: [repo] });
  const machine = await world.machine();
  world.github.deviceFlow.approveNext(user);
  expect((await world.runCli(["login"], { cwd: machine.home, machine })).exitCode).toBe(0);
  const token = (sha: string, number: number) =>
    world.github.oidc.tokenFor({ repo, sha, ref: `refs/pull/${number}/merge`, eventName: "pull_request" }, "https://testnotary.dev");
  return {
    user,
    fixture,
    repo,
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

test("shadow to enforce: the record beside the toggle, the under-20 warning that still switches, the rates and the guarded files", async ({ page, world }) => {
  const s = await story(world, page, "wren-enforce", "loom", { guarded: ["compose.yaml"] });
  const first = await s.attestedPullRequest("feature", 1);
  const shadow = await s.verify(first.sha, 1);
  expect(shadow.result).toBe("would_skip");
  await s.report(first.sha, 1, shadow.id, "passed");

  await signIn(page, world, s.user);
  await page.goto("/wren-enforce/loom/settings");
  const mode = page.getByRole("region", { name: "Mode" });
  await expect(mode).toContainText("Shadow mode");
  await expect(mode.locator("dl.kv")).toContainText("1 compared, 1 agreed, 0 mismatches");
  await expect(mode).toContainText("Fewer than 20 agreeing comparisons: 1 so far.");
  const toggle = mode.getByRole("switch", { name: "Enforce" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");

  // The warning comes back before the switch, which still goes through.
  await toggle.click();
  const confirm = page.getByRole("dialog", { name: "Switch to enforce?" });
  await expect(confirm).toContainText("Fewer than 20 agreeing comparisons: 1 so far.");
  await confirm.getByRole("button", { name: "Switch to enforce" }).click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(mode).toContainText("Enforcing");
  await expect(mode).toContainText("by @wren-enforce");
  await expect(page.locator(".dash-nav .modeline")).toContainText("Enforcing");
  // CI skips now.
  await world.audits.forbid(s.repo);
  expect((await s.verify(first.sha, 1)).result).toBe("skip");

  // Rates: raised for laptop tokens; the sandbox rate follows at twice as often.
  const rates = page.getByRole("region", { name: "Audit rate" });
  await expect(rates.getByLabel("Sandbox tokens")).toHaveValue("default");
  await expect(rates.getByLabel("Laptop tokens").locator("option")).toHaveText([
    "1 in 10",
    "1 in 9",
    "1 in 8",
    "1 in 7",
    "1 in 6",
    "1 in 5",
    "1 in 4",
    "1 in 3",
    "1 in 2",
    "Every attested job (1 in 1)",
  ]);
  await expect(rates.getByLabel("Sandbox tokens").locator("option")).toHaveText(["Twice the laptop rate", "1 in 5", "1 in 4", "1 in 3", "1 in 2", "Every attested job (1 in 1)"]);
  await rates.getByLabel("Laptop tokens").selectOption("4");
  await rates.getByRole("button", { name: "Save rates" }).click();
  await expect(rates.getByRole("status")).toHaveText("Saved.");
  await expect(page.locator(".dash-nav")).toContainText("Audits 1 in 4, sandbox 1 in 2.");

  // Guarded files: the product defaults and the repo's own, read-only.
  const guarded = page.getByRole("region", { name: "Guarded files" });
  const defaults = guarded.getByRole("list", { name: "Product defaults" });
  await expect(defaults).toContainText(".github/workflows/**");
  await expect(defaults).toContainText("pnpm-lock.yaml");
  await expect(guarded.getByRole("list", { name: "Added by this repo" }).getByRole("listitem")).toHaveText(["compose.yaml"]);
  await expect(guarded.locator("input, select, textarea, button")).toHaveCount(0);

  // A writer reads the settings and changes nothing.
  const writer = world.github.addUser({ login: "zeno-writer" });
  world.github.setPermission(s.repo, writer, "write");
  await page.context().clearCookies();
  await signIn(page, world, writer);
  await page.goto("/wren-enforce/loom/settings");
  await expect(page.getByRole("region", { name: "Mode" }).getByRole("switch", { name: "Enforce" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save rates" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Audit rate" })).toContainText("1 in 4");
});

test("explaining a mismatch: the amber count, enforce refused until an explanation, then switched on by hand", async ({ page, world }) => {
  const s = await story(world, page, "yara-explain", "lathe");
  // Enforce, and one commit skipped on Yara's attestations.
  const skipped = await s.attestedPullRequest("skipped", 1);
  expect(await world.changeRepoSettings({ admin: s.user, repo: s.repo, mode: "enforce" })).toMatchObject({ ok: true });
  await world.audits.forbid(s.repo);
  expect((await s.verify(skipped.sha, 1)).result).toBe("skip");
  // The next one is audited, and CI's tests fail: a mismatch, and the repo is back in shadow mode.
  const failing = await s.attestedPullRequest("failing", 2);
  await world.audits.force(s.repo);
  const audit = await s.verify(failing.sha, 2);
  expect(audit.result).toBe("audit");
  await s.report(failing.sha, 2, audit.id, "failed");

  // Signed out on the public repo: the mismatch, in full, and no controls.
  await page.goto("/yara-explain/lathe/mismatches");
  await expect(page.locator(".dash-nav nav").getByRole("link", { name: /Mismatches/ }).locator(".count.mm")).toHaveText("1");
  const open = page.getByRole("region", { name: /^Open/ });
  const article = open.getByRole("article");
  await expect(article).toHaveCount(1);
  await expect(article).toHaveAttribute("id", /^mismatch-[0-9a-f-]{36}$/);
  await expect(article).toContainText(failing.sha.slice(0, 7));
  await expect(article).toContainText("@yara-explain");
  await expect(article).toContainText("An audit, in enforce mode");
  await expect(article).toContainText("Failed in 4 s");
  await expect(article.getByRole("table", { name: "Environments side by side" })).toContainText("ubuntu24 20261110.1");
  await expect(article.getByRole("table", { name: "Skipped commits" }).getByRole("link")).toHaveText([skipped.sha.slice(0, 7)]);
  await expect(article.locator(".chip.mm")).toHaveText("Mismatch");
  await expect(page.getByRole("button", { name: "Explain mismatch" })).toHaveCount(0);

  // The admin's home counts it too.
  await signIn(page, world, s.user);
  await expect(page.getByRole("table", { name: "Repositories" }).getByRole("row", { name: /yara-explain\/lathe/ }).locator(".count.mm")).toHaveText("1");

  // Settings refuses enforce while it is open.
  await page.goto("/yara-explain/lathe/settings");
  const mode = page.getByRole("region", { name: "Mode" });
  await expect(mode).toContainText("Shadow mode");
  await expect(mode).toContainText("when a mismatch sent the repo back to shadow mode");
  await expect(mode).toContainText("One unexplained mismatch. Enforce stays off until an admin explains it on Mismatches.");
  await expect(mode.getByRole("switch", { name: "Enforce" })).toBeDisabled();
  // No "switching is allowed" beside a switch that isn't.
  await expect(mode).not.toContainText("Fewer than 20");

  // The admin explains it.
  await mode.getByRole("link", { name: "Mismatches" }).click();
  await page.getByRole("region", { name: /^Open/ }).getByRole("button", { name: "Explain mismatch" }).click();
  const dialog = page.getByRole("dialog", { name: `Explain the mismatch on ${failing.sha.slice(0, 7)}` });
  await expect(dialog).toContainText("It does not switch enforce back on");
  await dialog.getByRole("radio", { name: /Flaky test/ }).check();
  await dialog.getByRole("textbox", { name: "Note" }).fill("The clock test races on slow runners.");
  await dialog.getByRole("button", { name: "Record explanation" }).click();
  await expect(page.getByRole("region", { name: /^Open/ })).toContainText("No open mismatch on yara-explain/lathe.");
  const explained = page.getByRole("region", { name: "Explained" }).getByRole("article");
  await expect(explained).toContainText("Flaky test, explained by @yara-explain");
  await expect(explained).toContainText("The clock test races on slow runners.");
  await expect(page.locator(".dash-nav .count.mm")).toHaveCount(0);

  // Still in shadow mode: the explanation doesn't switch it. The admin does, past the warning.
  await page.goto("/yara-explain/lathe/settings");
  await expect(mode).toContainText("Shadow mode");
  await expect(mode).toContainText("Fewer than 20 agreeing comparisons since the last mismatch: 0 so far.");
  await mode.getByRole("switch", { name: "Enforce" }).click();
  await page.getByRole("dialog", { name: "Switch to enforce?" }).getByRole("button", { name: "Switch to enforce" }).click();
  await expect(mode.getByRole("switch", { name: "Enforce" })).toHaveAttribute("aria-checked", "true");
  expect((await s.verify(skipped.sha, 1)).result).toBe("audit");
});
