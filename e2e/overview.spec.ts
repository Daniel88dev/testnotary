import { expect, test } from "@testnotary/test-world/playwright";
import type { Locator } from "@playwright/test";
import type { World } from "@testnotary/test-world";

// The Overview: a repo admin judges at a glance whether Testnotary pays off and what to fix. A repo
// with no verification yet shows the setup checklist instead. Every person and repo here is this
// file's own.

const PASSING = { suites: { unit: { command: ["node", "-e", "process.exit(0)"] } } };

async function installedRepo(world: World, owner: string, name: string, config: Record<string, unknown> | null) {
  const user = world.github.addUser({ login: owner });
  const fixture = await world.fixtureRepo({ config, files: { ".gitignore": "node_modules\n" } });
  const repo = await world.hostOnGitHub(fixture, { owner, name, visibility: "public" });
  await world.github.installApp({ account: { login: owner }, repos: [repo] });
  return { user, fixture, repo };
}

const item = (checklist: Locator, name: string | RegExp) => checklist.getByRole("listitem").filter({ hasText: name });

test("a repo with no verifications shows the setup checklist with the missing step marked", async ({ page, world }) => {
  const { user, fixture } = await installedRepo(world, "ines-setup", "atlas", PASSING);

  await page.goto("/ines-setup/atlas");
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  const checklist = page.getByRole("list", { name: "Setup checklist" });
  await expect(item(checklist, "App installed")).toContainText("Done");
  await expect(item(checklist, "testnotary.json on the default branch")).toContainText("Done");
  await expect(item(checklist, "A first run from a laptop")).toContainText("Missing");
  await expect(item(checklist, "A first verification from CI")).toContainText("Missing");
  await expect(item(checklist, "Sandbox tokens for agents")).toContainText("Optional");
  await expect(item(checklist, "Enforce")).toContainText("Later");
  await expect(page.getByRole("region", { name: "Set up" })).toContainText("2 of 5 done");
  // Each item links its step of the setup guide.
  await expect(item(checklist, "App installed").getByRole("link")).toHaveAttribute("href", "/docs/setup#install-app");
  await expect(item(checklist, "A first verification from CI").getByRole("link", { name: "Add the action" })).toHaveAttribute("href", "/docs/setup#action");
  await expect(item(checklist, "A first run from a laptop").getByRole("link")).toHaveAttribute("href", "/docs/setup#login");
  // Nothing else of the Overview is shown yet.
  await expect(page.getByRole("region", { name: "Live verifications" })).toHaveCount(0);

  // The developer signs in on a laptop and attests: the laptop step is done.
  const machine = await world.machine();
  world.github.deviceFlow.approveNext(user);
  expect((await world.runCli(["login"], { cwd: machine.home, machine })).exitCode).toBe(0);
  expect((await world.runCli(["run"], { cwd: fixture.dir, machine })).stderr).toMatch(/attested=true/);
  await page.reload();
  await expect(item(checklist, "A first run from a laptop")).toContainText("Done");
  await expect(page.getByRole("region", { name: "Set up" })).toContainText("3 of 5 done");

  // A repo whose default branch has no testnotary.json misses that step.
  await installedRepo(world, "ines-bare", "orrery", null);
  await page.goto("/ines-bare/orrery");
  await expect(item(checklist, "testnotary.json on the default branch")).toContainText("Missing");
  await expect(page.getByRole("region", { name: "Set up" })).toContainText("1 of 5 done");
});
