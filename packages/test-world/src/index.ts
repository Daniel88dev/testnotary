import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorldDatabase, type WorldDatabase } from "./database.ts";
import { FixtureRepo, type FixtureRepoOptions } from "./fixture-repo.ts";
import { FakeGitHub } from "./github/server.ts";
import type { HttpServer } from "./http.ts";
import { startNextService } from "./next-service.ts";
import { FakeSecretsManager } from "./aws/secrets-manager.ts";
import { FakeSentry } from "./sentry.ts";
import { startPostgresServer, type PostgresServer } from "./postgres-server.ts";
import { cleanEnv, runAction, runNode, type ActionResult, type ProcessResult, type RunActionOptions, type RunOptions } from "./processes.ts";
import { paths } from "./paths.ts";
import { startInProcessService } from "./service.ts";

export { DEFAULT_CONFIG, FixtureRepo, type FixtureRepoOptions } from "./fixture-repo.ts";
export { FakeGitHub, type AddRepoOptions, type RecordedRequest } from "./github/server.ts";
export type { FakeRepo } from "./github/state.ts";
export { FakeSecretsManager, type SecretsManagerRequest } from "./aws/secrets-manager.ts";
export { FakeSentry, type SentryEnvelope, type SentryEvent } from "./sentry.ts";
export { OIDC_LIFETIME_SECONDS, type ActionsJob } from "./github/oidc.ts";
export { json, githubError, notFound, route, type Route, type RouteContext } from "./github/router.ts";
export type { ActionResult, Env, ProcessResult, RunActionOptions, RunOptions } from "./processes.ts";
export type { PostgresServer, Role } from "./postgres-server.ts";
export { startPostgresServer } from "./postgres-server.ts";
export type { WorldDatabase } from "./database.ts";

export interface WorldOptions {
  /** The Postgres server from a global setup. Without it the world starts (and stops) its own. */
  postgres?: PostgresServer;
  /**
   * `in-process` (default): the API route handlers in this process, fast to start.
   * `next`: the whole web app under `next dev`, for Playwright.
   */
  service?: "in-process" | "next";
  /**
   * `next` only: service environment variables whose values the world stores in its fake Secrets
   * Manager, passing the service a `secretsmanager:<id>` reference instead, as production does.
   * The secret id is `testnotary/world/<NAME>`.
   */
  secrets?: string[];
  /** `next` only: environment for the service, over the world's defaults. `undefined` removes one. */
  serviceEnv?: Record<string, string | undefined>;
}

/** The secret id under which the world stores a service variable named in `WorldOptions.secrets`. */
export function worldSecretId(name: string): string {
  return `testnotary/world/${name}`;
}

/**
 * One isolated world: its own database (copied from the migrated template), the service on an
 * ephemeral port, its own fake GitHub, and fixture repos in a temp directory. Nothing in it is
 * shared with another world, so test files and worktrees run side by side.
 */
export interface World {
  service: { url: string };
  github: FakeGitHub;
  /** AWS Secrets Manager, for the `next` service (the in-process service reads no secrets). */
  secretsManager: FakeSecretsManager;
  /** Sentry's ingest endpoint; the `next` service's `SENTRY_DSN` points here. */
  sentry: FakeSentry;
  db: WorldDatabase;
  /** Builds a fixture repo (see FixtureRepo). It is deleted when the world closes. */
  fixtureRepo(options?: FixtureRepoOptions): Promise<FixtureRepo>;
  /** Runs `testnotary <args>` as a process, pointed at this world's service. */
  runCli(args: string[], options: RunOptions): Promise<ProcessResult>;
  /** Runs the action's entry point as a process in a simulated runner. */
  runAction(options: RunActionOptions): Promise<ActionResult>;
  close(): Promise<void>;
}

export async function createWorld(options: WorldOptions = {}): Promise<World> {
  const cleanups: (() => Promise<void>)[] = [];
  const close = async () => {
    for (const cleanup of cleanups.reverse()) await cleanup().catch(() => {});
  };
  try {
    let postgres = options.postgres ?? postgresFromEnv();
    if (!postgres) {
      const started = await startPostgresServer(`adhoc-${process.pid}`);
      cleanups.push(started.stop);
      postgres = started.server;
    }
    const tmp = await realpath(await mkdtemp(join(tmpdir(), "tnw-")));
    cleanups.push(() => rm(tmp, { recursive: true, force: true }));

    const [db, github, secretsManager, sentry] = await Promise.all([
      createWorldDatabase(postgres),
      FakeGitHub.start(),
      FakeSecretsManager.start(),
      FakeSentry.start(),
    ]);
    cleanups.push(
      () => db.drop(),
      () => github.close(),
      () => secretsManager.close(),
      () => sentry.close(),
    );

    let service: HttpServer;
    if (options.service === "next") {
      const env: Record<string, string | undefined> = {
        DATABASE_URL: db.urls.app,
        GITHUB_API_URL: github.url,
        SENTRY_DSN: sentry.dsn,
        // The AWS SDK talks to the fake Secrets Manager with throwaway credentials and never looks
        // for real ones (no profile, no instance metadata).
        AWS_REGION: "eu-central-1",
        AWS_ACCESS_KEY_ID: "AKIAWORLDWORLDWORLD0",
        AWS_SECRET_ACCESS_KEY: "world-secret-access-key",
        AWS_ENDPOINT_URL_SECRETS_MANAGER: secretsManager.url,
        AWS_EC2_METADATA_DISABLED: "true",
        ...options.serviceEnv,
      };
      for (const name of options.secrets ?? []) {
        const value = env[name];
        if (value === undefined) throw new Error(`secrets: the service has no ${name} to store`);
        secretsManager.put(worldSecretId(name), value);
        env[name] = `secretsmanager:${worldSecretId(name)}`;
      }
      service = await startNextService(
        Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      );
    } else {
      service = await startInProcessService({ databaseUrl: db.urls.app, githubApiUrl: github.url });
    }
    cleanups.push(() => service.close());

    const repos: FixtureRepo[] = [];
    cleanups.push(async () => {
      await Promise.all(repos.map((repo) => repo.remove()));
    });

    return {
      service: { url: service.url },
      github,
      secretsManager,
      sentry,
      db,
      async fixtureRepo(repoOptions) {
        const repo = await FixtureRepo.create(repoOptions);
        repos.push(repo);
        return repo;
      },
      async runCli(args, runOptions) {
        const home = await mkdtemp(join(tmp, "home-"));
        return runNode(paths.cli, args, { ...runOptions, baseEnv: cleanEnv(home, service.url) });
      },
      runAction(actionOptions) {
        return runAction(actionOptions, { github, serviceUrl: service.url, tmp });
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Where a global setup leaves the Postgres server for test processes it does not share memory with. */
export const POSTGRES_ENV = "TESTNOTARY_WORLD_POSTGRES";

function postgresFromEnv(): PostgresServer | undefined {
  const raw = process.env[POSTGRES_ENV];
  return raw ? (JSON.parse(raw) as PostgresServer) : undefined;
}
