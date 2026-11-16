import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
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
const script = fileURLToPath(new URL("../scripts/retention.ts", import.meta.url));

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

  test("a laptop token in use loses its uses from before 90 days that a later one superseded, and stays live", async () => {
    const h = await history();
    for (const day of [30, 60, 100]) {
      await at(daysOn(day), async () => expect((await api("GET", "/whoami", h.token)).status).toBe(200));
    }
    const usesBefore = JSON.parse(await table("token_uses")) as { token_id: string }[];
    expect(usesBefore.filter((use) => use.token_id === h.tokenId)).toHaveLength(4);

    await world.runRetentionJob({ at: daysOn(155) });

    const usesAfter = JSON.parse(await table("token_uses")) as { token_id: string }[];
    // Day 100's use is inside the window; days 0, 30 and 60 are before it, each followed by a later use.
    expect(usesAfter.filter((use) => use.token_id === h.tokenId)).toHaveLength(1);
    await at(daysOn(155), async () => expect((await api("GET", "/whoami", h.token)).status).toBe(200));
  });
});

describe("spent Actions OIDC tokens", () => {
  test("are forgotten once expired, and replaying one is still refused", async () => {
    const h = await history();
    const pull = await h.pull();
    const oidc = await world.github.oidc.tokenFor({ repo: h.repo, sha: pull.sha, ref: "refs/pull/1/merge", eventName: "pull_request" }, "https://testnotary.dev");
    const environment = { os: "Linux", arch: "X64", image: "ubuntu24", imageVersion: "20261110.1", node: "v24.11.0" };
    expect((await api("POST", "/verifications", oidc, { suite: "test", environment })).status).toBe(200);
    const jti = (JSON.parse(Buffer.from(oidc.split(".")[1]!, "base64url").toString("utf8")) as { jti: string }).jti;
    expect(await table("oidc_token_uses")).toContain(jti);

    await world.runRetentionJob({ at: daysOn(2) });

    expect(await table("oidc_token_uses")).not.toContain(jti);
    await at(daysOn(2), async () => expect((await api("POST", "/verifications", oidc, { suite: "test", environment })).status).toBe(401));
  });
});

describe("webhook deliveries and ended sessions", () => {
  test("a delivery goes 30 days after it arrived, and an ended session once it could no longer be valid", async () => {
    const h = await history();
    // The installation's webhook (its id stays on the repo's recorded states), and a session
    // ended by Delete account.
    await world.deleteAccount(h.user);
    const session = /world-[0-9a-f]{16}/.exec(await world.db.dump())![0];

    // A session lasts 8 hours; its end is kept a day beyond that. Deliveries stay longer.
    const soon = await world.runRetentionJob({ at: daysOn(2) });
    expect(soon.sessionEnds).toBeGreaterThanOrEqual(1);
    expect(soon.webhookDeliveries).toBe(0);
    expect(await world.db.dump()).not.toContain(session);

    // GitHub redelivers for 3 days at most; 30 days on, the delivery ids are no longer needed.
    const later = await world.runRetentionJob({ at: daysOn(31) });
    expect(later.webhookDeliveries).toBeGreaterThanOrEqual(1);
  });
});

describe("the scheduled job's entry point", () => {
  function job(databaseUrl: string | undefined): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", script], {
        env: { PATH: process.env.PATH, ...(databaseUrl ? { RETENTION_DATABASE_URL: databaseUrl } : {}) },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  }

  test("only the retention role can run it: as the app role it fails and deletes nothing", async () => {
    const h = await history();
    await h.logout();

    const refused = await job(world.db.urls.app);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/permission denied/);
    expect(await table("token_secrets")).toContain(h.tokenId);

    const ran = await job(world.db.urls.retention);
    expect(ran).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(ran.stdout)).toMatchObject({ retention: "done", deleted: { tokenHashes: expect.any(Number) as number } });
    expect(await table("token_secrets")).not.toContain(h.tokenId);
  });

  test("without RETENTION_DATABASE_URL it says so and exits 2", async () => {
    expect(await job(undefined)).toMatchObject({ code: 2, stderr: expect.stringContaining("RETENTION_DATABASE_URL") as string });
  });
});
