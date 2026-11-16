import { describe, expect, test } from "vitest";
import { useWorld } from "@testnotary/test-world/vitest";
import { daysAgo, daysOn, histories } from "./support/history.ts";

// The retention job, as its schedule runs it: under the retention role, at the service clock's
// time. Runs, attestations, verifications and job reports go at 90 days; mismatches stay while the
// repo is installed; spent tokens go 90 days on when nothing kept points at them; a deleted
// account's login goes at once and its row once nothing names it. What it leaves is read back the
// way clients meet it (the API), and what it removes is looked for in every table.

const world = useWorld();
const { history, api, at, table } = histories(world, "keep");

describe("the 90-day prune", () => {
  test("deletes runs, attestations, verifications and job reports older than 90 days, and keeps younger ones", async () => {
    const h = await history();
    const oldPull = await h.pull();
    const old = await at(daysAgo(91), async () => {
      const attested = await h.attest(oldPull);
      const verification = await h.verify(oldPull);
      expect(verification.result).toBe("would_skip");
      await h.report(oldPull, verification.id, "passed");
      return { ...attested, verification: verification.id };
    });
    const recentPull = await h.pull();
    const recent = await at(daysAgo(89), async () => {
      const attested = await h.attest(recentPull);
      const verification = await h.verify(recentPull);
      await h.report(recentPull, verification.id, "passed");
      return { ...attested, verification: verification.id };
    });

    await world.runRetentionJob();

    expect(await h.readRun(old.runId)).toBe(404);
    expect(await h.readVerification(oldPull, old.verification)).toBe(404);
    expect(await h.readRun(recent.runId)).toBe(200);
    expect(await h.readVerification(recentPull, recent.verification)).toBe(200);
    const dump = await world.db.dump();
    for (const id of [old.runId, old.attestationId, old.verification]) expect(dump).not.toContain(id);
    expect(dump).not.toContain(oldPull.tree);
    for (const id of [recent.runId, recent.attestationId, recent.verification]) expect(dump).toContain(id);
  });
});

describe("a deleted account", () => {
  test("loses its login at the next pass, and its row once nothing names it", async () => {
    const h = await history();
    const pull = await h.pull();
    await h.attest(pull);
    await world.deleteAccount(h.user);
    const login = `"login":"${h.user.login}"`;
    const row = `"github_id":"${h.user.id}"`;

    await world.runRetentionJob();
    expect(await table("account_logins")).not.toContain(login);
    expect(await table("accounts")).toContain(row);

    await world.runRetentionJob({ at: daysOn(91) });
    expect(await table("accounts")).not.toContain(row);
    expect(await table("account_deletions")).not.toContain(`"account_id":"${h.user.id}"`);
    expect(await table("tokens")).not.toContain(h.tokenId);
  });

  test("named by a mismatch, keeps its row and its deletion row while the mismatch stays", async () => {
    const h = await history();
    const pull = await h.pull();
    await h.attest(pull);
    const verification = await h.verify(pull);
    const { mismatch } = await h.report(pull, verification.id, "failed");
    await world.deleteAccount(h.user);

    await world.runRetentionJob({ at: daysOn(181) });

    expect(await table("account_logins")).not.toContain(`"login":"${h.user.login}"`);
    expect(await table("accounts")).toContain(`"github_id":"${h.user.id}"`);
    expect(await table("account_deletions")).toContain(`"account_id":"${h.user.id}"`);
    expect(await table("mismatches")).toContain(mismatch!.id);
  });

  test("that signed in again keeps the login it signs in with", async () => {
    const h = await history();
    await world.deleteAccount(h.user);
    world.github.deviceFlow.approveNext(h.user);
    expect((await world.runCli(["login"], { cwd: h.machine.home, machine: h.machine })).exitCode).toBe(0);

    await world.runRetentionJob();

    const whoami = await world.runCli(["whoami", "--json"], { cwd: h.machine.home, machine: h.machine });
    expect(JSON.parse(whoami.stdout)).toMatchObject({ account: { id: h.user.id, login: h.user.login } });
  });
});

describe("tokens", () => {
  test("a token goes 90 days after its revocation when nothing kept points at it, and its hash at once", async () => {
    const h = await history();
    await h.logout();

    await world.runRetentionJob();
    expect(await table("token_secrets")).not.toContain(h.tokenId);
    expect(await table("tokens")).toContain(h.tokenId);

    await world.runRetentionJob({ at: daysOn(89) });
    expect(await table("tokens")).toContain(h.tokenId);

    await world.runRetentionJob({ at: daysOn(91) });
    expect(await table("tokens")).not.toContain(h.tokenId);
    expect(await table("token_revocations")).not.toContain(h.tokenId);
    expect(await table("token_uses")).not.toContain(h.tokenId);
  });

  test("an expired sandbox token goes 90 days after its expiry", async () => {
    const h = await history();
    const value = await world.sandboxToken({ creator: h.user, repo: h.repo, name: "short-lived", days: 1 });
    const sandbox = (await api("POST", "/preflight", value, { repository: h.repo.fullName })).body as { token: { id: string } };

    await world.runRetentionJob({ at: daysOn(90) });
    expect(await table("tokens")).toContain(sandbox.token.id);

    await world.runRetentionJob({ at: daysOn(92) });
    expect(await table("tokens")).not.toContain(sandbox.token.id);
  });

  test("a revoked token a mismatch names stays, with the mismatch, after its runs are pruned", async () => {
    const h = await history();
    const pull = await h.pull();
    const { runId } = await h.attest(pull);
    const verification = await h.verify(pull);
    const { mismatch } = await h.report(pull, verification.id, "failed");
    expect(mismatch).not.toBeNull();
    await h.logout();

    await world.runRetentionJob({ at: daysOn(181) });

    expect(await table("runs")).not.toContain(runId);
    expect(await table("verifications")).not.toContain(verification.id);
    expect(await table("mismatches")).toContain(mismatch!.id);
    expect(await table("tokens")).toContain(h.tokenId);
  });
});
