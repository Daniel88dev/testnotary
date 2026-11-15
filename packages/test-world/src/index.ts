import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorldDatabase, type WorldDatabase } from "./database.ts";
import { FixtureRepo, type FixtureRepoOptions } from "./fixture-repo.ts";
import { FakeGitHub } from "./github/server.ts";
import type { HttpServer } from "./http.ts";
import { startNextService } from "./next-service.ts";
import { startPostgresServer, type PostgresServer } from "./postgres-server.ts";
import { cleanEnv, runAction, runNode, type ActionResult, type ProcessResult, type RunActionOptions, type RunOptions } from "./processes.ts";
import { paths } from "./paths.ts";
import { startInProcessService } from "./service.ts";
import { createMachine, type Machine, type MachineOptions } from "./machine.ts";
import { configToEnv, type ServiceConfig } from "@testnotary/web/config";

export { DEFAULT_CONFIG, FixtureRepo, type FixtureRepoOptions } from "./fixture-repo.ts";
export { FakeGitHub, type AddRepoOptions, type InstallAppOptions, type RecordedRequest, type RepositoryAction } from "./github/server.ts";
export type { DeliverOptions, FakeAccount, FakeApp, FakeInstallation, WebhookDelivery } from "./github/app.ts";
export type { DeviceFlow, DevicePlan, IssuedDeviceCode } from "./github/device-flow.ts";
export type { FakeRepo } from "./github/state.ts";
export { OIDC_LIFETIME_SECONDS, type ActionsJob } from "./github/oidc.ts";
export { json, githubError, notFound, route, type Route, type RouteContext } from "./github/router.ts";
export type { ActionResult, Env, ProcessResult, RunActionOptions, RunOptions } from "./processes.ts";
export type { PostgresServer, Role } from "./postgres-server.ts";
export { startPostgresServer } from "./postgres-server.ts";
export type { WorldDatabase } from "./database.ts";
export { CREDENTIALS_FILE, type KeychainEntry, type Machine, type MachineOptions } from "./machine.ts";

export interface WorldOptions {
  /** The Postgres server from a global setup. Without it the world starts (and stops) its own. */
  postgres?: PostgresServer;
  /**
   * `in-process` (default): the API route handlers in this process, fast to start.
   * `next`: the whole web app under `next dev`, for Playwright.
   */
  service?: "in-process" | "next";
}

/**
 * One isolated world: its own database (copied from the migrated template), the service on an
 * ephemeral port, its own fake GitHub, and fixture repos in a temp directory. Nothing in it is
 * shared with another world, so test files and worktrees run side by side.
 */
export interface World {
  service: { url: string };
  github: FakeGitHub;
  db: WorldDatabase;
  /** Builds a fixture repo (see FixtureRepo). It is deleted when the world closes. */
  fixtureRepo(options?: FixtureRepoOptions): Promise<FixtureRepo>;
  /** A developer machine for `runCli`: a lasting HOME and a keychain stub (see Machine). */
  machine(options?: MachineOptions): Promise<Machine>;
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

    const [db, github] = await Promise.all([createWorldDatabase(postgres), FakeGitHub.start()]);
    cleanups.push(() => db.drop(), () => github.close());

    let service: HttpServer;
    // The fake GitHub serves both api.github.com and github.com (device flow) at one URL.
    const config: ServiceConfig = {
      databaseUrl: db.urls.app,
      githubApiUrl: github.url,
      githubWebUrl: github.url,
      githubClientId: github.app.clientId,
      githubWebhookSecret: github.app.webhookSecret,
    };
    if (options.service === "next") {
      service = await startNextService(configToEnv(config));
    } else {
      service = await startInProcessService(config);
    }
    cleanups.push(() => service.close());
    github.app.webhookUrl = `${service.url}/api/v1/github/webhooks`;

    const repos: FixtureRepo[] = [];
    cleanups.push(async () => {
      await Promise.all(repos.map((repo) => repo.remove()));
    });

    return {
      service: { url: service.url },
      github,
      db,
      async fixtureRepo(repoOptions) {
        const repo = await FixtureRepo.create(repoOptions);
        repos.push(repo);
        return repo;
      },
      machine(machineOptions) {
        return createMachine(tmp, machineOptions);
      },
      async runCli(args, runOptions) {
        const machine = runOptions.machine ?? (await createMachine(tmp));
        const baseEnv = cleanEnv(machine.home, service.url);
        // The keychain stub always comes first, even on a PATH a test sets: no test reaches the
        // real keychain.
        baseEnv.PATH = `${machine.bin}:${baseEnv.PATH}`;
        const env = { ...runOptions.env };
        if (env.PATH !== undefined) env.PATH = `${machine.bin}:${env.PATH}`;
        return runNode(paths.cli, args, { ...runOptions, env, baseEnv });
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
