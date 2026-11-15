// The Drizzle schema. Every table here is a history table: the app role may only INSERT and
// SELECT (see drizzle/0000_roles.sql), so every state change is a new row. Tables arrive with the
// tickets that need them; run `pnpm db:generate` after editing this file.
//
// Where something changes over time (a repo's name or visibility, its settings, an account's
// login), each change is a row carrying the whole state after it, and the latest row per key is
// the current state. GitHub ids are the keys for everything that comes from GitHub.
import { bigint, boolean, customType, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { CiEnvironment, RunEnvironment } from "@testnotary/protocol";

const githubId = (name: string) => bigint(name, { mode: "number" });
const at = (name = "at") => timestamp(name, { withTimezone: true, mode: "date" }).notNull().defaultNow();
const rowId = () => bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity();

/** Every webhook delivery applied, by `X-GitHub-Delivery`, so a redelivery is applied once. */
export const webhookDeliveries = pgTable("webhook_deliveries", {
  deliveryId: text("delivery_id").primaryKey(),
  event: text("event").notNull(),
  action: text("action"),
  receivedAt: at("received_at"),
});

/** The App installed on one GitHub account (a person or an organization). */
export const installations = pgTable("installations", {
  githubId: githubId("github_id").primaryKey(),
  /** The GitHub account the App is installed on. Not necessarily a Testnotary account. */
  targetId: githubId("target_id").notNull(),
  targetLogin: text("target_login").notNull(),
  targetType: text("target_type").notNull(),
  createdAt: at("created_at"),
});

/** `created`, `deleted`, `suspend`, `unsuspend`: the latest says whether the installation is active. */
export const installationEvents = pgTable(
  "installation_events",
  {
    id: rowId(),
    installationId: githubId("installation_id")
      .notNull()
      .references(() => installations.githubId),
    action: text("action").notNull(),
    deliveryId: text("delivery_id"),
    at: at(),
  },
  (table) => [index("installation_events_latest").on(table.installationId, table.id)],
);

/** A GitHub repo the App was ever given, keyed by its GitHub id. */
export const repos = pgTable("repos", {
  githubId: githubId("github_id").primaryKey(),
  createdAt: at("created_at"),
});

/**
 * One row per change to a repo's membership, name or visibility, carrying the whole state after it.
 * `change`: `added`, `removed`, `renamed`, `privatized`, `publicized`, `transferred`, `deleted`.
 * A repo is installed while its latest row says so and its installation is active.
 */
export const repoStates = pgTable(
  "repo_states",
  {
    id: rowId(),
    repoId: githubId("repo_id")
      .notNull()
      .references(() => repos.githubId),
    installationId: githubId("installation_id")
      .notNull()
      .references(() => installations.githubId),
    fullName: text("full_name").notNull(),
    visibility: text("visibility").notNull(),
    installed: boolean("installed").notNull(),
    change: text("change").notNull(),
    deliveryId: text("delivery_id"),
    at: at(),
  },
  (table) => [
    index("repo_states_latest").on(table.repoId, table.id),
    index("repo_states_installation").on(table.installationId),
  ],
);

/**
 * One row per change of a repo's mode, audit rate or sandbox audit rate, carrying all three.
 * Rates are "1 in N". `changedBy` is the account that made the change; null when Testnotary made
 * it (a new repo starting in shadow mode, a mismatch sending it back).
 */
export const repoSettingChanges = pgTable(
  "repo_setting_changes",
  {
    id: rowId(),
    repoId: githubId("repo_id")
      .notNull()
      .references(() => repos.githubId),
    mode: text("mode").notNull(),
    auditOneIn: integer("audit_one_in").notNull(),
    sandboxAuditOneIn: integer("sandbox_audit_one_in").notNull(),
    changedBy: githubId("changed_by"),
    reason: text("reason").notNull(),
    at: at(),
  },
  (table) => [index("repo_setting_changes_latest").on(table.repoId, table.id)],
);

/** A person: a GitHub user, keyed by numeric id, never by login. */
export const accounts = pgTable("accounts", {
  githubId: githubId("github_id").primaryKey(),
  createdAt: at("created_at"),
});

/** The account's login as GitHub last told it; the latest row is the cached login. */
export const accountLogins = pgTable(
  "account_logins",
  {
    id: rowId(),
    accountId: githubId("account_id")
      .notNull()
      .references(() => accounts.githubId),
    login: text("login").notNull(),
    at: at(),
  },
  (table) => [index("account_logins_latest").on(table.accountId, table.id)],
);

/**
 * A token, laptop or sandbox, always belonging to the account that created it. Its secret is in
 * `token_secrets`, hashed. `expiresAt` is a fixed expiry (sandbox tokens); null means the token
 * renews on use (laptop tokens: 90 days from the latest `token_uses` row, or from creation).
 */
export const tokens = pgTable(
  "tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    accountId: githubId("account_id")
      .notNull()
      .references(() => accounts.githubId),
    name: text("name").notNull(),
    /** A sandbox token's one repo. */
    repoId: githubId("repo_id").references(() => repos.githubId),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    createdAt: at("created_at"),
  },
  (table) => [index("tokens_account").on(table.accountId)],
);

