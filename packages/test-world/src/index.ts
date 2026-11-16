import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorldDatabase, type WorldDatabase } from "./database.ts";
import { FixtureRepo, type FixtureRepoOptions } from "./fixture-repo.ts";
import { FakeGitHub } from "./github/server.ts";
import type { HttpServer } from "./http.ts";
import { freePort, startNextService } from "./next-service.ts";
import { randomBytes } from "node:crypto";
import { FakeSecretsManager } from "./aws/secrets-manager.ts";
import { FakeSentry } from "./sentry.ts";
import { startPostgresServer, type PostgresServer } from "./postgres-server.ts";
import { cleanEnv, runAction, runNode, type ActionResult, type ProcessResult, type RunActionOptions, type RunOptions } from "./processes.ts";
import { paths } from "./paths.ts";
import { ServiceOverrides, startInProcessService, type ServiceOverride, type ServiceRequest } from "./service.ts";
import type { AddRepoOptions } from "./github/server.ts";
import type { FakeRepo } from "./github/state.ts";
import { createMachine, type Machine, type MachineOptions } from "./machine.ts";
import { createClock, type WorldClock } from "./clock.ts";
import { configToEnv, withServiceConfig, type LogEntry, type ServiceConfig } from "@testnotary/web/config";
import { closeDatabase, database } from "@testnotary/web/db";
import { blockLaptopToken, revokeRepoSandboxToken, tokenIdOf } from "@testnotary/web/revocations";
import { changeRepoSettings, explainMismatch, mismatchIdOfVerification, type SettingsChange, type SettingsRequest } from "@testnotary/web/settings";
import { issueSandboxToken, rememberAccount } from "@testnotary/web/tokens";
import { retentionDatabase, runRetention, type RetentionSummary } from "@testnotary/web/retention";
import { deleteAccount } from "@testnotary/web/accounts";
import type { FakeAccount } from "./github/app.ts";
import { WORLD_AUDIT_MASTER_KEY, worldAudits, type WorldAudits } from "./audits.ts";
import { makeSshKey, type SshKeyPair, type SshKeyType } from "./ssh-keys.ts";
import { startCompromisedService } from "./compromised-service.ts";

export { WORLD_AUDIT_MASTER_KEY, type AuditTree, type WorldAudits } from "./audits.ts";
export { sshSign, type SshKeyPair, type SshKeyType } from "./ssh-keys.ts";

