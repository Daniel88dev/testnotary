import { afterAll, beforeAll, inject } from "vitest";
import { createWorld, type World, type WorldOptions } from "./index.ts";
// For the ProvidedContext augmentation only.
import type {} from "./vitest-global-setup.ts";

/**
 * Gives a test file its own world: created before the file's first test, closed after its last.
 * Use it at the top level of a test file:
 *
 *   const world = useWorld();
 *   test("…", async () => { await fetch(`${world.service.url}/api/v1/health`) });
 */
export function useWorld(options: Omit<WorldOptions, "postgres"> = {}): World {
  let world: World | undefined;
  beforeAll(async () => {
    world = await createWorld({ ...options, postgres: inject("testWorldPostgres") });
  });
  afterAll(async () => {
    await world?.close();
  });
  return new Proxy({} as World, {
    get(_, key) {
      if (!world) throw new Error("The world is created in beforeAll; use it inside a test or hook.");
      return world[key as keyof World];
    },
  });
}
