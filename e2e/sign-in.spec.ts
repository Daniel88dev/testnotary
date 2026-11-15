import { expect, signIn, test } from "@testnotary/test-world/playwright";

test("signing in with GitHub creates a session, and signing out ends it", async ({ page, world }) => {
  const maria = world.github.addUser({ login: "maria-k" });

  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Sign in to see your repositories" })).toBeVisible();
  await expect(page.getByText("By signing in you agree to the Terms and accept the Privacy policy")).toBeVisible();

  await signIn(page, world, maria);
  const rail = page.getByRole("navigation", { name: "Testnotary" });
  await rail.getByLabel("Account menu").click();
  await expect(rail.getByText("Signed in as @maria-k")).toBeVisible();
  for (const item of ["Tokens", "Delete account", "Terms", "Privacy", "Sign out"]) {
    await expect(rail.getByRole("menuitem", { name: item })).toBeVisible();
  }
  const signedInCookies = await page.context().cookies();

  await rail.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to see your repositories" })).toBeVisible();

  // A copy of the signed-out session's cookies no longer signs anyone in.
  await page.context().addCookies(signedInCookies);
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Sign in to see your repositories" })).toBeVisible();
});

test("a person who cancels on GitHub stays signed out and is told so", async ({ page, world }) => {
  world.github.webFlow.denyNext();
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Sign in with GitHub" }).click();

  await expect(page.getByRole("alert")).toHaveText("Signing in with GitHub did not finish. Try again.");
  await expect(page.getByRole("heading", { name: "Sign in to see your repositories" })).toBeVisible();
});
