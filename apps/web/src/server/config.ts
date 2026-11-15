import { AsyncLocalStorage } from "node:async_hooks";

/** What the service needs from its surroundings. Later tickets add fields here. */
export interface ServiceConfig {
  /** Postgres, as the app role: INSERT and SELECT on history tables, nothing else. */
  databaseUrl: string | undefined;
  /** GitHub's REST API. The test world points this at its fake GitHub. */
  githubApiUrl: string;
  /** github.com itself, where the device flow lives. The test world points this at its fake GitHub. */
  githubWebUrl: string;
  /** The Testnotary GitHub App's client id: the device flow's `client_id`. Not a secret. */
  githubClientId: string | undefined;
  /** The App's webhook secret (a secret). Without it every webhook is refused. */
  githubWebhookSecret: string | undefined;
}

const scoped = new AsyncLocalStorage<ServiceConfig>();

const ENV = {
  databaseUrl: "DATABASE_URL",
  githubApiUrl: "GITHUB_API_URL",
  githubWebUrl: "GITHUB_WEB_URL",
  githubClientId: "GITHUB_CLIENT_ID",
  githubWebhookSecret: "GITHUB_WEBHOOK_SECRET",
} as const satisfies Record<keyof ServiceConfig, string>;

export function configFromEnv(env: Readonly<Record<string, string | undefined>>): ServiceConfig {
  return {
    databaseUrl: env[ENV.databaseUrl] || undefined,
    githubApiUrl: (env[ENV.githubApiUrl] || "https://api.github.com").replace(/\/+$/, ""),
    githubWebUrl: (env[ENV.githubWebUrl] || "https://github.com").replace(/\/+$/, ""),
    githubClientId: env[ENV.githubClientId] || undefined,
    githubWebhookSecret: env[ENV.githubWebhookSecret] || undefined,
  };
}

/** The environment that `configFromEnv` reads back as this config (for a service in another process). */
export function configToEnv(config: ServiceConfig): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, name] of Object.entries(ENV)) {
    const value = config[key as keyof ServiceConfig];
    if (value !== undefined) env[name] = value;
  }
  return env;
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
