import { ACTION_REF, PACKAGE_MANAGERS } from "@testnotary/core";
import { expect, test } from "@testnotary/test-world/playwright";

const TRUST = "Testnotary can't prove a test ran. It ties every skipped test job to a named GitHub account and re-runs a random share of them in CI.";
const BANNED = /\bproof\b|verified pass|can['’]t fake/i;

test("the landing page states the trust limit in the agreed words, never the banned ones, and links the footer pages", async ({ page, world }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Pass once\.\s*Skip in CI\./);
  const text = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  expect(text).toContain(TRUST);
  expect(text).not.toMatch(BANNED);

  // Every *Install the GitHub App* goes to the App's install page on GitHub.
  const installs = page.getByRole("link", { name: "Install the GitHub App" });
  expect(await installs.count()).toBeGreaterThanOrEqual(2);
  for (const link of await installs.all()) {
    await expect(link).toHaveAttribute("href", `${world.github.url}/apps/${world.github.app.slug}/installations/new`);
  }

  const footer = page.getByRole("navigation", { name: "Footer" });
  const expected: [string, string | RegExp][] = [
    ["Docs", "/docs"],
    ["Trust model", "/docs/limit"],
    ["GitHub", `https://github.com/${ACTION_REF.split("@")[0]}`],
    ["Status", "/api/v1/health"],
    ["Terms", "/terms"],
    ["Privacy", "/privacy"],
  ];
  await expect(footer.getByRole("link")).toHaveText(expected.map(([name]) => name));
  for (const [name, href] of expected) await expect(footer.getByRole("link", { name })).toHaveAttribute("href", href);

  // The footer's own pages exist.
  for (const path of ["/docs/limit", "/terms", "/privacy"]) {
    const response = await page.request.get(path);
    expect(response.status(), path).toBe(200);
  }
});

test("the setup steps show each package manager's commands, and the workflow the docs and init use", async ({ page }) => {
  await page.goto("/");
  const setup = page.locator("#setup");
  for (const name of ["pnpm", "npm", "yarn"] as const) {
    const pm = PACKAGE_MANAGERS[name];
    await setup.getByRole("tab", { name, exact: true }).click();
    await expect(setup.getByRole("tab", { name, exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(setup).toContainText(pm.add);
    await expect(setup).toContainText(`${pm.exec} testnotary init`);
    await expect(setup).toContainText(`${pm.exec} testnotary run unit`);
    await expect(setup).toContainText(`- run: ${pm.ciInstall}`);
    await expect(setup).toContainText(`uses: ${ACTION_REF}`);
  }
  await expect(setup).not.toContainText("dlx");
});

test("flipping a condition stops the pull request at its gate, and the attestation explains its real fields", async ({ page }) => {
  await page.goto("/");
  const decide = page.locator("#decide");
  const verdict = decide.getByRole("status");
  await expect(verdict).toContainText("Skips the test job");

  await decide.getByRole("button", { name: "The attestation is 26 hours old" }).click();
  await expect(decide.getByRole("button", { name: "The attestation is 26 hours old" })).toHaveAttribute("aria-pressed", "true");
  await expect(verdict).toContainText("Runs the tests");
  await expect(verdict).toContainText("24");

  // The canonical payload's own field names, each with its explanation.
  const anatomy = page.locator("#anatomy");
  for (const field of ["format", "repository", "suite", "command", "tree", "commit", "outcome", "attester", "endedAt"]) {
    await anatomy.getByRole("button", { name: new RegExp(`^"${field}"`) }).focus();
    await expect(anatomy.getByRole("status")).toContainText(field);
  }
});
