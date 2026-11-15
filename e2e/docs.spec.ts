import { expect, test } from "@testnotary/test-world/playwright";

// The docs tree as the spec lists it ("Docs": 28 pages in six groups, plus the licensing and
// security pages added later). The Reference group is T-831's: its pages exist as stubs here.
const WRITTEN: Record<string, string[]> = {
  "Start here": ["What Testnotary does", "Setup guide", "How a skip is decided"],
  Guides: ["Agents and sandbox tokens", "Shadow mode and enforce", "Audits and mismatches", "Forks, Dependabot and Copilot"],
  "Workflow recipes": ["Gate job", "Matrix jobs", "Merge queues and up-to-date branches", "Coverage and test reports"],
  "Test command recipes": [
    "Build before the tests",
    "Postgres and other services",
    "Playwright and other caches",
    "Shell features and .env files",
    "Run the suite in Docker",
    "A pre-push hook",
  ],
  Trust: ["What Testnotary can’t prove", "What leaves your machine", "Limits in v1", "Security", "Licensing"],
};
const REFERENCE = [
  "testnotary.json",
  "CLI commands",
  "Exit codes and output",
  "Refusal codes",
  "Action inputs and outputs",
  "Fallback reason codes",
  "What the pull request shows",
  "Guarded files",
];

test("every page in the tree exists: the written groups with content, the Reference group as stubs whose links resolve", async ({ page, request }) => {
  await page.goto("/docs/setup");
  const tree = page.getByRole("navigation", { name: "Docs" });

  for (const [group, titles] of Object.entries(WRITTEN)) {
    await expect(tree.getByRole("heading", { name: group, exact: true })).toBeVisible();
    for (const title of titles) {
      const href = await tree.getByRole("link", { name: title, exact: true }).getAttribute("href");
      expect(href, title).toMatch(/^\/docs\/[a-z-]+$/);
      await page.goto(href!);
      // The guide keeps its approved heading; every other page is headed by its title.
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(title === "Setup guide" ? "Set up Testnotary" : title);
      await expect(page).toHaveTitle(new RegExp(`^${title.replace(/[.?]/g, "\\$&")} · Testnotary docs$`));
      const article = page.getByRole("main");
      await expect(article).not.toContainText("This page will hold");
      // Content, not a title alone: at least a few paragraphs of text.
      expect((await article.innerText()).length, title).toBeGreaterThan(600);
    }
  }

  await page.goto("/docs/setup");
  for (const title of REFERENCE) {
    const href = await tree.getByRole("link", { name: title, exact: true }).getAttribute("href");
    const response = await request.get(href!);
    expect(response.status(), title).toBe(200);
  }

  // Every link inside the docs resolves, the stubs' included.
  const hrefs = new Set<string>();
  for (const link of await page.locator("a[href^='/docs']").all()) hrefs.add((await link.getAttribute("href"))!.split("#")[0]!);
  for (const href of hrefs) {
    await page.goto(href);
    for (const link of await page.getByRole("main").locator("a[href^='/docs']").all()) {
      const target = (await link.getAttribute("href"))!.split("#")[0]!;
      expect((await request.get(target)).status(), `${href} → ${target}`).toBe(200);
    }
  }
});
