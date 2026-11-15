import { expect, signIn, test } from "@testnotary/test-world/playwright";
import type { World } from "@testnotary/test-world";

async function installedRepo(world: World, owner: string, name: string, visibility: "public" | "private") {
  const fixture = await world.fixtureRepo();
  const repo = world.github.addRepo(fixture, { owner, name, visibility });
  const { installation } = await world.github.installApp({ account: { login: owner, type: "Organization" }, repos: [repo] });
  return { repo, installation };
}

const SIGNED_OUT_SECTIONS = ["Overview", "Verifications", "Runs", "Mismatches", "People"];

test("a public repo's pages open signed out, read-only, with every control hidden", async ({ page, world }) => {
  await installedRepo(world, "oss-lab", "widgets", "public");

  const response = await page.goto("/oss-lab/widgets");
  expect(response?.status()).toBe(200);
  const column = page.getByRole("navigation", { name: "Repository" });
  await expect(page.getByText("oss-lab/widgets").first()).toBeVisible();
  await expect(page.locator(".modeline")).toHaveText(/Shadow\s*public/);
  await expect(column.getByRole("link")).toHaveText(SIGNED_OUT_SECTIONS);

  for (const section of SIGNED_OUT_SECTIONS) {
    await column.getByRole("link", { name: section }).click();
    await expect(page.getByRole("heading", { level: 1, name: section })).toBeVisible();
    await expect(page.locator("form")).toHaveCount(0);
    await expect(page.getByRole("main").getByRole("button")).toHaveCount(0);
  }
  expect((await page.goto("/oss-lab/widgets/settings"))?.status()).toBe(404);
});

test("a private repo's pages are not found for anyone GitHub does not show it to", async ({ page, world }) => {
  const { repo } = await installedRepo(world, "fernpay", "ledger", "private");
  const outsider = world.github.addUser({ login: "outsider" });
  const reader = world.github.addUser({ login: "ledger-reader" });
  world.github.setPermission(repo, reader, "read");

  expect((await page.request.get("/fernpay/ledger")).status()).toBe(404);
  expect((await page.request.get("/fernpay/ledger/runs")).status()).toBe(404);
  expect((await page.request.get("/fernpay/not-installed")).status()).toBe(404);

  await signIn(page, world, outsider);
  expect((await page.goto("/fernpay/ledger"))?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();

  await page.context().clearCookies();
  await signIn(page, world, reader);
  expect((await page.goto("/fernpay/ledger"))?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Repository" }).getByRole("link", { name: "Settings" })).toBeVisible();

  // Access follows GitHub at the next request: a removed collaborator no longer sees the repo.
  world.github.setPermission(repo, reader, "none");
  expect((await page.goto("/fernpay/ledger"))?.status()).toBe(404);
});

test("a public repo that goes private stops anonymous reads at the next request", async ({ page, world }) => {
  const { repo, installation } = await installedRepo(world, "oss-lab", "gadgets", "public");
  expect((await page.goto("/oss-lab/gadgets"))?.status()).toBe(200);

  await world.github.repositoryEvent(installation, repo, { action: "privatized" });

  expect((await page.goto("/oss-lab/gadgets"))?.status()).toBe(404);
});