/**
 * The SHA-256 of each token's value; the value itself is never stored. Kept apart from `tokens`
 * so that "clearing the hash" of a revoked or expired token is a delete the retention role can do,
 * while the token's row stays for history.
 */
export const tokenSecrets = pgTable("token_secrets", {
  tokenId: uuid("token_id")
    .primaryKey()
    .references(() => tokens.id),
  hash: text("hash").notNull().unique(),
});

/** When a token was used, at most about one row an hour per token: it drives laptop renewal and "last use". */
export const tokenUses = pgTable(
  "token_uses",
  {
    id: rowId(),
    tokenId: uuid("token_id")
      .notNull()
      .references(() => tokens.id),
    at: at(),
  },
  (table) => [index("token_uses_latest").on(table.tokenId, table.id)],
);

/** Bytes kept exactly as they came: an attestation's canonical payload. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });
const jsonList = (name: string) => jsonb(name).$type<string[]>().notNull();

/**
 * One run, for every outcome. A refused run carries only its refusal, tree and commit (the
 * library sends nothing else); a run whose command ran carries the whole record "What a run
 * uploads" lists. `receivedAt` is the service clock's time of the upload; the other times are the
 * library's. Hard-deleted at 90 days with its attestation (retention ticket).
 */
export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: githubId("repo_id")
      .notNull()
      .references(() => repos.githubId),
    tokenId: uuid("token_id")
      .notNull()
      .references(() => tokens.id),
    /** The token's account: for a sandbox token, the account that created it. */
    accountId: githubId("account_id")
      .notNull()
      .references(() => accounts.githubId),
    outcome: text("outcome").notNull(),
    refusal: text("refusal"),
    suite: text("suite"),
    tree: text("tree"),
    commit: text("commit"),
    command: jsonb("command").$type<string[]>(),
    exitCode: integer("exit_code"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    endedAt: timestamp("ended_at", { withTimezone: true, mode: "date" }),
    durationMs: integer("duration_ms"),
    environment: jsonb("environment").$type<RunEnvironment>(),
    session: jsonb("session").$type<{ vendor: string; id: string | null; url: string | null }>(),
    passedEnv: jsonList("passed_env"),
    guardedMatched: jsonList("guarded_matched"),
    warnings: jsonList("warnings"),
    notPinned: jsonList("not_pinned"),
    baselineOverrides: jsonList("baseline_overrides"),
    receivedAt: at("received_at"),
  },
  (table) => [index("runs_repo").on(table.repoId, table.receivedAt), index("runs_account").on(table.accountId)],
);

