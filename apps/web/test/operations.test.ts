import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { FakeAccount, Machine } from "@testnotary/test-world";
import { useWorld } from "@testnotary/test-world/vitest";

// The operations script enforces the acceptable-use terms without an admin UI: it revokes an
// account's tokens, or suspends the account, by writing rows as the app role. Its effect is seen
// where the account meets it: the CLI.

const world = useWorld();
const script = fileURLToPath(new URL("../scripts/ops.ts", import.meta.url));
let n = 0;

function ops(args: string[], databaseUrl = world.db.urls.app): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", script, ...args], {
      env: { PATH: process.env.PATH, DATABASE_URL: databaseUrl },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** A person signed in on `machines` machines with `testnotary login`. */
async function signedIn(machines = 1): Promise<{ user: FakeAccount; machines: Machine[] }> {
  const user = world.github.addUser({ login: `member-${++n}` });
  const list: Machine[] = [];
  for (let i = 0; i < machines; i++) {
    const machine = await world.machine();
    world.github.deviceFlow.approveNext(user);
    expect((await world.runCli(["login"], { cwd: machine.home, machine })).exitCode).toBe(0);
    list.push(machine);
  }
  return { user, machines: list };
}

async function whoami(machine: Machine) {
  const result = await world.runCli(["whoami", "--json"], { cwd: machine.home, machine });
  return { exitCode: result.exitCode, body: JSON.parse(result.stdout) as Record<string, unknown> };
}

describe("revoke-tokens", () => {
  test("revokes every token of the account, named by login or by GitHub id, and leaves others alone", async () => {
    const { user, machines } = await signedIn(2);
    const other = await signedIn();

    const result = await ops(["revoke-tokens", user.login]);

    expect(result).toMatchObject({ code: 0, stdout: `revoked 2 tokens of @${user.login} (GitHub id ${user.id})\n` });
    for (const machine of machines) expect(await whoami(machine)).toEqual({ exitCode: 1, body: expect.objectContaining({ error: "token_rejected" }) });
    expect((await whoami(other.machines[0]!)).exitCode).toBe(0);

    // Signing in again works: revoking tokens is not a suspension. By id, the new token goes too.
    world.github.deviceFlow.approveNext(user);
    expect((await world.runCli(["login"], { cwd: machines[0]!.home, machine: machines[0]! })).exitCode).toBe(0);
    expect(await ops(["revoke-tokens", String(user.id)])).toMatchObject({ code: 0, stdout: `revoked 1 token of @${user.login} (GitHub id ${user.id})\n` });
    expect((await whoami(machines[0]!)).exitCode).toBe(1);
  });

  test("an account Testnotary has never seen is an error, and nothing is written", async () => {
    expect(await ops(["revoke-tokens", "nobody-here"])).toMatchObject({ code: 1, stderr: "ops: no account with the login nobody-here\n" });
    expect(await ops(["revoke-tokens"])).toMatchObject({ code: 2 });
  });
});

describe("suspend", () => {
  test("revokes the account's tokens and refuses it a new one until the suspension is lifted", async () => {
    const { user, machines } = await signedIn();
    const machine = machines[0]!;

    expect(await ops(["suspend", user.login])).toMatchObject({ code: 2 });
    const suspended = await ops(["suspend", user.login, "--reason", "flooded the API"]);
    expect(suspended).toMatchObject({ code: 0, stdout: `suspended @${user.login} (GitHub id ${user.id}) and revoked 1 token\n` });
    expect((await whoami(machine)).exitCode).toBe(1);

    world.github.deviceFlow.approveNext(user);
    const refused = await world.runCli(["login", "--json"], { cwd: machine.home, machine });
    expect(refused.exitCode).toBe(1);
    expect(JSON.parse(refused.stdout)).toMatchObject({ error: "account_suspended" });

    expect(await ops(["unsuspend", user.login, "--reason", "talked it through"])).toMatchObject({
      code: 0,
      stdout: `lifted the suspension of @${user.login} (GitHub id ${user.id})\n`,
    });
    world.github.deviceFlow.approveNext(user);
    expect((await world.runCli(["login"], { cwd: machine.home, machine })).exitCode).toBe(0);
    expect((await whoami(machine)).exitCode).toBe(0);
  });
});
