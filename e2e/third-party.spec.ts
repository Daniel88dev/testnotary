import { expect, signIn, test } from "@testnotary/test-world/playwright";

test("the dashboard loads nothing from a third party: fonts are self-hosted and avatars come through the app", async ({ page, world }) => {
  const maria = world.github.addUser({ login: "maria-k" });
  const fixture = await world.fixtureRepo();
  const repo = world.github.addRepo(fixture, { owner: "maria-k", name: "api", visibility: "public" });
  await world.github.installApp({ account: { login: "maria-k" }, repos: [repo] });
  await signIn(page, world, maria);

  const origins = new Set<string>();
  const fonts: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.protocol === "data:") return;
    origins.add(url.origin);
    if (request.resourceType() === "font") fonts.push(url.pathname);
  });

  for (const path of ["/dashboard", "/maria-k/api", "/maria-k/api/runs", "/settings/tokens"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
  }
  const rail = page.getByRole("navigation", { name: "Testnotary" });
  await rail.getByLabel("Account menu").click();

  expect([...origins]).toEqual([world.service.url]);
  // Both typefaces were fetched, from the service itself.
  expect(fonts.some((path) => /space_grotesk.*\.woff2$/.test(path))).toBe(true);
  expect(fonts.some((path) => /ibm_plex_mono.*\.woff2$/.test(path))).toBe(true);

  const avatar = rail.locator("img.avatar");
  await expect(avatar).toHaveAttribute("src", `/api/avatars/${maria.id}`);
  expect(await avatar.evaluate((image) => (image as unknown as { complete: boolean; naturalWidth: number }).naturalWidth > 0)).toBe(true);
  // The image came from GitHub's avatars host to the service, never to the browser.
  expect(world.github.requestsTo("GET", `/avatars/u/${maria.id}`).length).toBeGreaterThan(0);
});