/**
 * A passed run's attestation: exactly one per passed run. `payload` is the canonical payload's
 * bytes as uploaded, in the `format` it names; the columns beside it are copies for lookups and
 * must never be used to rebuild it. Signature fields arrive with signature mode (T-829).
 */
export const attestations = pgTable(
  "attestations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .unique()
      .references(() => runs.id),
    repoId: githubId("repo_id")
      .notNull()
      .references(() => repos.githubId),
    suite: text("suite").notNull(),
    tree: text("tree").notNull(),
    commit: text("commit").notNull(),
    tokenId: uuid("token_id")
      .notNull()
      .references(() => tokens.id),
    accountId: githubId("account_id")
      .notNull()
      .references(() => accounts.githubId),
    /** The run's end, from the payload: the attestation's age counts from here. */
    endedAt: timestamp("ended_at", { withTimezone: true, mode: "date" }).notNull(),
    format: text("format").notNull(),
    payload: bytea("payload").notNull(),
    createdAt: at("created_at"),
  },
  (table) => [index("attestations_lookup").on(table.repoId, table.suite, table.tree)],
);

/** The token was revoked. One row ends the token for good. */
export const tokenRevocations = pgTable("token_revocations", {
  id: rowId(),
  tokenId: uuid("token_id")
    .notNull()
    .unique()
    .references(() => tokens.id),
  /** The account that revoked it, when an admin or owner did so in the dashboard; null when the bearer did (`logout`, or a new sign-in on the same machine). */
  revokedBy: githubId("revoked_by").references(() => accounts.githubId),
  /** `logout`, `replaced` (a new sign-in on the same machine), and whatever later tickets add. */
  reason: text("reason").notNull(),
  at: at(),
});

/**
 * Every Actions OIDC token the service accepted, by its `jti`: a second use of one is a replay and
 * is rejected. `expiresAt` is the token's `exp`; the retention job may delete rows once it has passed.
 */
export const oidcTokenUses = pgTable("oidc_token_uses", {
  jti: text("jti").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  at: at(),
});

/**
 * One verification: a CI job asked whether an attestation names the tree it builds. `commit` is the
 * OIDC `sha`, `tree` its tree from GitHub's commits API, `iss` the token's issuer. `result` is the
 * action's result (`skip`, `would_skip`, `fallback`, …) and `reason` its fallback reason code.
 * `attestationId` is the attestation matched, also when a later step refused it. `environment` is
 * the runner's, as the action sent it. Hard-deleted at 90 days (retention ticket).
 */
export const verifications = pgTable(
  "verifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: githubId("repo_id")
      .notNull()
      .references(() => repos.githubId),
    suite: text("suite"),
    commit: text("commit").notNull(),
    tree: text("tree").notNull(),
    event: text("event").notNull(),
    iss: text("iss").notNull(),
    mode: text("mode").notNull(),
    result: text("result").notNull(),
    reason: text("reason"),
    attestationId: uuid("attestation_id").references(() => attestations.id),
    environment: jsonb("environment").$type<CiEnvironment>().notNull(),
    createdAt: at("created_at"),
  },
  (table) => [index("verifications_repo").on(table.repoId, table.createdAt)],
);

/**
 * A CI job's report of its tests after a verification: `outcome` (`passed`, `failed`, `refused`),
 * the test command's wall-clock duration and the runner's environment. Append-only, because the
 * app role can't update a verification; a re-run job may add another, and the latest counts. A
 * verification with none reads "outcome unknown". Hard-deleted at 90 days (retention ticket).
 */
export const jobReports = pgTable(
  "job_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    verificationId: uuid("verification_id")
      .notNull()
      .references(() => verifications.id),
    outcome: text("outcome").notNull(),
    durationMs: integer("duration_ms").notNull(),
    environment: jsonb("environment").$type<CiEnvironment>().notNull(),
    createdAt: at("created_at"),
  },
  (table) => [index("job_reports_verification").on(table.verificationId, table.createdAt)],
);
