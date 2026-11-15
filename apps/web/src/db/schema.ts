// The Drizzle schema. Every table here is a history table: the app role may only INSERT and
// SELECT (see drizzle/0000_roles.sql), so every state change is a new row. Tables arrive with the
// tickets that need them; run `pnpm db:generate` after editing this file.
//
// Where something changes over time (a repo's name or visibility, its settings, an account's
// login), each change is a row carrying the whole state after it, and the latest row per key is
// the current state. GitHub ids are the keys for everything that comes from GitHub.
import { bigint, boolean, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

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
