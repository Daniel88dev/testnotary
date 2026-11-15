import { drizzle } from "drizzle-orm/postgres-js";
import { describe, expect, test } from "vitest";
import { useWorld } from "@testnotary/test-world/vitest";
import * as schema from "../src/db/schema.ts";
import { clearSpentTokenHashes } from "../src/server/revocations.ts";
import { hashToken } from "../src/server/tokens.ts";

// Revocations and blocks are append-only rows the app role writes; clearing a spent token's hash is
// a delete only the retention role can make. Once cleared, the value can never authenticate again.

const world = useWorld();

const permissionDenied = { code: "42501" };
let n = 0;

async function whoami(token: string): Promise<number> {
  return (await fetch(`${world.service.url}/api/v1/whoami`, { headers: { authorization: `Bearer ${token}` } })).status;
}

/** A developer signed in on a laptop; returns the laptop token's value. */
async function laptopToken(): Promise<{ value: string; machine: Awaited<ReturnType<typeof world.machine>> }> {
  const user = world.github.addUser({ login: `hash-dev-${++n}` });
  const machine = await world.machine();
  world.github.deviceFlow.approveNext(user);
  expect((await world.runCli(["login"], { cwd: machine.home, machine })).exitCode).toBe(0);
  return { value: (await machine.keychain())[0]!.secret, machine };
}

function retention() {
  return drizzle(world.db.connect("retention"), { schema });
}

describe("clearing a spent token's hash", () => {
  test("a revoked token's hash is cleared by the retention role, and its value never authenticates again", async () => {
    const revoked = await laptopToken();
    const live = await laptopToken();
    expect((await world.runCli(["logout"], { cwd: revoked.machine.home, machine: revoked.machine })).exitCode).toBe(0);
    expect(await whoami(revoked.value)).toBe(401);

    expect(await clearSpentTokenHashes(retention(), new Date())).toBeGreaterThanOrEqual(1);

    const dump = await world.db.dump();
    expect(dump).not.toContain(hashToken(revoked.value));
    expect(dump).toContain(hashToken(live.value));
    expect(await whoami(revoked.value)).toBe(401);
    expect(await whoami(live.value)).toBe(200);
    // The token's row and its revocation stay for history.
    expect(dump).toMatch(/token_revocations\n.*"reason":"logout"/);
  });

  test("an expired sandbox token's hash is cleared too", async () => {
    const owner = `hash-org-${++n}`;
    const repo = await world.hostOnGitHub(await world.fixtureRepo(), { owner, name: "api" });
    await world.github.installApp({ account: { login: owner, type: "Organization" }, repos: [repo] });
    const creator = world.github.addUser({ login: `hash-creator-${n}` });
    world.github.setPermission(repo, creator, "write");
    world.clock.set(new Date(Date.now() - 2 * 86_400_000));
    let value: string;
    try {
      value = await world.sandboxToken({ creator, repo, days: 1 });
    } finally {
      world.clock.reset();
    }

    await clearSpentTokenHashes(retention(), new Date());

    expect(await world.db.dump()).not.toContain(hashToken(value));
    expect(await whoami(value)).toBe(401);
  });

  test("the app role can neither clear a hash nor take back a revocation or a block", async () => {
    const app = world.db.connect("app");

    await expect(app`delete from token_secrets`).rejects.toMatchObject(permissionDenied);
    await expect(app`delete from token_revocations`).rejects.toMatchObject(permissionDenied);
    await expect(app`delete from token_blocks`).rejects.toMatchObject(permissionDenied);
    await expect(app`update token_blocks set note = 'x'`).rejects.toMatchObject(permissionDenied);
  });
});
