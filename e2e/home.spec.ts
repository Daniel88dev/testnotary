import { expect, signIn, test } from "@testnotary/test-world/playwright";
import type { World } from "@testnotary/test-world";

async function githubRepo(world: World, owner: string, name: string, visibility: "public" | "private") {
  const fixture = await world.fixtureRepo();
  return world.github.addRepo(fixture, { owner, name, visibility });
}

test("home lists every installed repo the person can read on GitHub, with its mode", async ({ page, world }) => {
  const maria = world.github.addUser({ login: "maria-k" });
  const api = await githubRepo(world, "maria-k", "api", "public");
  const infra = await githubRepo(world, "maria-k", "infra", "private");
  await world.github.installApp({ account: { login: "maria-k" }, repos: [api, infra] });
  const web = await githubRepo(world, "fernpay", "web", "private");
  const payroll = await githubRepo(world, "fernpay", "payroll", "private");
  await world.github.installApp({ account: { login: "fernpay", type: "Organization" }, repos: [web, payroll] });
  world.github.setPermission(web, maria, "write");

  await signIn(page, world, maria);

  await expect(page.getByRole("heading", { level: 1, name: "Repositories" })).toBeVisible();
  const table = page.getByRole("table", { name: "Repositories" });
  const rows = table.getByRole("row");
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(1)).toContainText("fernpay/web private");
  await expect(rows.nth(2)).toContainText("maria-k/api public");
  await expect(rows.nth(2)).toContainText("Shadow");
  await expect(rows.nth(3)).toContainText("maria-k/infra private");
  await expect(table).not.toContainText("payroll");
  await expect(page.getByText("testnotary login")).toBeVisible();

  await table.getByRole("link", { name: "maria-k/infra" }).click();
  await expect(page).toHaveURL(/\/maria-k\/infra$/);
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
});

test("with nothing installed, home offers the install, the CLI sign-in command and the setup guide", async ({ page, world }) => {
  const devon = world.github.addUser({ login: "devon-ruiz" });

  await signIn(page, world, devon);

  await expect(page.getByText("No repo you can read has Testnotary installed yet.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Install the GitHub App" })).toHaveAttribute(
    "href",
    `${world.github.url}/apps/${world.github.app.slug}/installations/new`,
  );
  await expect(page.getByText("testnotary login", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Read the setup guide" })).toHaveAttribute("href", "/docs/setup");
  await expect(page.getByRole("table")).toHaveCount(0);
});

test("with nothing installed by them, home lists the repos someone else installed above the install offer", async ({ page, world }) => {
  const priya = world.github.addUser({ login: "priya-n" });
  const shop = await githubRepo(world, "acme-shop", "storefront", "private");
  await world.github.installApp({ account: { login: "acme-shop", type: "Organization" }, repos: [shop] });
  world.github.setPermission(shop, priya, "read");

  await signIn(page, world, priya);

  const others = page.getByRole("table", { name: "Installed by others" });
  await expect(others).toContainText("acme-shop/storefront");
  const install = page.getByRole("link", { name: "Install the GitHub App" });
  await expect(install).toBeVisible();
  const [tableBox, installBox] = await Promise.all([others.boundingBox(), install.boundingBox()]);
  expect(tableBox!.y).toBeLessThan(installBox!.y);
});
