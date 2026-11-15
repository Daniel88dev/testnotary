import { test as base } from "@playwright/test";
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

/** Playwright `globalSetup`: starts this worktree's Postgres for the run and stops it afterwards. */
export async function globalSetup(): Promise<() => Promise<void>> {
  const { server, stop } = await startPostgresServer("playwright");
  process.env[POSTGRES_ENV] = JSON.stringify(server);
  return stop;
}
