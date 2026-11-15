// The operations script: how the operator enforces the acceptable-use terms, without an admin UI.
// It writes rows as the app role (DATABASE_URL), like the service does; nothing is updated or
// deleted.
//
//   node scripts/ops.ts revoke-tokens <account>
//   node scripts/ops.ts suspend <account> --reason "<why>"
//   node scripts/ops.ts unsuspend <account> --reason "<why>"
//
// <account> is a GitHub numeric id, or a login as Testnotary last saw it. A mismatch alone is never
// grounds for either action (the terms).
import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { revokeAccountTokens, setSuspension } from "../src/server/accounts.ts";
import { accountLogins, accounts } from "../src/db/schema.ts";
import * as schema from "../src/db/schema.ts";

const USAGE = `usage: node scripts/ops.ts <command> <account> [--reason "<why>"]
  revoke-tokens <account>               revoke every live token of the account
  suspend <account> --reason "<why>"    suspend the account and revoke its tokens
  unsuspend <account> --reason "<why>"  lift a suspension
<account>: a GitHub numeric id, or a login. Connects with DATABASE_URL (the app role).
`;

function usage(message?: string): never {
  if (message) process.stderr.write(`ops: ${message}\n`);
  process.stderr.write(USAGE);
  process.exit(2);
}

function fail(message: string): never {
  process.stderr.write(`ops: ${message}\n`);
  process.exit(1);
}

const [command, who, ...rest] = process.argv.slice(2);
if (!command || !["revoke-tokens", "suspend", "unsuspend"].includes(command)) usage(command ? `unknown command ${command}` : undefined);
if (!who) usage("name the account");
let reason: string | undefined;
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--reason" && rest[i + 1]?.trim()) reason = rest[++i]!.trim();
  else usage(`unexpected argument ${rest[i]}`);
}
if (command !== "revoke-tokens" && !reason) usage(`${command} needs --reason`);
const url = process.env.DATABASE_URL;
if (!url) usage("DATABASE_URL is not set (the app role's connection string)");

const sql = postgres(url, { max: 1, connect_timeout: 5, onnotice: () => {} });
const db = drizzle(sql, { schema });

/** The account by GitHub id, or the one whose latest cached login is `who`. */
async function findAccount(): Promise<{ id: number; login: string | undefined }> {
  const latestLogin = async (id: number) =>
    (await db.select({ login: accountLogins.login }).from(accountLogins).where(eq(accountLogins.accountId, id)).orderBy(desc(accountLogins.id)).limit(1))[0]?.login;
  if (/^\d+$/.test(who!)) {
    const id = Number(who);
    const [row] = await db.select({ id: accounts.githubId }).from(accounts).where(eq(accounts.githubId, id));
    if (!row) fail(`no account with the GitHub id ${who}`);
    return { id, login: await latestLogin(id) };
  }
  const login = who!.replace(/^@/, "");
  const candidates = await db.selectDistinct({ id: accountLogins.accountId }).from(accountLogins).where(eq(accountLogins.login, login));
  const current = [];
  for (const candidate of candidates) if ((await latestLogin(candidate.id)) === login) current.push(candidate.id);
  if (current.length === 0) fail(`no account with the login ${login}`);
  if (current.length > 1) fail(`several accounts were last seen as ${login}: use the GitHub id (${current.join(", ")})`);
  return { id: current[0]!, login };
}

const tokens = (count: number) => `${count} token${count === 1 ? "" : "s"}`;

try {
  const account = await findAccount();
  const name = `${account.login ? `@${account.login}` : "the account"} (GitHub id ${account.id})`;
  if (command === "revoke-tokens") {
    const revoked = await revokeAccountTokens(db, account.id, "operator");
    process.stdout.write(`revoked ${tokens(revoked)} of ${name}\n`);
  } else if (command === "suspend") {
    const { revoked } = await setSuspension(db, account.id, "suspended", reason!);
    process.stdout.write(`suspended ${name} and revoked ${tokens(revoked)}\n`);
  } else {
    await setSuspension(db, account.id, "lifted", reason!);
    process.stdout.write(`lifted the suspension of ${name}\n`);
  }
} catch (error) {
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  fail(cause instanceof Error ? cause.message : String(cause));
} finally {
  await sql.end({ timeout: 1 });
}
