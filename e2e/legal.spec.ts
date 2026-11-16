import type { Page } from "@playwright/test";
import { expect, signIn, test } from "@testnotary/test-world/playwright";

// The terms and the privacy policy: Markdown in the repo, each with its effective date, covering
// every point the legal decisions settled, and linked wherever the spec says.

const EFFECTIVE = /Effective \d{1,2} (January|February|March|April|May|June|July|August|September|October|November|December) \d{4}/;

async function pageText(page: Page): Promise<string> {
  return (await page.getByRole("main").innerText()).replace(/\s+/g, " ").toLowerCase();
}

test("the terms name the operator and cover public records, the beta and acceptable use", async ({ page }) => {
  await page.goto("/terms");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Terms of service");
  await expect(page.getByRole("main").getByText(EFFECTIVE)).toBeVisible();
  await expect(page.getByRole("main").locator("time[datetime]").first()).toHaveAttribute("datetime", /^\d{4}-\d{2}-\d{2}$/);

  const main = page.getByRole("main");
  for (const heading of ["Who runs Testnotary", "Public records", "The beta", "Acceptable use", "Deleting your account", "Changes to these terms", "Law and courts"]) {
    await expect(main.getByRole("heading", { level: 2, name: heading })).toBeVisible();
  }
  await expect(main.getByRole("link", { name: "daniel@hrynusiw.cz" }).first()).toHaveAttribute("href", "mailto:daniel@hrynusiw.cz");
  const text = await pageText(page);
  for (const point of [
    "a private individual in the Czech Republic",
    "Czech law",
    "consumer",
    "are public and name the account",
    "states a fact, not bad faith",
    "never removed on request",
    "explanation",
    "anonymises",
    "as is",
    "free",
    "no warranty",
    "uptime",
    "30 days' notice",
    "knowingly upload false attestations",
    "someone else's token",
    "probe for data",
    "a mismatch alone is not grounds",
    "16 or older",
  ]) {
    expect(text, point).toContain(point.toLowerCase());
  }
});

test("the privacy policy covers the controller, lawful bases, recipients, rights, eligibility and every cookie", async ({ page }) => {
  await page.goto("/privacy");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Privacy policy");
  await expect(page.getByRole("main").getByText(EFFECTIVE)).toBeVisible();

  const main = page.getByRole("main");
  for (const heading of ["Who is responsible", "What we keep", "Why we may keep it", "Who receives it", "How long we keep it", "Your rights", "Who may sign up", "Cookies", "Changes to this policy"]) {
    await expect(main.getByRole("heading", { level: 2, name: heading })).toBeVisible();
  }
  const text = await pageText(page);
  for (const point of [
    "a private individual in the Czech Republic",
    "independent controller",
    "no data processing agreement",
    "performance of a contract",
    "legitimate interest",
    "Amazon Web Services",
    "eu-central-1",
    "processor",
    "GitHub",
    "separate controller",
    "We sell nothing",
    "no ads and no analytics",
    "Delete account",
    "within one month",
    "16 or older",
    "no cookie banner",
    "90 days",
    "30 days",
  ]) {
    expect(text, point).toContain(point.toLowerCase());
  }
});

test("the privacy policy names every cookie the site sets while signing in", async ({ page, world }) => {
  const maria = world.github.addUser({ login: "maria-k" });
  const set = new Set<string>();
  page.on("response", async (response) => {
    if (!response.url().startsWith(world.service.url)) return;
    for (const header of await response.headersArray()) {
      if (header.name.toLowerCase() === "set-cookie") set.add(header.value.split("=")[0]!.trim());
    }
  });
  await signIn(page, world, maria);
  expect([...set]).toContain("testnotary.session_token");

  await page.goto("/privacy");
  const cookies = page.getByRole("main").locator("#cookies ~ * code, #cookies ~ table code");
  const named = new Set((await cookies.allInnerTexts()).map((name) => name.trim()));
  for (const name of set) expect(named, `the privacy policy names ${name}`).toContain(name);
});

test("“What leaves your machine” and the privacy policy link each other", async ({ page }) => {
  await page.goto("/privacy");
  await page.getByRole("main").getByRole("link", { name: "What leaves your machine" }).first().click();
  await expect(page).toHaveURL(/\/docs\/data$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("What leaves your machine");

  await page.getByRole("main").getByRole("link", { name: "privacy policy" }).first().click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Privacy policy");
});

test("the line under Sign in with GitHub and the account menu lead to the terms and the privacy policy", async ({ page, world }) => {
  await page.goto("/dashboard");
  const legal = page.getByText("By signing in you agree to the Terms and accept the Privacy policy");
  await legal.getByRole("link", { name: "Terms" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Terms of service");
  await page.goBack();
  await legal.getByRole("link", { name: "Privacy policy" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Privacy policy");

  await signIn(page, world, world.github.addUser({ login: "devon-ruiz" }));
  const rail = page.getByRole("navigation", { name: "Testnotary" });
  for (const [item, heading] of [
    ["Terms", "Terms of service"],
    ["Privacy", "Privacy policy"],
  ] as const) {
    await page.goto("/dashboard");
    await rail.getByLabel("Account menu").click();
    await rail.getByRole("menuitem", { name: item }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(heading);
  }
});
