import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test as base, expect } from "@playwright/test";
import { createWorld, type World } from "@testnotary/test-world";
import { signIn } from "@testnotary/test-world/playwright";

// A material change to the terms or the privacy policy shows a dashboard line for 30 days from the
// file's effective date. This file's world reads its legal pages from a directory of its own, so a
// test can date them.

const LEGAL_SOURCE = path.resolve(import.meta.dirname, "../apps/web/content/legal");
const DAY_MS = 86_400_000;

const test = base.extend<object, { legal: { world: World; dir: string } }>({
  legal: [
    // eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring pattern.
    async ({}, use) => {
      const dir = await mkdtemp(path.join(tmpdir(), "testnotary-legal-"));
      for (const name of ["terms.md", "privacy.md"]) await writeFile(path.join(dir, name), await readFile(path.join(LEGAL_SOURCE, name)));
      const world = await createWorld({ service: "next", serviceEnv: { LEGAL_DIR: dir } });
      await use({ world, dir });
      await world.close();
      await rm(dir, { recursive: true, force: true });
    },
    { scope: "worker", timeout: 180_000 },
  ],
  baseURL: async ({ legal }, use) => {
    await use(legal.world.service.url);
  },
});

/** Gives a page a new version taking effect `daysAgo` days before today. */
async function dated(dir: string, name: "terms" | "privacy", version: number, daysAgo: number): Promise<void> {
  const file = path.join(dir, `${name}.md`);
  const effective = new Date(Date.now() - daysAgo * DAY_MS).toISOString().slice(0, 10);
  const text = (await readFile(file, "utf8")).replace(/^effective: .*$/m, `effective: ${effective}`).replace(/^version: .*$/m, `version: ${version}`);
  await writeFile(file, text);
}

test("a material change dated within 30 days shows a dashboard line, and an older one doesn't", async ({ page, legal }) => {
  const { world, dir } = legal;
  await signIn(page, world, world.github.addUser({ login: "maria-k" }));
  const line = page.getByRole("status").filter({ hasText: "changed on" });

  // The first version of each page is not a change.
  await dated(dir, "terms", 1, 2);
  await dated(dir, "privacy", 1, 2);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Repositories" })).toBeVisible();
  await expect(line).toHaveCount(0);

  await dated(dir, "privacy", 2, 10);
  await page.reload();
  await expect(line).toHaveCount(1);
  await expect(line).toContainText("The Privacy policy changed on");
  await line.getByRole("link", { name: "Read the Privacy policy" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Privacy policy");

  await dated(dir, "privacy", 2, 31);
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Repositories" })).toBeVisible();
  await expect(line).toHaveCount(0);

  // On a repo's pages too.
  await dated(dir, "terms", 3, 29);
  const fixture = await world.fixtureRepo();
  const repo = world.github.addRepo(fixture, { owner: "maria-k", name: "api", visibility: "public" });
  await world.github.installApp({ account: { login: "maria-k" }, repos: [repo] });
  await page.goto("/maria-k/api");
  await expect(line).toHaveCount(1);
  await expect(line).toContainText("The Terms of service changed on");
});
