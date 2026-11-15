import { AsyncLocalStorage } from "node:async_hooks";

/** What the service needs from its surroundings. Later tickets add fields here. */
export interface ServiceConfig {
  /** Postgres, as the app role: INSERT and SELECT on history tables, nothing else. */
  databaseUrl: string | undefined;
  /** GitHub's REST API. The test world points this at its fake GitHub. */
  githubApiUrl: string;
}

const scoped = new AsyncLocalStorage<ServiceConfig>();

export function configFromEnv(env: Readonly<Record<string, string | undefined>>): ServiceConfig {
  return {
    databaseUrl: env.DATABASE_URL || undefined,
    githubApiUrl: (env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, ""),
  };
}

/**
 * The config for the request being handled. A deployed service reads its environment; the test
 * world runs the same handlers in process and scopes a config to each request instead, so several
 * worlds never share one through `process.env`.
 */
export function serviceConfig(): ServiceConfig {
  return scoped.getStore() ?? configFromEnv(process.env);
}

export function withServiceConfig<T>(config: ServiceConfig, fn: () => T): T {
  return scoped.run(config, fn);
}
