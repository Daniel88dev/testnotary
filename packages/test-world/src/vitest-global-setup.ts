import type { TestProject } from "vitest/node";
import { startPostgresServer, type PostgresServer } from "./postgres-server.ts";

declare module "vitest" {
  export interface ProvidedContext {
    testWorldPostgres: PostgresServer;
  }
}

/** Starts this worktree's Postgres once per `vitest run` and stops it afterwards. */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const { server, stop } = await startPostgresServer("vitest");
  project.provide("testWorldPostgres", server);
  return stop;
}
