import { AsyncLocalStorage } from "node:async_hooks";
import { ACTIONS_OIDC_ISSUER } from "@testnotary/protocol";

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
  /** The App's URL name on GitHub: `github.com/apps/<slug>`, where people install it. */
  githubAppSlug: string;
  /** The App's client secret (a secret): the browser sign-in exchanges GitHub's code with it. */
  githubClientSecret: string | undefined;
  /** Where GitHub serves avatars. The app's own image route fetches them, so browsers never do. */
  githubAvatarsUrl: string;
  /** Signs and encrypts the browser session cookies (a secret, 32+ characters). Without it nobody can sign in. */
  authSecret: string | undefined;
  /** The service's own origin as browsers reach it: sign-in redirects come back here. */
  publicUrl: string;
  /** The App's id: the `iss` of the App JWT that buys installation tokens. Not a secret. */
  githubAppId: string | undefined;
  /** The App's private key, PEM (a secret). Without it the service can't check write access. */
  githubAppPrivateKey: string | undefined;
  /**
   * GitHub Actions' OIDC issuer, which every verification token's `iss` must name. Its keys come
   * from `<issuer>/.well-known/jwks` only, never from discovery on a token's `iss`. Production keeps
   * the default; the test world points it at its fake GitHub.
   */
  actionsOidcIssuer: string;
  /**
   * The service's clock. Everything the service decides by time (token renewal and expiry, run
   * receipt, attestation age) reads it here, never `new Date()`, so the test world can move it.
   * Not an environment setting: a deployment always uses real time.
   */
  now: () => Date;
  /**
   * Where the service's log goes (`logEvent` in log.ts). Not an environment setting: a deployment
   * writes JSON lines to stdout, which the host keeps; the test world collects the entries.
   */
  log: (entry: LogEntry) => void;
}

/** One line of the service's log. */
export interface LogEntry {
  level: "info" | "warn";
  /** A stable snake_case name, e.g. `token_rejected`. */
  event: string;
  [field: string]: unknown;
}

/** The deployed service's log: a JSON line on stdout, with the real time. */
export function stdoutLog(entry: LogEntry): void {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

const scoped = new AsyncLocalStorage<ServiceConfig>();

/** The settings that come from the environment, by variable name. `now` and `log` are not. */
type EnvSetting = Exclude<keyof ServiceConfig, "now" | "log">;

const ENV = {
  databaseUrl: "DATABASE_URL",
  githubApiUrl: "GITHUB_API_URL",
  githubWebUrl: "GITHUB_WEB_URL",
  githubClientId: "GITHUB_CLIENT_ID",
  githubWebhookSecret: "GITHUB_WEBHOOK_SECRET",
  githubAppSlug: "GITHUB_APP_SLUG",
  githubClientSecret: "GITHUB_APP_CLIENT_SECRET",
  githubAvatarsUrl: "GITHUB_AVATARS_URL",
  authSecret: "BETTER_AUTH_SECRET",
  publicUrl: "PUBLIC_URL",
  githubAppId: "GITHUB_APP_ID",
  githubAppPrivateKey: "GITHUB_APP_PRIVATE_KEY",
  actionsOidcIssuer: "ACTIONS_OIDC_ISSUER",
} as const satisfies Record<EnvSetting, string>;

export function realClock(): Date {
  return new Date();
}

export function configFromEnv(env: Readonly<Record<string, string | undefined>>): ServiceConfig {
  return {
    databaseUrl: env[ENV.databaseUrl] || undefined,
    githubApiUrl: (env[ENV.githubApiUrl] || "https://api.github.com").replace(/\/+$/, ""),
    githubWebUrl: (env[ENV.githubWebUrl] || "https://github.com").replace(/\/+$/, ""),
    githubClientId: env[ENV.githubClientId] || undefined,
    githubWebhookSecret: env[ENV.githubWebhookSecret] || undefined,
    githubAppSlug: env[ENV.githubAppSlug] || "testnotary",
    githubClientSecret: env[ENV.githubClientSecret] || undefined,
    githubAvatarsUrl: (env[ENV.githubAvatarsUrl] || "https://avatars.githubusercontent.com").replace(/\/+$/, ""),
    authSecret: env[ENV.authSecret] || undefined,
    publicUrl: (env[ENV.publicUrl] || "https://testnotary.dev").replace(/\/+$/, ""),
    githubAppId: env[ENV.githubAppId] || undefined,
    githubAppPrivateKey: env[ENV.githubAppPrivateKey] || undefined,
    actionsOidcIssuer: (env[ENV.actionsOidcIssuer] || ACTIONS_OIDC_ISSUER).replace(/\/+$/, ""),
    now: realClock,
    log: stdoutLog,
  };
}

/** The environment that `configFromEnv` reads back as this config (for a service in another process). */
export function configToEnv(config: ServiceConfig): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, name] of Object.entries(ENV)) {
    const value = config[key as EnvSetting];
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

/** Now, by the service's clock. */
export function now(): Date {
  return serviceConfig().now();
}

export function withServiceConfig<T>(config: ServiceConfig, fn: () => T): T {
  return scoped.run(config, fn);
}

/** Where a person installs the App on an account and picks its repos. */
export function appInstallUrl(config: ServiceConfig = serviceConfig()): string {
  return `${config.githubWebUrl}/apps/${config.githubAppSlug}/installations/new`;
}
