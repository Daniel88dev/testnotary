import { test as base, type Page } from "@playwright/test";
import type { FakeAccount } from "./github/app.ts";
import { createWorld, POSTGRES_ENV, type World } from "./index.ts";
import { startPostgresServer } from "./postgres-server.ts";

/**
 * Playwright's `test` with a `world` fixture: one world per worker, served by `next dev`, and
 * `baseURL` pointing at it, so `page.goto("/")` opens this world's web app.
 */
export const test = base.extend<object, { world: World }>({
  world: [
    // eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring pattern.
    async ({}, use) => {
      const world = await createWorld({ service: "next" });
      await use(world);
      await world.close();
    },
    { scope: "worker", timeout: 180_000 },
  ],
  baseURL: async ({ world }, use) => {
    await use(world.service.url);
  },
});

export { expect } from "@playwright/test";

/**
 * Signs `user` in to the dashboard the way a person does: *Sign in with GitHub* on `/dashboard`,
 * through the fake GitHub's authorization (approved for `user`), and back. Ends on `next` (default
 * `/dashboard`). Each Playwright test has its own browser context, so its session is its own.
 */
export async function signIn(page: Page, world: World, user: FakeAccount, next = "/dashboard"): Promise<void> {
  world.github.webFlow.approveNext(user);
  await page.goto(next);
  await page.getByRole("button", { name: "Sign in with GitHub" }).first().click();
  await page.waitForURL((url) => url.origin === world.service.url && url.pathname === next.split("?")[0]);
}

/** Playwright `globalSetup`: starts this worktree's Postgres for the run and stops it afterwards. */
export async function globalSetup(): Promise<() => Promise<void>> {
  const { server, stop } = await startPostgresServer("playwright");
  process.env[POSTGRES_ENV] = JSON.stringify(server);
  return stop;
}
