import { describe, expect, test } from "vitest";
import { useWorld } from "@testnotary/test-world/vitest";
import { daysOn, histories, type History } from "./support/history.ts";

// A repo leaving Testnotary from the App's webhooks: uninstalled, removed from the installation,
// deleted or transferred. It stops at once, its sandbox tokens are revoked, and the retention job
// deletes its data 30 days after it left; a reinstall before then brings the history back, in
// shadow mode. CI meets it through the API, the developer through their laptop token.

const world = useWorld();
const { history, api, at, table } = histories(world, "leave");

async function whoami(token: string): Promise<number> {
  return (await api("GET", "/whoami", token)).status;
}

/** Each way a repo leaves, as GitHub tells the App. */
const LEAVE: Record<string, (h: History) => Promise<unknown>> = {
  uninstalled: (h) => world.github.uninstallApp(h.installation),
  removed: (h) => world.github.removeInstallationRepos(h.installation, [h.repo]),
  deleted: (h) => world.github.repositoryEvent(h.installation, h.repo, { action: "deleted" }),
  transferred: (h) => world.github.repositoryEvent(h.installation, h.repo, { action: "transferred", owner: `${h.repo.owner}-new` }),
};

async function reinstall(h: History): Promise<{ repos: { id: number; mode: string }[] }> {
  const { delivery } = await world.github.installApp({ account: { login: h.repo.owner, type: "Organization" }, repos: [h.repo] });
  return delivery.body as { repos: { id: number; mode: string }[] };
}

describe("a repo that leaves", () => {
  test("uninstalling stops verification at once (repo_not_installed) and revokes the repo's sandbox tokens", async () => {
    const h = await history();
    const sandbox = await world.sandboxToken({ creator: h.user, repo: h.repo, name: "agent" });
    const pull = await h.pull();
    await h.attest(pull);
    expect((await h.verify(pull)).result).toBe("would_skip");
    expect(await whoami(sandbox)).toBe(200);

    await world.github.uninstallApp(h.installation);

    expect(await h.ask(pull)).toEqual({ status: 404, body: { error: "repo_not_installed" } });
    expect(await whoami(sandbox)).toBe(401);
  });

  test("a reinstall 29 days after an uninstall brings the history back, in shadow mode", async () => {
    const h = await history();
    expect(await world.changeRepoSettings({ admin: h.user, repo: h.repo, mode: "enforce" })).toMatchObject({ ok: true });
    const pull = await h.pull();
    const { runId } = await h.attest(pull);
    await world.audits.forbid(h.repo);
    const verification = await h.verify(pull);
    expect(verification.result).toBe("skip");
    await world.github.uninstallApp(h.installation);

    const reply = await at(daysOn(29), async () => {
      await world.runRetentionJob();
      return reinstall(h);
    });

    expect(reply.repos).toEqual([expect.objectContaining({ id: h.repo.id, mode: "shadow" })]);
    await at(daysOn(29), async () => {
      expect(await h.readRun(runId)).toBe(200);
      expect(await h.readVerification(pull, verification.id)).toBe(200);
      // CI compares again but no longer skips: shadow mode.
      const next = await h.pull();
      await h.attest(next);
      expect((await h.verify(next)).result).toBe("would_skip");
    });
  });

  test.each(Object.keys(LEAVE))("%s: its data is deleted 30 days after it left, and a reinstall then starts afresh", async (way) => {
    const h = await history();
    const sandbox = await world.sandboxToken({ creator: h.user, repo: h.repo, name: "agent" });
    const sandboxId = ((await api("POST", "/preflight", sandbox, { repository: h.repo.fullName })).body as { token: { id: string } }).token.id;
    const pull = await h.pull();
    const { runId } = await h.attest(pull);
    const verification = await h.verify(pull);
    const { mismatch } = await h.report(pull, verification.id, "failed");
    expect(await world.explainMismatch({ admin: h.user, repo: h.repo, verification: verification.id, cause: "flaky_test", note: "timing" })).toBe(true);
    await world.audits.setKeyVersion(h.repo, 2);
    const blocker = world.github.addUser({ login: `leave-admin-${way}` });
    world.github.setPermission(h.repo, blocker, "admin");
    expect(await world.blockLaptopToken({ admin: blocker, repo: h.repo, token: h.token, note: "test" })).toBe(true);

    await LEAVE[way]!(h);

    await world.runRetentionJob({ at: daysOn(29) });
    expect(await h.readRun(runId)).toBe(200);
    expect(await table("mismatches")).toContain(mismatch!.id);

    await world.runRetentionJob({ at: daysOn(31) });
    expect(await h.readRun(runId)).toBe(404);
    const repoId = `"repo_id":"${h.repo.id}"`;
    for (const name of ["repo_states", "repo_setting_changes", "audit_key_versions", "token_blocks", "mismatches", "runs", "attestations", "verifications"]) {
      expect(await table(name)).not.toContain(repoId);
    }
    expect(await table("repos")).not.toContain(`"github_id":"${h.repo.id}"`);
    expect(await table("mismatch_explanations")).not.toContain(mismatch!.id);
    expect(await table("tokens")).not.toContain(sandboxId);
    // The developer's own laptop token is theirs, not the repo's.
    expect(await whoami(h.token)).toBe(200);

    if (way === "uninstalled" || way === "removed") {
      const reply = await at(daysOn(31), () => reinstall(h));
      expect(reply.repos).toEqual([expect.objectContaining({ id: h.repo.id, mode: "shadow" })]);
      expect(await h.readRun(runId)).toBe(404);
    }
  });

  test("a repo that stays installed keeps its mismatches past 90 days", async () => {
    const h = await history();
    const pull = await h.pull();
    await h.attest(pull);
    const verification = await h.verify(pull);
    const { mismatch } = await h.report(pull, verification.id, "failed");

    await world.runRetentionJob({ at: daysOn(400) });

    expect(await table("mismatches")).toContain(mismatch!.id);
  });
});