export { DEFAULT_CONFIG, FixtureRepo, type FixtureRepoOptions } from "./fixture-repo.ts";
export { FakeGitHub, type AddRepoOptions, type InstallAppOptions, type RecordedRequest, type RepositoryAction } from "./github/server.ts";
export type { DeliverOptions, FakeAccount, FakeApp, FakeInstallation, WebhookDelivery } from "./github/app.ts";
export type { DeviceFlow, DevicePlan, IssuedDeviceCode } from "./github/device-flow.ts";
export type { FakeCheckRun, FakeRepo, FakeSigningKey, RepoPermission } from "./github/state.ts";
export type { WebFlow } from "./github/web-flow.ts";
export { installLibrary } from "./processes.ts";
export type { ServiceOverride, ServiceRequest } from "./service.ts";
export type { LogEntry } from "@testnotary/web/config";
export { FakeSecretsManager, type SecretsManagerRequest } from "./aws/secrets-manager.ts";
export { FakeSentry, type SentryEnvelope, type SentryEvent } from "./sentry.ts";
export { OIDC_LIFETIME_SECONDS, type ActionsJob } from "./github/oidc.ts";
export { fromJob, json, githubError, notFound, route, type Route, type RouteContext } from "./github/router.ts";
export type { ActionResult, Env, ProcessResult, RunActionOptions, RunOptions } from "./processes.ts";
export type { PostgresServer, Role } from "./postgres-server.ts";
export { startPostgresServer } from "./postgres-server.ts";
export type { WorldDatabase } from "./database.ts";
export type { WorldClock } from "./clock.ts";
export { CREDENTIALS_FILE, type KeychainEntry, type Machine, type MachineOptions } from "./machine.ts";

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
  /**
   * The service. `requests` holds every request it received, body text included, in order (the
   * in-process service only): assert on what a run sent here, never on what it stored. `logs`
   * holds every entry the service wrote to its log (in-process service only; under `next` the
   * entries go to the child's stdout as in production).
   */
  service: {
    url: string;
    requests: ServiceRequest[];
    logs: LogEntry[];
    /**
     * Answers one endpoint (`:name` segments allowed) instead of the service until the returned
     * function is called: a 503, a 429, a dropped connection (`"drop"`), or a slow answer, made by
     * advancing `world.clock` before answering (in-process service only). Newest first.
     */
    override(method: string, path: string, handle: ServiceOverride): () => void;
    /**
     * For an override: the service never answers, while the world clock moves on in `stepMs` steps
     * until the client hangs up. Resolves with the world clock's time then. Needs nothing else to
     * move the clock, and gives up after `limitMs` of world time.
     */
    stall(request: Request, options?: { stepMs?: number; limitMs?: number }): Promise<Date>;
  };
  github: FakeGitHub;
  /** AWS Secrets Manager, for the `next` service (the in-process service reads no secrets). */
  secretsManager: FakeSecretsManager;
  /** Sentry's ingest endpoint; the `next` service's `SENTRY_DSN` points here. */
  sentry: FakeSentry;
  db: WorldDatabase;
  /** The service's clock: set or advance it to test expiry and renewal (in-process service only). */
  clock: WorldClock;
  /**
   * The audit draw under the world's fixed master key (`WORLD_AUDIT_MASTER_KEY`): whether a tree is
   * drawn, and the repo's key version to pick so that one is, or is not.
   */
  audits: WorldAudits;
  /** Builds a fixture repo (see FixtureRepo). It is deleted when the world closes. */
  fixtureRepo(options?: FixtureRepoOptions): Promise<FixtureRepo>;
  /**
   * Puts a fixture repo on the fake GitHub as `owner/name` (`github.addRepo`) and makes its clone's
   * `origin` read `https://github.com/owner/name.git`, as a real clone's would, so `run` can name
   * the repo to the service. Fetches and pushes still go to the fixture's bare origin.
   */
  hostOnGitHub(fixture: FixtureRepo, options?: AddRepoOptions): Promise<FakeRepo>;
  /** A developer machine for `runCli`: a lasting HOME and a keychain stub (see Machine). */
  machine(options?: MachineOptions): Promise<Machine>;
  /**
   * A sandbox token `creator` made for `repo`, as the dashboard makes one once it has checked their
   * write access (the browser tests create them through the dashboard itself). Returns the value,
   * the one time it is shown. `days` defaults to 90.
   */
  sandboxToken(options: { creator: FakeAccount; repo: FakeRepo; name?: string; days?: number }): Promise<string>;
  /**
   * A repo admin's Revoke on one of the repo's sandbox tokens (by its value), as the dashboard does
   * once GitHub says `admin` is an admin of `repo` (the browser tests revoke through the dashboard).
   * Throws when the fake GitHub does not make `admin` an admin. False when the service refuses: the
   * token is not a sandbox token of `repo`.
   */
  revokeSandboxToken(options: { admin: FakeAccount; repo: FakeRepo; token: string }): Promise<boolean>;
  /**
   * A repo admin blocks a laptop token (by its value) on `repo`, as the People section does once
   * GitHub says `admin` is an admin. Throws when the fake GitHub does not make `admin` an admin.
   * False when the service refuses: the token is not a laptop token that ran on `repo`.
   */
  blockLaptopToken(options: { admin: FakeAccount; repo: FakeRepo; token: string; note?: string }): Promise<boolean>;
  /**
   * A repo admin's change in Settings (the mode toggle, the audit rates), as the dashboard makes it
   * once GitHub says `admin` is an admin of `repo` (the browser tests click the toggle). Answers the
   * service's refusal, or the settings after it and the warnings switching to enforce gave.
   * Throws when the fake GitHub does not make `admin` an admin.
   */
  changeRepoSettings(options: { admin: FakeAccount; repo: FakeRepo } & SettingsRequest): Promise<SettingsChange>;
  /**
   * A repo admin explains the mismatch recorded on a verification (by the verification's id, as the
   * job summary names it), as the Mismatches section does. False when the service refuses: no such
   * mismatch in `repo`, a cause other than the four, or one explained already.
   */
  explainMismatch(options: { admin: FakeAccount; repo: FakeRepo; verification: string; cause: string; note?: string }): Promise<boolean>;
  /**
   * A fresh SSH key pair made with the real `ssh-keygen` (Ed25519 unless `type` says otherwise, no
   * passphrase) in the world's temp directory. Never one from `~/.ssh` or an ssh-agent.
   */
  sshKey(options?: { type?: SshKeyType; comment?: string }): Promise<SshKeyPair>;
  /**
   * A compromised service in front of this world's (see compromised-service.ts): every verification
   * it answers goes through `forge` first. Returns its URL, for the action's `TESTNOTARY_URL`.
   * Stopped when the world closes.
   */
  compromisedService<V extends Record<string, unknown>>(forge: (verification: V) => V): Promise<string>;
  /**
   * One pass of the retention job, as its schedule runs it in production: the service's own job
   * code, connected as the retention role, deciding by the world clock (or `at`, for a `next`
   * world, whose service keeps real time). Answers how many rows of each kind it deleted.
   */
  runRetentionJob(options?: { at?: Date }): Promise<RetentionSummary>;
  /**
   * *Delete account*, as the dashboard writes it once the person confirms (the browser tests click
   * it): the account's tokens are revoked and its records read *deleted account* from now on.
   */
  deleteAccount(account: FakeAccount): Promise<void>;
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
    // The `next` service's port is chosen first, so its own URL (where sign-in comes back) is known.
    const nextPort = options.service === "next" ? await freePort() : undefined;
    // On disk, so the action processes the world starts keep its time (action-clock-preload.ts).
    const clockFile = join(tmp, "clock.json");
    const clock = createClock(clockFile);
    const overrides = new ServiceOverrides();
    const logs: LogEntry[] = [];
    // The fake GitHub serves api.github.com, github.com (device flow, browser sign-in) and the
    // avatars host at one URL.
    const config: ServiceConfig = {
      databaseUrl: db.urls.app,
      githubApiUrl: github.url,
      githubWebUrl: github.url,
      githubClientId: github.app.clientId,
      githubWebhookSecret: github.app.webhookSecret,
      githubAppSlug: github.app.slug,
      githubClientSecret: github.app.clientSecret,
      githubAvatarsUrl: github.avatarsUrl,
      authSecret: randomBytes(32).toString("base64url"),
      // The in-process service learns its URL once it listens (below).
      publicUrl: nextPort ? `http://127.0.0.1:${nextPort}` : "http://127.0.0.1",
      githubAppId: String(github.app.id),
      githubAppPrivateKey: github.app.privateKey,
      actionsOidcIssuer: github.oidc.issuer,
      legalDir: undefined,
      auditMasterKey: WORLD_AUDIT_MASTER_KEY,
      now: () => clock.now(),
      log: (entry) => logs.push(entry),
    };
    // GitHub's OIDC issuer keeps the world's time too, so a job after `clock.advance` gets a token
    // the service (on the same clock) finds fresh.
    github.oidc.now = () => Math.floor(clock.now().getTime() / 1000);
    const requests: ServiceRequest[] = [];
    if (options.service === "next") {
      const env: Record<string, string | undefined> = {
        ...configToEnv(config),
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
        nextPort,
      );
    } else {
      service = await startInProcessService(config, requests, overrides);
      config.publicUrl = service.url;
    }
    cleanups.push(() => service.close());
    github.app.webhookUrl = `${service.url}/api/v1/github/webhooks`;

    // The `next` service has its own connections; this process opens one only for `sandboxToken`
    // and an admin's revocations and blocks.
    let sandboxTokensUsed = false;
    const ownConnection = () => {
      if (options.service === "next" && !sandboxTokensUsed) {
        sandboxTokensUsed = true;
        cleanups.push(() => closeDatabase(config.databaseUrl));
      }
    };
    /** Runs `act` as the dashboard's admin-only actions do, after GitHub says `admin` is an admin of `repo`. */
    const asAdmin = async <T,>(admin: FakeAccount, repo: FakeRepo, act: (db: ReturnType<typeof database>, by: { id: number; login: string }) => Promise<T>) => {
      if (github.state.permission(repo, admin) !== "admin") throw new Error(`${admin.login} is not an admin of ${repo.fullName} on the fake GitHub`);
      ownConnection();
      await withServiceConfig(config, () => rememberAccount(database(), { id: admin.id, login: admin.login }));
      return withServiceConfig(config, () => act(database(), { id: admin.id, login: admin.login }));
    };
    const repos: FixtureRepo[] = [];
    cleanups.push(async () => {
      await Promise.all(repos.map((repo) => repo.remove()));
    });

    return {
      service: {
        url: service.url,
        requests,
        logs,
        override(method, path, handle) {
          if (options.service === "next") throw new Error("service overrides need the in-process service");
          return overrides.add(method, path, handle);
        },
        async stall(request, { stepMs = 1_000, limitMs = 120_000 } = {}) {
          const start = clock.now().getTime();
          while (!request.signal.aborted && clock.now().getTime() - start < limitMs) {
            clock.advance(stepMs);
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          return clock.now();
        },
      },
      github,
      secretsManager,
      sentry,
      db,
      clock,
      audits: worldAudits(db),
      async fixtureRepo(repoOptions) {
        const repo = await FixtureRepo.create(repoOptions);
        repos.push(repo);
        return repo;
      },
      async hostOnGitHub(fixture, repoOptions) {
        const repo = github.addRepo(fixture, repoOptions);
        await fixture.pointOriginAt(`https://github.com/${repo.fullName}.git`);
        return repo;
      },
      machine(machineOptions) {
        return createMachine(tmp, machineOptions);
      },
      async sandboxToken({ creator, repo, name = "agent sandbox", days = 90 }) {
        ownConnection();
        const issued = await withServiceConfig(config, () =>
          issueSandboxToken(database(), { creator: { id: creator.id, login: creator.login }, repoId: repo.id, name, days }),
        );
        return issued.value;
      },
      async revokeSandboxToken({ admin, repo, token }) {
        return asAdmin(admin, repo, async (db, by) => {
          const tokenId = await tokenIdOf(db, token);
          return tokenId ? revokeRepoSandboxToken(db, { tokenId, repoId: repo.id, by }) : false;
        });
      },
      async blockLaptopToken({ admin, repo, token, note }) {
        return asAdmin(admin, repo, async (db, by) => {
          const tokenId = await tokenIdOf(db, token);
          return tokenId ? blockLaptopToken(db, { tokenId, repoId: repo.id, by, note }) : false;
        });
      },
      async changeRepoSettings({ admin, repo, ...request }) {
        return asAdmin(admin, repo, (db, by) => changeRepoSettings(db, { repoId: repo.id, by, ...request }));
      },
      async explainMismatch({ admin, repo, verification, cause, note }) {
        return asAdmin(admin, repo, async (db, by) => {
          const mismatchId = await mismatchIdOfVerification(db, repo.id, verification);
          return mismatchId ? explainMismatch(db, { repoId: repo.id, mismatchId, by, cause, note }) : false;
        });
      },
      sshKey(keyOptions) {
        return makeSshKey(tmp, keyOptions);
      },
      async compromisedService(forge) {
        const proxy = await startCompromisedService(service.url, forge);
        cleanups.push(() => proxy.close());
        return proxy.url;
      },
      async runRetentionJob(jobOptions = {}) {
        return runRetention(retentionDatabase(db.connect("retention")), jobOptions.at ?? clock.now());
      },
      async deleteAccount(account) {
        ownConnection();
        await withServiceConfig(config, () => deleteAccount(database(), account.id, `world-${randomBytes(8).toString("hex")}`));
      },
      async runCli(args, runOptions) {
        const machine = runOptions.machine ?? (await createMachine(tmp));
        const baseEnv = cleanEnv(machine.home, service.url);
        // The keychain stub always comes first, even on a PATH a test sets: no test reaches the
        // real keychain.
        baseEnv.PATH = `${machine.bin}:${baseEnv.PATH}`;
        const env = { ...runOptions.env };
        if (env.PATH !== undefined) env.PATH = `${machine.bin}:${env.PATH}`;
        return runNode(runOptions.cli ?? paths.cli, args, { ...runOptions, env, baseEnv });
      },
      runAction(actionOptions) {
        return runAction(actionOptions, { github, serviceUrl: service.url, tmp, clockFile });
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
